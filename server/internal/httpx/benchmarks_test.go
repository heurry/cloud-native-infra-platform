package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPctile(t *testing.T) {
	if got := pctile([]float64{10, 20, 30, 40}, 50); got != 25.0 {
		t.Fatalf("p50 = %v, want 25", got)
	}
	if got := pctile(nil, 95); got != nil {
		t.Fatalf("empty pctile should be nil, got %v", got)
	}
	if got := pctile([]float64{7}, 99); got != 7.0 {
		t.Fatalf("single pctile = %v, want 7", got)
	}
}

// 集成测试：需 TEST_DATABASE_URL。POST serving → 后台 runner 打 mock SSE 上游 → 轮询至 completed，
// 校验 scenario_summary / request 事件与 GET run 契约。
func TestBenchmarksServing(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run benchmarks integration test")
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
	a := &API{Pool: pool}

	// mock vLLM：SSE 两个 content delta + 一个带 usage 的块 + [DONE]。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.Error(w, "bad path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"re\"}}]}\n\n")
		if fl != nil {
			fl.Flush()
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"fund\"}}],\"usage\":{\"prompt_tokens\":6,\"completion_tokens\":2}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	if _, err := pool.Exec(ctx,
		`INSERT INTO service_instances (name, base_url, model_id, kind, routing_role, status)
		 VALUES ('bench-mock', $1, 'qwen3-4b-platform', 'vllm', 'replica', 'healthy')
		 ON CONFLICT (name) DO UPDATE SET base_url = EXCLUDED.base_url, status='healthy'`,
		upstream.URL+"/v1"); err != nil {
		t.Fatalf("insert mock instance: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM service_instances WHERE name='bench-mock'`)

	rt := chi.NewRouter()
	rt.Post("/api/benchmarks/serving", a.createServingBenchmark)
	rt.Get("/api/benchmarks/{run_id}", a.benchmarkRun)
	rt.Get("/api/benchmarks/{run_id}/events", a.benchmarkEvents)

	// POST serving（小负载：1 档并发 2，4 个请求）。
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/benchmarks/serving",
		strings.NewReader(`{"endpoint_id":"bench-mock","concurrency_levels":[2],"requests_per_level":4,"max_tokens":8}`))
	rt.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST serving status %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		RunID  string `json:"run_id"`
		Status string `json:"status"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if created.RunID == "" || created.Status != "queued" {
		t.Fatalf("unexpected create response: %s", rec.Body.String())
	}
	defer pool.Exec(ctx, `DELETE FROM benchmark_runs WHERE run_id=$1`, created.RunID)
	defer pool.Exec(ctx, `DELETE FROM benchmark_samples WHERE run_id=$1`, created.RunID)

	// 轮询直至 completed（runner 后台 goroutine）。
	var status string
	for i := 0; i < 50; i++ {
		rr := httptest.NewRecorder()
		gr := httptest.NewRequest(http.MethodGet, "/api/benchmarks/"+created.RunID, nil)
		rt.ServeHTTP(rr, gr)
		var run struct {
			Status  string         `json:"status"`
			Summary map[string]any `json:"summary"`
		}
		_ = json.Unmarshal(rr.Body.Bytes(), &run)
		status = run.Status
		if status == "completed" {
			if scen, ok := run.Summary["scenarios"].([]any); !ok || len(scen) != 1 {
				t.Fatalf("expected 1 scenario in summary, got %v", run.Summary["scenarios"])
			}
			break
		}
		if status == "failed" {
			t.Fatalf("benchmark failed unexpectedly")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if status != "completed" {
		t.Fatalf("benchmark did not complete, last status=%q", status)
	}

	// events：应含 4 个 request 与 1 个 scenario_summary。
	er := httptest.NewRecorder()
	rt.ServeHTTP(er, httptest.NewRequest(http.MethodGet, "/api/benchmarks/"+created.RunID+"/events", nil))
	var evbody struct {
		Events []struct {
			EventType string         `json:"event_type"`
			Payload   map[string]any `json:"payload"`
		} `json:"events"`
	}
	_ = json.Unmarshal(er.Body.Bytes(), &evbody)
	reqEvents, summaries := 0, 0
	for _, e := range evbody.Events {
		switch e.EventType {
		case "request":
			reqEvents++
		case "scenario_summary":
			summaries++
		}
	}
	if reqEvents != 4 {
		t.Fatalf("expected 4 request events, got %d", reqEvents)
	}
	if summaries != 1 {
		t.Fatalf("expected 1 scenario_summary, got %d", summaries)
	}
}
