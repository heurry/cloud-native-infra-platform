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
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRoutingPolicyLifecycle 覆盖 E3 闭环：创建策略 → 经数据面加权路由到 mock 上游 →
// 落样本 → stats 聚合 → 全量(promote) → 回滚(rollback)。需 TEST_DATABASE_URL（pgvector:pg16）。
func TestRoutingPolicyLifecycle(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run routing integration test")
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

	// 清理可能的残留。
	_, _ = pool.Exec(ctx, `DELETE FROM routing_policies WHERE name='ab-test'`)
	_, _ = pool.Exec(ctx, `DELETE FROM routing_samples WHERE policy_name='ab-test'`)

	// mock 上游（echo model 头）。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"echo_model": r.Header.Get("model"), "ok": true})
	}))
	defer upstream.Close()
	for _, name := range []string{"vllm-stable", "vllm-canary"} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO service_instances (name, base_url, model_id, kind, routing_role, status)
			 VALUES ($1, $2, 'qwen3-4b-platform', 'vllm', 'replica', 'healthy')
			 ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url, status='healthy'`,
			name, upstream.URL+"/v1"); err != nil {
			t.Fatalf("insert instance %s: %v", name, err)
		}
		defer pool.Exec(ctx, `DELETE FROM service_instances WHERE name=$1`, name)
	}

	rt := chi.NewRouter()
	rt.Post("/api/routing/policies", a.createRoutingPolicy)
	rt.Get("/api/routing/policies/{name}/stats", a.routingPolicyStats)
	rt.Post("/api/routing/policies/{name}/promote", a.promoteRoutingVariant)
	rt.Post("/api/routing/policies/{name}/rollback", a.rollbackRoutingPolicy)
	rt.Post("/api/routing/{policy}/v1/chat/completions", a.routedChatCompletions)

	// --- 创建策略（90/10 灰度，canary 覆盖 model）---
	create := `{"name":"ab-test","description":"canary","variants":[
		{"label":"stable","endpoint":"vllm-stable","weight":90},
		{"label":"canary","endpoint":"vllm-canary","model":"qwen3-4b-canary","weight":10}]}`
	rec := do(rt, http.MethodPost, "/api/routing/policies", create)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status %d body=%s", rec.Code, rec.Body.String())
	}

	// --- 数据面：发若干请求，确认 200 + 路由头 ---
	body := `{"model":"qwen3-4b-platform","messages":[{"role":"user","content":"hi"}]}`
	for i := 0; i < 12; i++ {
		prec := do(rt, http.MethodPost, "/api/routing/ab-test/v1/chat/completions", body)
		if prec.Code != http.StatusOK {
			t.Fatalf("routed proxy status %d body=%s", prec.Code, prec.Body.String())
		}
		if prec.Header().Get("x-routing-policy") != "ab-test" {
			t.Fatalf("missing x-routing-policy header")
		}
		variant := prec.Header().Get("x-routing-variant")
		if variant != "stable" && variant != "canary" {
			t.Fatalf("unexpected variant header %q", variant)
		}
	}

	// 样本异步落库（recordRoutingSample 在 goroutine 内），轮询等待。
	waitFor(t, func() bool {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM routing_samples WHERE policy_name='ab-test'`).Scan(&n)
		return n >= 12
	})

	// --- stats 聚合 ---
	srec := do(rt, http.MethodGet, "/api/routing/policies/ab-test/stats?window=3600", "")
	if srec.Code != http.StatusOK {
		t.Fatalf("stats status %d", srec.Code)
	}
	var stats struct {
		Variants []variantStat `json:"variants"`
	}
	_ = json.Unmarshal(srec.Body.Bytes(), &stats)
	var totalCount int64
	for _, v := range stats.Variants {
		totalCount += v.Count
	}
	if totalCount < 12 {
		t.Fatalf("stats counted %d samples, want >=12", totalCount)
	}

	// --- 全量：promote canary → 权重 100/0 ---
	prec := do(rt, http.MethodPost, "/api/routing/policies/ab-test/promote", `{"label":"canary"}`)
	if prec.Code != http.StatusOK {
		t.Fatalf("promote status %d body=%s", prec.Code, prec.Body.String())
	}
	pol := mustLoad(t, ctx, a, "ab-test")
	for _, v := range pol.Variants {
		if v.Label == "canary" && v.Weight != 100 {
			t.Fatalf("canary weight after promote = %d, want 100", v.Weight)
		}
		if v.Label == "stable" && v.Weight != 0 {
			t.Fatalf("stable weight after promote = %d, want 0", v.Weight)
		}
	}

	// --- 回滚：恢复 90/10 ---
	rrec := do(rt, http.MethodPost, "/api/routing/policies/ab-test/rollback", "")
	if rrec.Code != http.StatusOK {
		t.Fatalf("rollback status %d body=%s", rrec.Code, rrec.Body.String())
	}
	pol = mustLoad(t, ctx, a, "ab-test")
	got := map[string]int{}
	for _, v := range pol.Variants {
		got[v.Label] = v.Weight
	}
	if got["stable"] != 90 || got["canary"] != 10 {
		t.Fatalf("weights after rollback = %v, want stable90/canary10", got)
	}

	_, _ = pool.Exec(ctx, `DELETE FROM routing_policies WHERE name='ab-test'`)
	_, _ = pool.Exec(ctx, `DELETE FROM routing_samples WHERE policy_name='ab-test'`)
}

func do(rt http.Handler, method, path, body string) *httptest.ResponseRecorder {
	var rd *strings.Reader
	if body != "" {
		rd = strings.NewReader(body)
	} else {
		rd = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rd)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)
	return rec
}

func mustLoad(t *testing.T, ctx context.Context, a *API, name string) *routingPolicy {
	t.Helper()
	pol, err := a.loadRoutingPolicy(ctx, name)
	if err != nil {
		t.Fatalf("loadRoutingPolicy: %v", err)
	}
	return pol
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 50; i++ {
		if cond() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("condition not met within timeout")
}
