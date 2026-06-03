package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// statusRecorder 必须实现 http.Flusher，否则 ReverseProxy（FlushInterval=-1）的
// w.(http.Flusher) 断言失败，SSE（如 /api/ai/chat:stream）会被缓冲到结束才一次性下发。
var _ http.Flusher = (*statusRecorder)(nil)

// flushSpy 是带 Flush 计数的 ResponseWriter，用于断言透传。
type flushSpy struct {
	http.ResponseWriter
	flushes int
}

func (f *flushSpy) Flush() { f.flushes++ }

// TestLoggerPreservesFlush 确认经过 Logger 包装后，handler 仍能拿到 http.Flusher
// 并把 Flush 透传到底层 writer——这是 chat:stream 逐 token 下发的前提。
func TestLoggerPreservesFlush(t *testing.T) {
	spy := &flushSpy{ResponseWriter: httptest.NewRecorder()}

	var sawFlusher bool
	h := Logger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fl, ok := w.(http.Flusher)
		sawFlusher = ok
		if ok {
			fl.Flush()
			fl.Flush()
		}
	}))
	h.ServeHTTP(spy, httptest.NewRequest(http.MethodGet, "/api/ai/chat:stream", nil))

	if !sawFlusher {
		t.Fatal("handler did not see an http.Flusher through Logger; SSE would buffer")
	}
	if spy.flushes != 2 {
		t.Fatalf("Flush not forwarded to underlying writer: got %d want 2", spy.flushes)
	}
}
