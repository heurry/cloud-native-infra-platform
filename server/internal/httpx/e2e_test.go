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
	"github.com/google/uuid"
	"github.com/heurry/cloudnative-infra-platform/server/internal/blob"
	"github.com/heurry/cloudnative-infra-platform/server/internal/cache"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/metrics"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// D4 e2e：起真实依赖（PostgreSQL + 可选 Redis/MinIO）后，经完整中间件链 + NewRouter 走关键用户路径。
// 需 TEST_DATABASE_URL；TEST_REDIS_URL / TEST_S3_ENDPOINT 给出时额外覆盖缓存/幂等/对象层。

// e2eEnv 组装一个尽量贴近生产的 API（含 Redis/MinIO 横切，按 env 启用）。
func e2eEnv(t *testing.T) (*chi.Mux, *API, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run e2e tests")
	}
	if err := db.Migrate(config.Config{DatabaseURL: url}.MigrateURL()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	a := &API{
		Pool:           pool,
		Store:          store.New(pool),
		Metrics:        metrics.NewService(pool),
		Cache:          cache.New(context.Background(), os.Getenv("TEST_REDIS_URL")),
		Blob:           blob.New(context.Background(), blob.Config{Endpoint: os.Getenv("TEST_S3_ENDPOINT"), AccessKey: env("TEST_S3_ACCESS_KEY", "minioadmin"), SecretKey: env("TEST_S3_SECRET_KEY", "minioadmin"), Bucket: env("TEST_S3_BUCKET", "infra-artifacts")}),
		CORSOrigins:    []string{"http://localhost:5173"},
		CacheTTL:       5 * time.Second,
		IdempotencyTTL: time.Minute,
		RateLimitRPS:   1000, // e2e 不想被限流误伤；混沌测试单独验证限流。
		RateLimitBurst: 1000,
	}
	return NewRouter(a), a, pool
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestE2EJourney(t *testing.T) {
	rt, a, pool := e2eEnv(t)
	defer pool.Close()

	hreq := func(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
		var rd *strings.Reader
		if body == "" {
			rd = strings.NewReader("")
		} else {
			rd = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, path, rd)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		return rec
	}

	// 1) 健康检查。
	if rec := hreq(http.MethodGet, "/api/health", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("health %d", rec.Code)
	}

	// 2) 服务实例（种子数据）。
	if rec := hreq(http.MethodGet, "/api/service-instances", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("service-instances %d", rec.Code)
	}

	// 3) 总览 cache-aside：开 Redis 时第二次应命中 HIT。
	r1 := hreq(http.MethodGet, "/api/platform/overview", "", nil)
	r2 := hreq(http.MethodGet, "/api/platform/overview", "", nil)
	if r1.Code != http.StatusOK || r2.Code != http.StatusOK {
		t.Fatalf("overview codes %d %d", r1.Code, r2.Code)
	}
	if a.Cache.Enabled() && r2.Header().Get("X-Cache") != "HIT" {
		t.Fatalf("expected overview X-Cache HIT on 2nd call with redis, got %q", r2.Header().Get("X-Cache"))
	}

	// 4) 配置中心闭环：创建 → 发布新版本 → 回滚。
	key := "e2e-" + uuid.NewString()[:8]
	cRec := hreq(http.MethodPost, "/api/config/items", `{"config_key":"`+key+`","content":"v1: true"}`, nil)
	if cRec.Code != http.StatusOK {
		t.Fatalf("create config %d body=%s", cRec.Code, cRec.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(cRec.Body.Bytes(), &created)
	pubRec := hreq(http.MethodPost, "/api/config/items/"+created.ID+"/versions", `{"content":"v2: true"}`, nil)
	if pubRec.Code != http.StatusOK {
		t.Fatalf("publish config %d body=%s", pubRec.Code, pubRec.Body.String())
	}
	var pub struct {
		ActiveVersion int `json:"active_version"`
	}
	_ = json.Unmarshal(pubRec.Body.Bytes(), &pub)
	if pub.ActiveVersion != 2 {
		t.Fatalf("expected active_version 2 after publish, got %d", pub.ActiveVersion)
	}
	rbRec := hreq(http.MethodPost, "/api/config/items/"+created.ID+"/rollback", `{"version":1}`, nil)
	if rbRec.Code != http.StatusOK {
		t.Fatalf("rollback config %d body=%s", rbRec.Code, rbRec.Body.String())
	}

	// 5) 幂等（开 Redis 时）：同 Idempotency-Key 的 POST 第二次应回放，不二次创建。
	if a.Cache.Enabled() {
		idemKey := uuid.NewString()
		k2 := "e2e-idem-" + uuid.NewString()[:8]
		h := map[string]string{"Idempotency-Key": idemKey}
		p1 := hreq(http.MethodPost, "/api/config/items", `{"config_key":"`+k2+`","content":"x"}`, h)
		p2 := hreq(http.MethodPost, "/api/config/items", `{"config_key":"`+k2+`","content":"x"}`, h)
		if p1.Code != http.StatusOK || p2.Code != http.StatusOK {
			t.Fatalf("idempotent posts codes %d %d", p1.Code, p2.Code)
		}
		if p2.Header().Get("X-Idempotent-Replay") != "true" {
			t.Fatalf("expected X-Idempotent-Replay on 2nd post, got %q", p2.Header().Get("X-Idempotent-Replay"))
		}
	}

	// 6) 存储分层（真实 DB；MinIO 可选）。
	if rec := hreq(http.MethodGet, "/api/storage/tiers", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("storage/tiers %d", rec.Code)
	}

	// 7) 404 / 405 走统一错误信封。
	if rec := hreq(http.MethodGet, "/api/does-not-exist", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 envelope, got %d", rec.Code)
	}
}
