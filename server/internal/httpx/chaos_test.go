package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/heurry/cloudnative-infra-platform/server/internal/aiclient"
	"github.com/heurry/cloudnative-infra-platform/server/internal/blob"
	"github.com/heurry/cloudnative-infra-platform/server/internal/cache"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// D4 混沌实验：杀依赖（Redis/MinIO/AI）验证「优雅降级」——代码已支持降级，这里用测试固化。
// Redis 运行时猝死用 miniredis（无需外部依赖，CI 任何环境都跑）；blob/AI 降级需真实 DB（gated）。

// TestChaosRedisRuntimeDeath 验证 Redis 在启动后猝死时三条横切路径全部 fail-open，不返回 5xx。
func TestChaosRedisRuntimeDeath(t *testing.T) {
	t.Run("cached degrades to passthrough", func(t *testing.T) {
		mr, err := miniredis.Run()
		if err != nil {
			t.Fatalf("miniredis: %v", err)
		}
		defer mr.Close()
		a := &API{Cache: cache.New(context.Background(), "redis://"+mr.Addr())}
		if !a.Cache.Enabled() {
			t.Fatal("cache should be enabled")
		}
		var calls int32
		h := a.cached("cache:chaos", time.Minute, func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&calls, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
		// 正常：MISS 落缓存 → HIT 回放（handler 只执行一次）。
		do2 := func() (*httptest.ResponseRecorder) {
			rec := httptest.NewRecorder()
			h(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
			return rec
		}
		do2()
		hit := do2()
		if hit.Header().Get("X-Cache") != "HIT" || atomic.LoadInt32(&calls) != 1 {
			t.Fatalf("expected cache HIT with single handler call, got hdr=%s calls=%d", hit.Header().Get("X-Cache"), calls)
		}
		// 混沌：杀 Redis → 后续请求仍 200（穿透到 handler），不 5xx。
		mr.Close()
		rec := do2()
		if rec.Code != http.StatusOK {
			t.Fatalf("after redis death, cached endpoint should still 200, got %d", rec.Code)
		}
		if atomic.LoadInt32(&calls) < 2 {
			t.Fatal("handler should re-execute when cache is dead (passthrough)")
		}
	})

	t.Run("ratelimit fails open", func(t *testing.T) {
		mr, err := miniredis.Run()
		if err != nil {
			t.Fatalf("miniredis: %v", err)
		}
		defer mr.Close()
		a := &API{Cache: cache.New(context.Background(), "redis://"+mr.Addr()), RateLimitRPS: 1, RateLimitBurst: 1}
		mw := a.RateLimit()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
		call := func() int {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			req.RemoteAddr = "10.0.0.1:1234"
			mw.ServeHTTP(rec, req)
			return rec.Code
		}
		// 正常：burst=1 → 第二次立刻 429。
		_ = call()
		if got := call(); got != http.StatusTooManyRequests {
			t.Fatalf("expected 429 on burst exhaustion, got %d", got)
		}
		// 混沌：杀 Redis → 限流脚本失败 → fail-open（放行，不 429/5xx）。
		mr.Close()
		if got := call(); got != http.StatusOK {
			t.Fatalf("after redis death, ratelimit should fail-open to 200, got %d", got)
		}
	})

	t.Run("idempotency degrades to re-execute", func(t *testing.T) {
		mr, err := miniredis.Run()
		if err != nil {
			t.Fatalf("miniredis: %v", err)
		}
		defer mr.Close()
		a := &API{Cache: cache.New(context.Background(), "redis://"+mr.Addr()), IdempotencyTTL: time.Minute}
		var calls int32
		mw := a.Idempotency()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&calls, 1)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}))
		post := func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{}"))
			req.Header.Set("Idempotency-Key", "chaos-key")
			mw.ServeHTTP(rec, req)
			return rec
		}
		post()
		replay := post()
		if replay.Header().Get("X-Idempotent-Replay") != "true" || atomic.LoadInt32(&calls) != 1 {
			t.Fatalf("expected idempotent replay with single execution, got hdr=%s calls=%d", replay.Header().Get("X-Idempotent-Replay"), calls)
		}
		// 混沌：杀 Redis → 幂等存储失效 → 退化为重新执行（不 5xx）。
		mr.Close()
		rec := post()
		if rec.Code != http.StatusOK {
			t.Fatalf("after redis death, idempotent POST should still 200, got %d", rec.Code)
		}
		if atomic.LoadInt32(&calls) < 2 {
			t.Fatal("handler should re-execute when idempotency store is dead")
		}
	})
}

// TestChaosBlobDisabled 验证对象存储不可用时存储分层接口优雅降级（不 5xx，对象层标记未启用）。需 DB。
func TestChaosBlobDisabled(t *testing.T) {
	pool := chaosPool(t)
	defer pool.Close()
	a := &API{Pool: pool, Store: store.New(pool), Blob: blob.New(context.Background(), blob.Config{})} // endpoint 空 → 禁用
	if a.Blob.Enabled() {
		t.Fatal("blob should be disabled with empty endpoint")
	}
	rec := httptest.NewRecorder()
	a.storageTiers(rec, httptest.NewRequest(http.MethodGet, "/api/storage/tiers", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("storageTiers with blob disabled should 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"kind":"object"`) {
		t.Fatalf("expected object tier present (disabled) in body: %s", rec.Body.String())
	}
}

// TestChaosAIUnavailable 验证 AI 服务不可达时评测接口返回 502（优雅）而非 500/panic。需 DB。
func TestChaosAIUnavailable(t *testing.T) {
	pool := chaosPool(t)
	defer pool.Close()
	// AI 指向黑洞地址 + 短超时。
	a := &API{Pool: pool, Store: store.New(pool), AI: aiclient.New("http://127.0.0.1:9", 2*time.Second)}
	body := `{"qa_samples":[{"question":"q","doc_ids":["d1"]}],"top_k":3}`
	rec := httptest.NewRecorder()
	a.createCustomerSupportEval(rec, httptest.NewRequest(http.MethodPost, "/api/evals/customer-support", strings.NewReader(body)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("eval with AI down should 502 (graceful), got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ai_unavailable") {
		t.Fatalf("expected ai_unavailable code, got %s", rec.Body.String())
	}
}

// chaosPool 连接测试库（需 TEST_DATABASE_URL，pgvector:pg16）；缺失则跳过。
func chaosPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run blob/AI chaos tests")
	}
	if err := db.Migrate(config.Config{DatabaseURL: url}.MigrateURL()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return pool
}
