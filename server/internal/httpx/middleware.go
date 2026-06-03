package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type ctxKey int

const requestIDKey ctxKey = iota

const headerRequestID = "X-Request-Id"

// RequestID 复用入站 X-Request-Id，否则生成；回写响应头并存入 context。
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(headerRequestID)
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set(headerRequestID, id)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequestIDFrom 从 context 取请求 id。
func RequestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

// statusRecorder 捕获状态码用于访问日志。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Flush 透传到底层 ResponseWriter，保证 SSE / 流式响应逐块下发。
// 不实现 http.Flusher 时，ReverseProxy（FlushInterval=-1）的 w.(http.Flusher)
// 断言会失败 → 整个流被缓冲，前端只能在结束时一次性收到（如 chat:stream token）。
func (s *statusRecorder) Flush() {
	if fl, ok := s.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

// Unwrap 让 http.ResponseController（Go 1.20+）能向下找到底层 writer 的
// Flusher / Hijacker 等能力，避免本包装层吞掉这些接口。
func (s *statusRecorder) Unwrap() http.ResponseWriter {
	return s.ResponseWriter
}

// Logger 结构化访问日志。
func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur_ms", time.Since(start).Milliseconds(),
			"request_id", RequestIDFrom(r.Context()),
		)
	})
}

// Recoverer 把 panic 转成 500 JSON 错误信封，避免裸 500 文本。
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic recovered", "err", rec, "path", r.URL.Path, "request_id", RequestIDFrom(r.Context()))
				WriteError(w, r, http.StatusInternalServerError, "internal_error", "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
