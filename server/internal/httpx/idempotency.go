package httpx

import (
	"net/http"
)

// Idempotency 幂等中间件：仅对带 Idempotency-Key 头的 POST 生效。
// 首见执行并缓存响应（仅 2xx），TTL 内重放同 key 直接回放（X-Idempotent-Replay: true）。
// Redis 降级 / 无 key / 非 POST 时透明直通；流式端点（chat:stream 等）不带该头，故不会被缓冲。
func (a *API) Idempotency() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			idem := r.Header.Get("Idempotency-Key")
			if idem == "" || r.Method != http.MethodPost || a.Cache == nil || !a.Cache.Enabled() {
				next.ServeHTTP(w, r)
				return
			}
			key := "idem:" + r.Method + ":" + r.URL.Path + ":" + idem
			var prev cachedResponse
			if hit, _ := a.Cache.GetJSON(r.Context(), key, &prev); hit {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("X-Idempotent-Replay", "true")
				w.WriteHeader(prev.Status)
				_, _ = w.Write(prev.Body)
				return
			}
			rec := &captureWriter{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			if rec.status == 0 {
				rec.status = http.StatusOK
			}
			if rec.status >= 200 && rec.status < 300 {
				_ = a.Cache.SetJSON(r.Context(), key, cachedResponse{Status: rec.status, Body: rec.buf.Bytes()}, a.IdempotencyTTL)
			}
			w.WriteHeader(rec.status)
			_, _ = w.Write(rec.buf.Bytes())
		})
	}
}
