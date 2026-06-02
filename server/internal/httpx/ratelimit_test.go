package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/heurry/cloudnative-infra-platform/server/internal/cache"
)

func testCache(t *testing.T) *cache.Client {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	c := cache.New(context.Background(), "redis://"+mr.Addr())
	if !c.Enabled() {
		t.Fatal("cache should be enabled")
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestRateLimitMiddleware(t *testing.T) {
	a := &API{Cache: testCache(t), RateLimitRPS: 1, RateLimitBurst: 2}
	h := a.RateLimit()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	var codes []int
	for i := 0; i < 3; i++ {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.RemoteAddr = "10.0.0.1:1234"
		h.ServeHTTP(rr, req)
		codes = append(codes, rr.Code)
	}
	if codes[0] != http.StatusOK || codes[1] != http.StatusOK || codes[2] != http.StatusTooManyRequests {
		t.Fatalf("unexpected codes: %v", codes)
	}
}

func TestRateLimitDisabledPassthrough(t *testing.T) {
	a := &API{Cache: cache.New(context.Background(), ""), RateLimitRPS: 1, RateLimitBurst: 1}
	h := a.RateLimit()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	for i := 0; i < 5; i++ {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "10.0.0.1:1"
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("disabled limiter should pass all; got %d", rr.Code)
		}
	}
}
