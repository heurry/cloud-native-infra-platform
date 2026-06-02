package httpx

import (
	"net/http"
)

// RateLimit 令牌桶限流中间件（按 client IP）。Redis 降级 / 未配置 / RPS<=0 时透明直通。
// 超限返回 429 + Retry-After，错误体对齐前端 ApiError（code=rate_limited）。
func (a *API) RateLimit() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if a.Cache == nil || !a.Cache.Enabled() || a.RateLimitRPS <= 0 || a.RateLimitBurst <= 0 {
				next.ServeHTTP(w, r)
				return
			}
			if !a.Cache.Allow(r.Context(), "rl:"+clientIP(r), a.RateLimitRPS, a.RateLimitBurst) {
				w.Header().Set("Retry-After", "1")
				WriteError(w, r, http.StatusTooManyRequests, "rate_limited", "too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
