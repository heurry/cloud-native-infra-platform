package httpx

import (
	"context"
	"net/http"

	"github.com/heurry/cloudnative-infra-platform/server/internal/k8s"
)

// k8sNative 返回控制面经 client-go 直读集群的 handler（5B.1）。
// collector 未配置（无 kubeconfig）→ disabled=true；集群不可达 → available=false+error。
func (a *API) k8sNative(wantPods, wantDeploys, wantEvents, wantNodes, wantHPAs bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, a.k8sSnapshot(r.Context(), wantPods, wantDeploys, wantEvents, wantNodes, wantHPAs))
	}
}

func (a *API) k8sSnapshot(ctx context.Context, wantPods, wantDeploys, wantEvents, wantNodes, wantHPAs bool) k8s.Snapshot {
	if a.K8s == nil {
		msg := a.K8sErr
		if msg == "" {
			msg = "kubernetes integration not configured"
		}
		return k8s.Snapshot{
			Available:   false,
			Disabled:    true,
			Error:       msg,
			Pods:        []k8s.PodSnapshot{},
			Deployments: []k8s.DeploymentSnapshot{},
			Events:      []k8s.EventSnapshot{},
			Nodes:       []k8s.NodeSnapshot{},
			Hpas:        []k8s.HPASnapshot{},
		}
	}
	return a.K8s.CollectSnapshot(ctx, wantPods, wantDeploys, wantEvents, wantNodes, wantHPAs)
}
