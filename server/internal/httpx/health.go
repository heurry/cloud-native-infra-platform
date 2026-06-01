package httpx

import "net/http"

// Health 与 Java HealthController 契约完全一致（静态返回，前端零改造）：
// {"status":"ok","service":"infra-platform-backend","version":"0.1.0"}
func Health(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "infra-platform-backend",
		"version": "0.1.0",
	})
}
