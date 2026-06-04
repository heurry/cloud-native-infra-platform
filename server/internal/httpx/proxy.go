package httpx

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// Proxy 是面向 Python 服务的反向代理，专为 SSE 流式透传调优：
//   - FlushInterval=-1：每次写立即 flush，token 实时到前端（Copilot 经 Go 单一入口）
//   - 贯穿 X-Request-Id，链路可追踪
//   - 上游不可达 → 统一错误信封（502），对齐前端 ApiError
//
// 用法：Pass() 保留入站路径透传（如 /api/aiops/* → 同路径）；To(path) 改写上游路径
// （如 /api/ai/chat:stream → /internal/chat:stream）。
type Proxy struct {
	rp     *httputil.ReverseProxy
	target *url.URL
}

// NewProxy 构建指向 base 的反向代理。base 必须含 scheme+host（如 http://127.0.0.1:8200）。
func NewProxy(base string) (*Proxy, error) {
	target, err := url.Parse(base)
	if err != nil || target.Scheme == "" || target.Host == "" {
		return nil, fmt.Errorf("invalid proxy base %q", base)
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetXForwarded()
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.Host = target.Host
			if rid := pr.In.Header.Get(headerRequestID); rid != "" {
				pr.Out.Header.Set(headerRequestID, rid)
			}
		},
		FlushInterval: -1, // SSE：禁用缓冲，逐块 flush
		// D1：otelhttp 传输从 pr.Out.Context() 的活跃 span 注入 traceparent，串起 Go→Python（chat:stream）链路。
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Error("proxy upstream error", "path", r.URL.Path, "err", err,
				"request_id", RequestIDFrom(r.Context()))
			WriteError(w, r, http.StatusBadGateway, "ai_unavailable", "AI service unreachable")
		},
	}
	return &Proxy{rp: rp, target: target}, nil
}

// Pass 透传：上游路径 = 入站路径（迁移期把 legacy aiops/knowledge 经 Go 转给 Python 单体）。
func (p *Proxy) Pass() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p.rp.ServeHTTP(w, r)
	}
}

// To 改写上游路径后转发（如 Go 的 /api/ai/chat:stream → AI 服务 /internal/chat:stream）。
// 克隆请求以免污染中间件（日志/审计）看到的原始路径。
func (p *Proxy) To(upstreamPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := r.Clone(r.Context())
		out.URL.Path = upstreamPath
		out.URL.RawPath = ""
		p.rp.ServeHTTP(w, out)
	}
}
