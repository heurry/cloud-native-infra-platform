package httpx

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
)

// 服务注册表（5B.2）：register / heartbeat / deregister。
// 配合 main.go 的后台 reaper（按 TTL 把超时未心跳实例置 unreachable），用真实服务
// 治理取代静态目录。静态种子实例（无心跳戳）不受 reaper 影响。

type registerInstanceReq struct {
	Name        string         `json:"name"`
	BaseURL     string         `json:"base_url"`
	ModelID     string         `json:"model_id"`
	Kind        string         `json:"kind"`
	GpuID       string         `json:"gpu_id"`
	RoutingRole string         `json:"routing_role"`
	Metadata    map[string]any `json:"metadata"`
	Operator    string         `json:"operator"`
}

// POST /api/service-instances/register
func (a *API) registerServiceInstance(w http.ResponseWriter, r *http.Request) {
	var req registerInstanceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.badRequest(w, r, "invalid JSON body")
		return
	}
	if req.Name == "" || req.BaseURL == "" {
		a.badRequest(w, r, "name and base_url are required")
		return
	}
	name, status, err := a.Store.RegisterInstance(r.Context(), store.RegisterInstanceParams{
		Name:        req.Name,
		BaseURL:     req.BaseURL,
		Kind:        req.Kind,
		ModelID:     nilIfEmpty(req.ModelID),
		GpuID:       nilIfEmpty(req.GpuID),
		RoutingRole: nilIfEmpty(req.RoutingRole),
		Metadata:    req.Metadata,
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operatorOr(req.Operator), "operator", "service.register", "service_instance", name,
		map[string]any{"base_url": req.BaseURL, "kind": req.Kind})
	WriteJSON(w, http.StatusOK, map[string]any{"name": name, "status": status})
}

// POST /api/service-instances/{name}/heartbeat
func (a *API) heartbeatServiceInstance(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	ok, err := a.Store.HeartbeatInstance(r.Context(), name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if !ok {
		WriteError(w, r, http.StatusNotFound, "not_found", "service instance not found")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"name": name, "status": "healthy"})
}

// DELETE /api/service-instances/{name}
func (a *API) deregisterServiceInstance(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	ok, err := a.Store.DeregisterInstance(r.Context(), name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if !ok {
		WriteError(w, r, http.StatusNotFound, "not_found", "service instance not found")
		return
	}
	a.Store.Audit(r.Context(), "system", "operator", "service.deregister", "service_instance", name, map[string]any{})
	WriteJSON(w, http.StatusOK, map[string]any{"name": name, "deregistered": true})
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func operatorOr(s string) string {
	if s == "" {
		return "system"
	}
	return s
}
