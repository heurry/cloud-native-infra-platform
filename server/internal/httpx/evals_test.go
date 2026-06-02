package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/aiclient"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 集成测试：需带 pgvector 的 PG（TEST_DATABASE_URL）。灌入一篇 kb 文档，POST eval 的 gold=该文档，
// 校验 recall@1=1 + 落库 + GET 读回。复用 knowledge_handlers_test.go 的 mockEmbedVec。
func TestEvalsRecall(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL (pgvector) to run evals test")
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

	embedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Texts []string `json:"texts"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		embs := make([][]float32, len(req.Texts))
		for i, tx := range req.Texts {
			embs[i] = mockEmbedVec(tx)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"embeddings": embs, "dim": 1024, "mode": "stub"})
	}))
	defer embedSrv.Close()

	a := &API{Pool: pool, Store: store.New(pool), AI: aiclient.New(embedSrv.URL, 10*time.Second)}

	// 灌入一篇文档 + 嵌入切块。
	if err := a.Store.UpsertDocument(ctx, store.Document{
		DocID: "ev-doc-1", Title: "P95 latency note", Content: "p95 latency", Category: "benchmark", Version: "default",
	}); err != nil {
		t.Fatalf("upsert doc: %v", err)
	}
	if err := a.Store.ReplaceChunks(ctx, "ev-doc-1", "default",
		[]store.Chunk{{Ordinal: 0, Text: "p95 latency", Embedding: mockEmbedVec("p95 latency")}}); err != nil {
		t.Fatalf("replace chunks: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM kb_chunks WHERE doc_id='ev-doc-1'`)
	defer pool.Exec(ctx, `DELETE FROM kb_documents WHERE doc_id='ev-doc-1'`)

	rt := chi.NewRouter()
	rt.Post("/api/evals/customer-support", a.createCustomerSupportEval)
	rt.Get("/api/evals/{run_id}", a.evalRun)

	// POST eval：gold = ev-doc-1（语料里唯一文档 → recall@1 命中）。
	rec := httptest.NewRecorder()
	body := `{"qa_samples":[{"question":"what is the p95 latency","doc_ids":["ev-doc-1"]}],"top_k":3}`
	rt.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/evals/customer-support", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("eval POST status %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		RunID   string         `json:"run_id"`
		Status  string         `json:"status"`
		Metrics map[string]any `json:"metrics"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	defer pool.Exec(ctx, `DELETE FROM eval_runs WHERE run_id=$1`, res.RunID)
	if res.Status != "completed" || res.RunID == "" {
		t.Fatalf("unexpected eval response: %s", rec.Body.String())
	}
	if ns, _ := res.Metrics["num_samples"].(float64); ns != 1 {
		t.Fatalf("num_samples = %v, want 1", res.Metrics["num_samples"])
	}
	if r1, _ := res.Metrics["retrieval_recall_at_1"].(float64); r1 != 1 {
		t.Fatalf("recall@1 = %v, want 1", res.Metrics["retrieval_recall_at_1"])
	}

	// GET run 读回。
	gr := httptest.NewRecorder()
	rt.ServeHTTP(gr, httptest.NewRequest(http.MethodGet, "/api/evals/"+res.RunID, nil))
	if gr.Code != http.StatusOK || !strings.Contains(gr.Body.String(), `"status":"completed"`) {
		t.Fatalf("GET eval run unexpected: %d %s", gr.Code, gr.Body.String())
	}
}
