package httpx

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// 6A：evals 组绞杀——Go 原生检索召回评测（复刻 legacy /api/evals 契约）。
// POST /api/evals/customer-support：对每个 QA 样本嵌入问题 → pgvector 文档级检索 →
// recall@1/3/5 对比 gold doc_ids；落 PG eval_runs（000001，SQLite 超集）。
// GET /api/evals/{run_id} 读回。检索语料 = knowledge 刀灌入的 kb_*（基准测试日志，方案 A）。

// POST /api/evals/customer-support
func (a *API) createCustomerSupportEval(w http.ResponseWriter, r *http.Request) {
	var req struct {
		QASamples []struct {
			Question string   `json:"question"`
			DocIDs   []string `json:"doc_ids"`
		} `json:"qa_samples"`
		TopK int `json:"top_k"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.badRequest(w, r, "invalid JSON body")
		return
	}
	if req.TopK <= 0 {
		req.TopK = 3
	}
	k := req.TopK
	if k < 5 { // 复刻 legacy：检索取 max(5, top_k) 以便算 recall@5
		k = 5
	}

	ctx := r.Context()
	total, h1, h3, h5 := 0, 0, 0, 0
	for _, s := range req.QASamples {
		if s.Question == "" || len(s.DocIDs) == 0 {
			continue
		}
		gold := make(map[string]bool, len(s.DocIDs))
		for _, id := range s.DocIDs {
			gold[id] = true
		}
		vecs, err := a.AI.Embed(ctx, []string{s.Question}, true)
		if err != nil || len(vecs) == 0 {
			WriteError(w, r, http.StatusBadGateway, "ai_unavailable", "query embed failed")
			return
		}
		hits, err := a.Store.SearchDocuments(ctx, vecs[0], "", k)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		ids := make([]string, len(hits))
		for i, h := range hits {
			ids[i] = h.DocID
		}
		total++
		if hitAtK(gold, ids, 1) {
			h1++
		}
		if hitAtK(gold, ids, 3) {
			h3++
		}
		if hitAtK(gold, ids, 5) {
			h5++
		}
	}

	metrics := map[string]any{
		"num_samples":           total,
		"retrieval_recall_at_1": ratio(h1, total),
		"retrieval_recall_at_3": ratio(h3, total),
		"retrieval_recall_at_5": ratio(h5, total),
	}
	runID := uuid.NewString()
	mb, _ := json.Marshal(metrics)
	if _, err := a.Pool.Exec(ctx,
		`INSERT INTO eval_runs (run_id, status, metrics) VALUES ($1, 'completed', $2)`, runID, mb); err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"run_id": runID, "status": "completed", "metrics": metrics})
}

// GET /api/evals/{run_id}
func (a *API) evalRun(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "run_id")
	var status string
	var modelID, dataset *string
	var metrics []byte
	var createdAt, updatedAt time.Time
	err := a.Pool.QueryRow(r.Context(),
		`SELECT status, model_id, dataset, metrics, created_at, updated_at FROM eval_runs WHERE run_id = $1`, runID).
		Scan(&status, &modelID, &dataset, &metrics, &createdAt, &updatedAt)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "eval run not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "status": status, "model_id": modelID, "dataset": dataset,
		"metrics":    jsonbObject(metrics),
		"created_at": createdAt.UTC().Format(time.RFC3339Nano),
		"updated_at": updatedAt.UTC().Format(time.RFC3339Nano),
	})
}

// hitAtK 判定 gold 是否命中检索结果前 k 个。
func hitAtK(gold map[string]bool, ids []string, k int) bool {
	for i := 0; i < k && i < len(ids); i++ {
		if gold[ids[i]] {
			return true
		}
	}
	return false
}
