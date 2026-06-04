package httpx

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/k8s"
)

// A2：弹性扩缩容真配。把只读 K8s 升级为「配 HPA 阈值 + 手动扩缩 Deployment」，
// 但写永远受双重约束：① 全局 feature flag（ALLOW_K8S_WRITES）；② 命名空间允许名单 +
// serving 组件硬禁。默认不碰 AIBrix / vLLM serving 命名空间。

const (
	maxScaleReplicas = 50  // 单次扩缩副本上限（防误操作打爆集群）
	maxCPUUtil       = 100 // HPA 目标 CPU 利用率上限
)

// protectedSubstrings：命中即拒（即便有人把 serving 命名空间误加进允许名单，也兜底保护）。
var protectedSubstrings = []string{"aibrix", "envoy", "vllm", "qwen"}

// protectedNamespaces：系统命名空间，永不允许写。
var protectedNamespaces = map[string]bool{
	"kube-system":     true,
	"kube-public":     true,
	"kube-node-lease": true,
}

// guardNamespace 校验对 (namespace, name) 的写操作是否被允许名单放行且未命中保护规则。
func guardNamespace(namespace, name string, allowlist []string) error {
	ns := strings.ToLower(strings.TrimSpace(namespace))
	if ns == "" {
		return errors.New("namespace required")
	}
	if protectedNamespaces[ns] {
		return fmt.Errorf("命名空间 %q 受保护，禁止写操作", namespace)
	}
	target := strings.ToLower(strings.TrimSpace(name))
	for _, p := range protectedSubstrings {
		if strings.Contains(ns, p) || strings.Contains(target, p) {
			return fmt.Errorf("目标 %s/%s 命中受保护的 serving 组件（%s），禁止写操作", namespace, name, p)
		}
	}
	if len(allowlist) == 0 {
		return errors.New("未配置可写命名空间允许名单（K8S_WRITE_NAMESPACES）")
	}
	for _, allowed := range allowlist {
		if strings.EqualFold(strings.TrimSpace(allowed), ns) {
			return nil
		}
	}
	return fmt.Errorf("命名空间 %q 不在可写允许名单内", namespace)
}

// k8sWriteGuard 是所有 K8s 写 handler 的前置校验：collector 可用 + 写开启 + 命名空间放行。
// 任一不满足即写出相应错误响应并返回 false。
func (a *API) k8sWriteGuard(w http.ResponseWriter, r *http.Request, namespace, name string) bool {
	if a.K8s == nil {
		WriteError(w, r, http.StatusServiceUnavailable, "k8s_unavailable", "kubernetes integration not configured")
		return false
	}
	if !a.AllowK8sWrites {
		WriteError(w, r, http.StatusForbidden, "k8s_writes_disabled", "Kubernetes 写操作未启用（设置 ALLOW_K8S_WRITES=true）")
		return false
	}
	if err := guardNamespace(namespace, name, a.K8sWriteNamespaces); err != nil {
		WriteError(w, r, http.StatusForbidden, "k8s_namespace_protected", err.Error())
		return false
	}
	return true
}

// ===== POST /api/kubernetes/deployments/{name}/scale =====

type scaleDeploymentReq struct {
	Namespace string `json:"namespace"`
	Replicas  *int32 `json:"replicas"`
	Operator  string `json:"operator"`
}

func (a *API) scaleDeployment(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var req scaleDeploymentReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	if req.Replicas == nil {
		a.badRequest(w, r, "replicas required")
		return
	}
	if *req.Replicas < 0 || *req.Replicas > maxScaleReplicas {
		a.badRequest(w, r, fmt.Sprintf("replicas must be between 0 and %d", maxScaleReplicas))
		return
	}
	if !a.k8sWriteGuard(w, r, req.Namespace, name) {
		return
	}
	newReplicas, err := a.K8s.ScaleDeployment(r.Context(), req.Namespace, name, *req.Replicas)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	operator := a.actor(r, req.Operator)
	a.Store.Audit(r.Context(), operator, "operator", "k8s.deployment.scale", "deployment", req.Namespace+"/"+name,
		map[string]any{"replicas": newReplicas})
	a.invalidateK8sSnapshot(r)
	WriteJSON(w, http.StatusOK, map[string]any{"namespace": req.Namespace, "name": name, "replicas": newReplicas})
}

// ===== PUT /api/kubernetes/hpa（创建或更新；幂等） =====

type upsertHPAReq struct {
	Namespace     string `json:"namespace"`
	Name          string `json:"name"`        // 缺省取 target_name
	TargetName    string `json:"target_name"` // 被伸缩的 Deployment
	MinReplicas   *int32 `json:"min_replicas"`
	MaxReplicas   *int32 `json:"max_replicas"`
	TargetCPUUtil *int32 `json:"target_cpu_util"`
	Operator      string `json:"operator"`
}

func (a *API) upsertHPA(w http.ResponseWriter, r *http.Request) {
	var req upsertHPAReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	if req.TargetName == "" {
		a.badRequest(w, r, "target_name required")
		return
	}
	if req.MinReplicas == nil || req.MaxReplicas == nil || req.TargetCPUUtil == nil {
		a.badRequest(w, r, "min_replicas, max_replicas, target_cpu_util required")
		return
	}
	if *req.MinReplicas < 1 || *req.MaxReplicas > maxScaleReplicas || *req.MinReplicas > *req.MaxReplicas {
		a.badRequest(w, r, fmt.Sprintf("require 1 <= min_replicas <= max_replicas <= %d", maxScaleReplicas))
		return
	}
	if *req.TargetCPUUtil < 1 || *req.TargetCPUUtil > maxCPUUtil {
		a.badRequest(w, r, fmt.Sprintf("target_cpu_util must be between 1 and %d", maxCPUUtil))
		return
	}
	name := orDefault(req.Name, req.TargetName)
	// 守卫覆盖 HPA 名与被伸缩的 Deployment 名（两者都不得命中 serving 组件）。
	if !a.k8sWriteGuard(w, r, req.Namespace, name) || !a.k8sWriteGuard(w, r, req.Namespace, req.TargetName) {
		return
	}
	snap, err := a.K8s.UpsertHPA(r.Context(), k8s.HPASpec{
		Namespace:     req.Namespace,
		Name:          name,
		TargetName:    req.TargetName,
		MinReplicas:   *req.MinReplicas,
		MaxReplicas:   *req.MaxReplicas,
		TargetCPUUtil: *req.TargetCPUUtil,
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	operator := a.actor(r, req.Operator)
	a.Store.Audit(r.Context(), operator, "operator", "k8s.hpa.upsert", "hpa", req.Namespace+"/"+name,
		map[string]any{"target": req.TargetName, "min": *req.MinReplicas, "max": *req.MaxReplicas, "cpu": *req.TargetCPUUtil})
	a.invalidateK8sSnapshot(r)
	WriteJSON(w, http.StatusOK, snap)
}

// ===== DELETE /api/kubernetes/hpa/{name}?namespace=... =====

func (a *API) deleteHPA(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	namespace := r.URL.Query().Get("namespace")
	if !a.k8sWriteGuard(w, r, namespace, name) {
		return
	}
	if err := a.K8s.DeleteHPA(r.Context(), namespace, name); err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), a.actor(r, ""), "operator", "k8s.hpa.delete", "hpa", namespace+"/"+name, map[string]any{})
	a.invalidateK8sSnapshot(r)
	WriteJSON(w, http.StatusOK, map[string]any{"namespace": namespace, "name": name, "deleted": true})
}
