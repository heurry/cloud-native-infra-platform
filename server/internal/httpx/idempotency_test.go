package httpx

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestIdempotencyReplaysResponse(t *testing.T) {
	a := &API{Cache: testCache(t), IdempotencyTTL: time.Minute}
	var calls int32
	h := a.Idempotency()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		WriteJSON(w, http.StatusCreated, map[string]any{"id": "abc"})
	}))

	do := func() *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/deployments", nil)
		req.Header.Set("Idempotency-Key", "key-1")
		h.ServeHTTP(rr, req)
		return rr
	}
	first := do()
	second := do()

	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("handler should run once, ran %d", calls)
	}
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf("codes: %d %d", first.Code, second.Code)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("bodies differ: %q vs %q", first.Body.String(), second.Body.String())
	}
	if second.Header().Get("X-Idempotent-Replay") != "true" {
		t.Fatal("second response should be a replay")
	}
}

func TestIdempotencyNoKeyPassthrough(t *testing.T) {
	a := &API{Cache: testCache(t), IdempotencyTTL: time.Minute}
	var calls int32
	h := a.Idempotency()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusOK)
	}))
	for i := 0; i < 3; i++ {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/x", nil) // 无 Idempotency-Key
		h.ServeHTTP(rr, req)
	}
	if atomic.LoadInt32(&calls) != 3 {
		t.Fatalf("no-key requests must not dedupe, ran %d", calls)
	}
}
