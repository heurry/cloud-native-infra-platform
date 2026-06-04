package httpx

import (
	"bytes"
	"net"
	"net/http"
	"strings"
	"time"
)

// 缓存键（cache-aside；短 TTL，影响总览的写操作显式失效 cache:overview）。
const (
	cacheKeyOverview    = "cache:overview"
	cacheKeyK8sSnapshot = "cache:k8s:snapshot"
)

// cachedResponse 是被缓存的 HTTP 响应快照（状态码 + JSON 体），用于 cache-aside 与幂等回放。
type cachedResponse struct {
	Status int    `json:"s"`
	Body   []byte `json:"b"`
}

// captureWriter 捕获下游 handler 的状态码与响应体，不直接写出——由调用方决定是否落缓存后再 flush。
// 仅用于非流式响应（cache-aside 的 GET、带 Idempotency-Key 的 POST）。
type captureWriter struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (c *captureWriter) WriteHeader(code int) { c.status = code }

func (c *captureWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	return c.buf.Write(b)
}

// cached 给 GET handler 套 cache-aside：命中直接回放（X-Cache: HIT），未命中执行并落缓存（仅 2xx）。
// Redis 降级时透明直通。
func (a *API) cached(key string, ttl time.Duration, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.Cache == nil || !a.Cache.Enabled() {
			next(w, r)
			return
		}
		var prev cachedResponse
		if hit, _ := a.Cache.GetJSON(r.Context(), key, &prev); hit {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("X-Cache", "HIT")
			w.WriteHeader(prev.Status)
			_, _ = w.Write(prev.Body)
			return
		}
		rec := &captureWriter{ResponseWriter: w}
		next(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		if rec.status >= 200 && rec.status < 300 {
			_ = a.Cache.SetJSON(r.Context(), key, cachedResponse{Status: rec.status, Body: rec.buf.Bytes()}, ttl)
		}
		w.Header().Set("X-Cache", "MISS")
		w.WriteHeader(rec.status)
		_, _ = w.Write(rec.buf.Bytes())
	}
}

// invalidateOverview 在影响总览（服务数 / 健康数）的写操作后失效缓存；降级态 no-op。
func (a *API) invalidateOverview(r *http.Request) {
	if a.Cache != nil {
		a.Cache.Del(r.Context(), cacheKeyOverview)
	}
}

// invalidateK8sSnapshot 在 K8s 写操作（扩缩容 / HPA）后失效集群快照缓存，使前端立即看到新状态；降级态 no-op。
func (a *API) invalidateK8sSnapshot(r *http.Request) {
	if a.Cache != nil {
		a.Cache.Del(r.Context(), cacheKeyK8sSnapshot)
	}
}

// clientIP 提取限流键用的客户端 IP：优先 X-Forwarded-For 首跳，否则 RemoteAddr。
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
