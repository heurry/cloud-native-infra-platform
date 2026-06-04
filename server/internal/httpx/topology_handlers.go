package httpx

import (
	"net/http"

	"github.com/heurry/cloudnative-infra-platform/server/internal/obs"
)

// C3：真实服务拓扑——返回从 OTel span 进程内派生的调用图（节点 + 边，边带近 60s QPS）。
// 与「服务拓扑」架构示意互补：这里的连线粗细随真实流量变化（满足 C3 验收）。
func (a *API) topologyGraph(w http.ResponseWriter, r *http.Request) {
	g := obs.Graph()
	if g == nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"self": "go-control-plane", "window_seconds": 60,
			"nodes": []any{}, "edges": []any{},
		})
		return
	}
	WriteJSON(w, http.StatusOK, g.Snapshot())
}
