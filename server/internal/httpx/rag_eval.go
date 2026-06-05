package httpx

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
)

// E2：RAG 评测体系 + 在线反馈回流。
//   - GET  /api/rag/dataset       —— 反馈回流出的检索评测数据集（👍 回答 → 问题 + gold 文档）+ 概览。
//   - GET  /api/rag/signal        —— 反馈重排信号（被引文档的赞/踩净分）+ 在线重排是否开启。
//   - POST /api/rag/eval          —— 对回流数据集跑离线检索召回评测（接 B2 recall@k），落基线 eval_run。
//   - GET  /api/rag/eval/history  —— 回流数据集的评测基线历史（recall@k 随时间）。
// 离线评测刻意用「原始检索」（不加反馈重排），避免「赞过的文档被加权 → recall 虚高」的数据泄漏；
// 反馈重排是另一条「在线」机制（opt-in `RAG_RERANK_FEEDBACK`），见 retrieveDocs。

const ragFeedbackDataset = "rag-feedback-reflow"

// GET /api/rag/dataset
func (a *API) ragDataset(w http.ResponseWriter, r *http.Request) {
	samples, err := a.Store.FeedbackDataset(r.Context(), queryInt(r, "limit", 200))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	sum := store.FeedbackSummary{TotalFeedback: len(samples)}
	for _, s := range samples {
		if s.Rating == "up" {
			sum.Up++
		} else {
			sum.Down++
		}
		if s.Usable() {
			sum.UsableSamples++
		}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"summary": sum, "samples": samples})
}

// GET /api/rag/signal
func (a *API) ragSignal(w http.ResponseWriter, r *http.Request) {
	docs, err := a.Store.DocFeedbackSignal(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"docs": docs, "rerank_enabled": a.RAGRerankFeedback})
}

// POST /api/rag/eval —— 对回流数据集跑检索召回评测并落基线。
func (a *API) runRagEval(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	all, err := a.Store.FeedbackDataset(ctx, 500)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	usable := make([]store.FeedbackSample, 0, len(all))
	for _, s := range all {
		if s.Usable() {
			usable = append(usable, s)
		}
	}
	if len(usable) == 0 {
		a.badRequest(w, r, "无可评测样本：需要先在智能客服里对回答点「有帮助」（👍）以回流 gold 标注")
		return
	}

	total, h1, h3, h5 := 0, 0, 0, 0
	detail := make([]map[string]any, 0, len(usable))
	for _, s := range usable {
		vecs, err := a.AI.Embed(ctx, []string{s.Question}, true)
		if err != nil || len(vecs) == 0 {
			WriteError(w, r, http.StatusBadGateway, "ai_unavailable", "query embed failed")
			return
		}
		// 原始检索（不加反馈重排）——诚实基线，规避数据泄漏。
		hits, err := a.Store.SearchDocuments(ctx, vecs[0], "", 5)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		ids := make([]string, len(hits))
		for i, h := range hits {
			ids[i] = h.DocID
		}
		gold := make(map[string]bool, len(s.GoldDocIDs))
		for _, id := range s.GoldDocIDs {
			gold[id] = true
		}
		total++
		hit1, hit3, hit5 := hitAtK(gold, ids, 1), hitAtK(gold, ids, 3), hitAtK(gold, ids, 5)
		if hit1 {
			h1++
		}
		if hit3 {
			h3++
		}
		if hit5 {
			h5++
		}
		detail = append(detail, map[string]any{
			"message_id": s.MessageID, "question": s.Question,
			"gold_doc_ids": s.GoldDocIDs, "retrieved_doc_ids": ids,
			"hit_at_1": hit1, "hit_at_3": hit3, "hit_at_5": hit5,
		})
	}

	metrics := map[string]any{
		"num_samples":           total,
		"retrieval_recall_at_1": ratio(h1, total),
		"retrieval_recall_at_3": ratio(h3, total),
		"retrieval_recall_at_5": ratio(h5, total),
		"source":                "feedback_reflow",
	}
	runID := uuid.NewString()
	mb, _ := json.Marshal(metrics)
	if _, err := a.Pool.Exec(ctx,
		`INSERT INTO eval_runs (run_id, dataset, status, metrics) VALUES ($1, $2, 'completed', $3)`,
		runID, ragFeedbackDataset, mb); err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(ctx, a.actor(r, ""), "operator", "rag.eval", "eval_run", runID,
		map[string]any{"dataset": ragFeedbackDataset, "num_samples": total})
	WriteJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "status": "completed", "metrics": metrics, "samples": detail,
	})
}

// GET /api/rag/eval/history —— 回流数据集的评测基线历史。
func (a *API) ragEvalHistory(w http.ResponseWriter, r *http.Request) {
	limit := clamp(queryInt(r, "limit", 20), 1, 100)
	rows, err := a.Pool.Query(r.Context(),
		`SELECT run_id, status, metrics, created_at FROM eval_runs
		   WHERE dataset = $1 ORDER BY created_at DESC LIMIT $2`, ragFeedbackDataset, limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer rows.Close()
	runs := []map[string]any{}
	for rows.Next() {
		var runID, status string
		var metrics []byte
		var createdAt time.Time
		if err := rows.Scan(&runID, &status, &metrics, &createdAt); err != nil {
			a.fail(w, r, err)
			return
		}
		runs = append(runs, map[string]any{
			"run_id": runID, "status": status, "metrics": jsonbObject(metrics),
			"created_at": createdAt.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"dataset": ragFeedbackDataset, "runs": runs})
}

// ===== 在线反馈重排（opt-in）=====

// retrieveDocs 是 chat 检索入口：默认等价 SearchDocuments(topK)；开启 RAG_RERANK_FEEDBACK 时
// 取更宽候选池后按反馈净分微调排序再截断（命中过的好文档轻微上浮）。
func (a *API) retrieveDocs(ctx context.Context, vec []float32, topK int) ([]store.DocHit, bool, error) {
	if !a.RAGRerankFeedback {
		hits, err := a.Store.SearchDocuments(ctx, vec, "", topK)
		return hits, false, err
	}
	cand, err := a.Store.SearchDocuments(ctx, vec, "", topK*3)
	if err != nil || len(cand) == 0 {
		return cand, false, err
	}
	signal, err := a.Store.FeedbackSignalMap(ctx)
	if err != nil || len(signal) == 0 {
		// 信号不可用 → 退回原始排序的前 topK（不影响对话）。
		if len(cand) > topK {
			cand = cand[:topK]
		}
		return cand, false, nil
	}
	rerankByFeedback(cand, signal)
	if len(cand) > topK {
		cand = cand[:topK]
	}
	return cand, true, nil
}

// rerankByFeedback 以「向量分 + 反馈净分加权」稳定重排（净分经 tanh 限幅，权重温和，不喧宾夺主）。
func rerankByFeedback(docs []store.DocHit, signal map[string]int) {
	const w = 0.1
	boost := func(d store.DocHit) float64 {
		return d.Score + w*math.Tanh(float64(signal[d.DocID])/2.0)
	}
	sort.SliceStable(docs, func(i, j int) bool {
		return boost(docs[i]) > boost(docs[j])
	})
}
