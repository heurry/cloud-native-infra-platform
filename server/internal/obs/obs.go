// Package obs 是 D1 全链路可观测的控制面侧基建：
//   - traces：OpenTelemetry SDK + OTLP/HTTP 导出（env-gated，未配置 endpoint 即 no-op，不阻塞启动）
//   - metrics：Prometheus /metrics（始终开，零外部依赖），HTTP 请求计数 + 时延直方图
//   - 传播：W3C tracecontext + baggage，跨 Go→Python→vLLM 串联 span
//
// 中间件在 httpx 包（复用其 SSE-safe 的 statusRecorder）；本包只提供 Init / 指标记录 / /metrics handler。
package obs

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Config 控制遥测开关。
type Config struct {
	ServiceName  string
	ServiceVer   string
	OTLPEndpoint string // 空=不导出 trace（no-op，优雅降级）
	OTLPInsecure bool
}

// Prometheus HTTP 指标（进程内常驻；无论是否配置 OTLP 都暴露）。
var (
	httpReqs = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "http_server_requests_total",
		Help: "Total HTTP requests handled, labelled by method/route/status.",
	}, []string{"method", "route", "status"})
	httpDur = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_server_request_duration_seconds",
		Help:    "HTTP request latency in seconds, labelled by method/route.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route"})
)

func init() {
	prometheus.MustRegister(httpReqs, httpDur)
}

// Init 设置全局 propagator，并在配置了 OTLP endpoint 时建立 TracerProvider（OTLP/HTTP 批量导出）。
// 返回 shutdown（flush 在途 span）；未配置 endpoint 时返回 no-op shutdown，绝不阻塞/失败启动。
func Init(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))

	if cfg.OTLPEndpoint == "" {
		return func(context.Context) error { return nil }, nil
	}

	var opts []otlptracehttp.Option
	if strings.Contains(cfg.OTLPEndpoint, "://") {
		opts = append(opts, otlptracehttp.WithEndpointURL(cfg.OTLPEndpoint))
	} else {
		opts = append(opts, otlptracehttp.WithEndpoint(cfg.OTLPEndpoint))
		if cfg.OTLPInsecure {
			opts = append(opts, otlptracehttp.WithInsecure())
		}
	}
	exp, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return nil, err
	}
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceName(cfg.ServiceName),
		semconv.ServiceVersion(cfg.ServiceVer),
	))
	if err != nil {
		res = resource.Default()
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}

// MetricsHandler 暴露 Prometheus 抓取端点（挂到根 /metrics）。
func MetricsHandler() http.Handler { return promhttp.Handler() }

// RecordHTTP 记一条 HTTP 请求的 Prometheus 指标（route 用 chi RoutePattern，低基数）。
func RecordHTTP(method, route string, status int, dur time.Duration) {
	if route == "" {
		route = "unmatched"
	}
	httpReqs.WithLabelValues(method, route, strconv.Itoa(status)).Inc()
	httpDur.WithLabelValues(method, route).Observe(dur.Seconds())
}
