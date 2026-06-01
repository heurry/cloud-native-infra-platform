package httpx

import (
	"encoding/json"
	"net/http"
)

// ErrorBody 对齐前端 apps/web/src/lib/api.ts 的 ApiError 解析：
// message（必有）/ code / details / requestId；request id 同时写到响应头 X-Request-Id。
type ErrorBody struct {
	Code      string `json:"code,omitempty"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// WriteJSON 写出 JSON 响应体。
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// WriteError 写出统一错误信封（含当前请求的 request id）。
func WriteError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	WriteJSON(w, status, ErrorBody{
		Code:      code,
		Message:   message,
		RequestID: RequestIDFrom(r.Context()),
	})
}
