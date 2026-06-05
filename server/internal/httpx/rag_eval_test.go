package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRerankByFeedback：反馈净分温和上浮——能翻转相近分差，但不喧宾夺主翻转大分差。
func TestRerankByFeedback(t *testing.T) {
	// 相近分差：被踩的高分文档应落到被赞的次高分文档之后。
	docs := []store.DocHit{
		{DocID: "a", Score: 0.75},
		{DocID: "b", Score: 0.73},
	}
	rerankByFeedback(docs, map[string]int{"a": -3, "b": 4})
	if docs[0].DocID != "b" {
		t.Fatalf("expected upvoted 'b' to rank first, got %s", docs[0].DocID)
	}

	// 大分差：权重温和，不应翻转。
	big := []store.DocHit{
		{DocID: "c", Score: 0.95},
		{DocID: "d", Score: 0.60},
	}
	rerankByFeedback(big, map[string]int{"c": 0, "d": 10})
	if big[0].DocID != "c" {
		t.Fatalf("modest weight should not flip a large score gap, got %s first", big[0].DocID)
	}
}

// TestFeedbackReflow：DB 集成——反馈回流出评测数据集 + 重排信号；eval 无可用样本时 400。
// 需 TEST_DATABASE_URL（pgvector:pg16）。
func TestFeedbackReflow(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run feedback reflow integration test")
	}
	ctx := context.Background()
	if err := db.Migrate(config.Config{DatabaseURL: url}.MigrateURL()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	a := &API{Pool: pool, Store: store.New(pool)}

	// 造数据：一个会话，一问一答（答带 citation_doc_ids），一条 👍 反馈。
	sessionID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO chat_sessions (session_id, title) VALUES ($1, 'reflow-test')`, sessionID); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM chat_sessions WHERE session_id=$1`, sessionID)

	userID := uuid.NewString()
	asstID := uuid.NewString()
	if _, err := pool.Exec(ctx,
		`INSERT INTO chat_messages (message_id, session_id, role, content, created_at)
		 VALUES ($1,$2,'user','如何申请退款？', now() - interval '2 seconds')`, userID, sessionID); err != nil {
		t.Fatalf("insert user msg: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO chat_messages (message_id, session_id, role, content, metadata, created_at)
		 VALUES ($1,$2,'assistant','退款流程如下…', $3::jsonb, now() - interval '1 second')`,
		asstID, sessionID, `{"citation_doc_ids":["doc-refund","doc-policy"]}`); err != nil {
		t.Fatalf("insert assistant msg: %v", err)
	}
	if _, err := a.Store.CreateMessageFeedback(ctx, asstID, sessionID, "", "up", "解决了"); err != nil {
		t.Fatalf("create feedback: %v", err)
	}

	// --- FeedbackDataset：问题取前一条用户消息、gold 取被引文档 ---
	samples, err := a.Store.FeedbackDataset(ctx, 50)
	if err != nil {
		t.Fatalf("FeedbackDataset: %v", err)
	}
	var found *store.FeedbackSample
	for i := range samples {
		if samples[i].MessageID == asstID {
			found = &samples[i]
		}
	}
	if found == nil {
		t.Fatal("reflowed sample not found")
	}
	if found.Question != "如何申请退款？" {
		t.Fatalf("question not derived from preceding user msg: %q", found.Question)
	}
	if len(found.GoldDocIDs) != 2 || found.GoldDocIDs[0] != "doc-refund" {
		t.Fatalf("gold doc ids wrong: %v", found.GoldDocIDs)
	}
	if !found.Usable() {
		t.Fatal("up-rated sample with question + gold should be usable")
	}

	// --- DocFeedbackSignal：被引文档各 +1 赞 ---
	sig, err := a.Store.DocFeedbackSignal(ctx)
	if err != nil {
		t.Fatalf("DocFeedbackSignal: %v", err)
	}
	byDoc := map[string]store.DocSignal{}
	for _, d := range sig {
		byDoc[d.DocID] = d
	}
	if byDoc["doc-refund"].Up != 1 || byDoc["doc-refund"].Net != 1 {
		t.Fatalf("doc-refund signal wrong: %+v", byDoc["doc-refund"])
	}

	// --- 处理器：GET /api/rag/dataset ---
	rt := chi.NewRouter()
	rt.Get("/api/rag/dataset", a.ragDataset)
	rt.Get("/api/rag/signal", a.ragSignal)
	rec := do(rt, http.MethodGet, "/api/rag/dataset", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("ragDataset status %d", rec.Code)
	}
	var ds struct {
		Summary store.FeedbackSummary `json:"summary"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ds)
	if ds.Summary.UsableSamples < 1 || ds.Summary.Up < 1 {
		t.Fatalf("summary wrong: %+v", ds.Summary)
	}

	srec := do(rt, http.MethodGet, "/api/rag/signal", "")
	if srec.Code != http.StatusOK {
		t.Fatalf("ragSignal status %d", srec.Code)
	}

	// --- eval 无可用样本：删反馈后应 400（不触达 embed）---
	_, _ = pool.Exec(ctx, `DELETE FROM chat_message_feedback WHERE message_id=$1`, asstID)
	rt2 := chi.NewRouter()
	rt2.Post("/api/rag/eval", a.runRagEval)
	erec := do(rt2, http.MethodPost, "/api/rag/eval", "{}")
	if erec.Code != http.StatusBadRequest {
		t.Fatalf("eval with no usable samples should 400, got %d body=%s", erec.Code, erec.Body.String())
	}
}
