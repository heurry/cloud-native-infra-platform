package httpx

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestNormalizeBaseURL(t *testing.T) {
	cases := map[string]string{
		"http://h:8010/v1":  "http://h:8010/v1",
		"http://h:8010/v1/": "http://h:8010/v1",
		"http://h:8000":     "http://h:8000/v1",
		"http://h:8000/":    "http://h:8000/v1",
	}
	for in, want := range cases {
		if got := normalizeBaseURL(in); got != want {
			t.Errorf("normalizeBaseURL(%q)=%q want %q", in, got, want)
		}
	}
}

// 集成测试：需 TEST_DATABASE_URL（普通 PG 即可，本组不用 pgvector）。覆盖 models 契约、
// 选路（直连/轮转/auto 优选 aibrix/404）与一次完整反代到 mock 上游。
func TestModelsProxy(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run models/proxy integration test")
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

	// --- GET /api/models（契约：models[].model_id 去重排序 + service_instances[{name,model_id,kind,status}]）---
	rec := httptest.NewRecorder()
	a.models(rec, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("models status %d", rec.Code)
	}
	var mbody struct {
		Models           []map[string]any `json:"models"`
		ServiceInstances []map[string]any `json:"service_instances"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &mbody)
	if len(mbody.ServiceInstances) < 5 {
		t.Fatalf("expected >=5 seeded instances, got %d", len(mbody.ServiceInstances))
	}
	foundModel := false
	for _, m := range mbody.Models {
		if m["model_id"] == "qwen3-4b-platform" {
			foundModel = true
		}
	}
	if !foundModel {
		t.Fatalf("models missing qwen3-4b-platform: %+v", mbody.Models)
	}

	// --- 选路：直连 aibrix-gateway（含 routing-strategy）---
	if ep, st, err := a.resolveEndpoint(ctx, "aibrix-gateway"); err != nil || st != 200 {
		t.Fatalf("resolve aibrix-gateway: st=%d err=%v", st, err)
	} else if !strings.Contains(ep.BaseURL, ":8010") || ep.RoutingStrategy != "least-request" {
		t.Fatalf("aibrix endpoint wrong: %+v", ep)
	}

	// --- 选路：auto-router 优选 aibrix-gateway（状态可用）---
	if ep, _, err := a.resolveEndpoint(ctx, "auto-router"); err != nil || ep.TargetPod != "aibrix-gateway" {
		t.Fatalf("auto-router should pick aibrix-gateway, got %+v err=%v", ep, err)
	}

	// --- 选路：client_round_robin 轮转两副本 ---
	ep1, _, err1 := a.resolveEndpoint(ctx, "direct-round-robin")
	ep2, _, err2 := a.resolveEndpoint(ctx, "direct-round-robin")
	if err1 != nil || err2 != nil {
		t.Fatalf("round-robin resolve err: %v %v", err1, err2)
	}
	if ep1.TargetPod == ep2.TargetPod {
		t.Fatalf("round-robin should rotate, both %s", ep1.TargetPod)
	}
	for _, tp := range []string{ep1.TargetPod, ep2.TargetPod} {
		if tp != "vllm-replica-0" && tp != "vllm-replica-1" {
			t.Fatalf("unexpected round-robin target %s", tp)
		}
	}

	// --- 选路：未知端点 → 404 ---
	if _, st, err := a.resolveEndpoint(ctx, "does-not-exist"); err == nil || st != http.StatusNotFound {
		t.Fatalf("unknown endpoint should 404, got st=%d err=%v", st, err)
	}

	// --- 完整反代到 mock 上游 ---
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.Error(w, "bad path "+r.URL.Path, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"echo_model": r.Header.Get("model"),
			"ok":         true,
		})
	}))
	defer upstream.Close()
	if _, err := pool.Exec(ctx,
		`INSERT INTO service_instances (name, base_url, model_id, kind, routing_role, status)
		 VALUES ('mock-llm', $1, 'qwen3-4b-platform', 'vllm', 'replica', 'healthy')
		 ON CONFLICT (name) DO UPDATE SET base_url = EXCLUDED.base_url, status = 'healthy'`,
		upstream.URL+"/v1"); err != nil {
		t.Fatalf("insert mock instance: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM service_instances WHERE name='mock-llm'`)

	rt := chi.NewRouter()
	rt.Post("/api/proxy/{endpoint_id}/v1/chat/completions", a.proxyChatCompletions)
	body := `{"model":"qwen3-4b-platform","messages":[{"role":"user","content":"hi"}]}`
	preq := httptest.NewRequest(http.MethodPost, "/api/proxy/mock-llm/v1/chat/completions", strings.NewReader(body))
	prec := httptest.NewRecorder()
	rt.ServeHTTP(prec, preq)
	if prec.Code != http.StatusOK {
		t.Fatalf("proxy status %d body=%s", prec.Code, prec.Body.String())
	}
	if prec.Header().Get("x-target-pod") != "mock-llm" {
		t.Fatalf("x-target-pod=%q", prec.Header().Get("x-target-pod"))
	}
	rb, _ := io.ReadAll(prec.Body)
	if !strings.Contains(string(rb), `"echo_model":"qwen3-4b-platform"`) {
		t.Fatalf("upstream did not receive model header / echo: %s", rb)
	}
}
