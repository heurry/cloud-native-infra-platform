package httpx

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/obs"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("github.com/heurry/cloudnative-infra-platform/server/internal/httpx")

// Telemetry 为每个请求创建 server span（提取入站 W3C traceparent，串联上游链路）并记一条 Prometheus 指标。
// 只用 SSE-safe 的 statusRecorder 包装 writer（不引入 otelhttp 的 writer 包装），保证 chat:stream 等流式逐块下发。
// 必须排在 RequestID 之后：这样 request_id 已在 ctx 中，可作为 span 属性与日志关联。
func Telemetry(next http.Handler) http.Handler {
	prop := otel.GetTextMapPropagator()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /metrics 抓取不建 span/不计数，避免污染 trace 与自指标。
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := tracer.Start(ctx, r.Method+" "+r.URL.Path, trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()

		start := time.Now()
		sr := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sr, r.WithContext(ctx))

		route := chi.RouteContext(r.Context()).RoutePattern()
		span.SetAttributes(
			attribute.String("http.request.method", r.Method),
			attribute.String("http.route", routeOr(route, r.URL.Path)),
			attribute.Int("http.response.status_code", sr.status),
			attribute.String("request_id", RequestIDFrom(r.Context())),
		)
		obs.RecordHTTP(r.Method, route, sr.status, time.Since(start))
	})
}

func routeOr(route, fallback string) string {
	if route == "" {
		return fallback
	}
	return route
}
