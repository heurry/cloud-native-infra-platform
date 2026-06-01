package httpx

import (
	"fmt"
	"net/http"
	"time"
)

// ---- GET /api/alerts（5A.3：基于当前指标快照的规则化告警评估） ----
//
// 平台没有独立告警表——告警是对"当前指标 + GPU + 服务实例健康"按固定阈值规则的
// 实时评估结果（非持久化、无历史，故不返回 duration）。这取代前端 Observability
// "实时告警"表此前的 mock 占位，使其展示真实、由指标驱动的告警行。
func (a *API) alerts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	m, err := a.Metrics.Current(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	gpuResp := a.agentGpu(ctx)
	si, err := a.Metrics.ServiceInstanceSummary(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	alerts := evaluateAlerts(m, gpuResp["gpu"], si, now)

	summary := map[string]int{"critical": 0, "warning": 0, "info": 0}
	for _, al := range alerts {
		if sev, ok := al["severity"].(string); ok {
			summary[sev]++
		}
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"alerts":       alerts,
		"summary":      summary,
		"evaluated_at": now,
	})
}

// evaluateAlerts 对一份扁平指标快照施加阈值规则，产出告警行。
// 规则均基于真实指标值；无负载（指标为 0/缺失）时返回空列表（无告警）。
func evaluateAlerts(m map[string]any, gpu any, instances []map[string]any, now string) []map[string]any {
	out := []map[string]any{}
	add := func(sev, name, service, instance, metric, value, threshold string) {
		out = append(out, map[string]any{
			"id":           fmt.Sprintf("alert-%s-%s", metric, instance),
			"severity":     sev,
			"name":         name,
			"service":      service,
			"instance":     instance,
			"metric":       metric,
			"value":        value,
			"threshold":    threshold,
			"status":       "firing",
			"triggered_at": now,
		})
	}

	// 聚合 P95 延迟
	if v, ok := asFloat(m["p95_latency_ms"]); ok {
		if v > 500 {
			add("critical", "P95 延迟严重超阈值", "serving", "aggregate", "p95_latency_ms", fmtMs(v), ">500ms")
		} else if v > 300 {
			add("warning", "P95 延迟升高", "serving", "aggregate", "p95_latency_ms", fmtMs(v), ">300ms")
		}
	}
	// 聚合 TTFT P95
	if v, ok := asFloat(m["p95_ttft_ms"]); ok {
		if v > 400 {
			add("critical", "TTFT 严重超阈值", "serving", "aggregate", "p95_ttft_ms", fmtMs(v), ">400ms")
		} else if v > 200 {
			add("warning", "TTFT 升高", "serving", "aggregate", "p95_ttft_ms", fmtMs(v), ">200ms")
		}
	}
	// 聚合错误率
	if v, ok := asFloat(m["error_rate"]); ok {
		if v > 0.05 {
			add("critical", "错误率严重超阈值", "serving", "aggregate", "error_rate", fmtRate(v), ">5%")
		} else if v > 0.01 {
			add("warning", "错误率升高", "serving", "aggregate", "error_rate", fmtRate(v), ">1%")
		}
	}
	// 每 GPU 利用率
	for i, g := range asSlice(gpu) {
		gm, _ := g.(map[string]any)
		if u, ok := asFloat(gm["gpu_utilization_percent"]); ok {
			name := strOr(gm["name"], fmt.Sprintf("gpu-%d", i))
			if u > 95 {
				add("critical", "GPU 利用率严重偏高", "gpu", name, "gpu_utilization_percent", fmtPct(u), ">95%")
			} else if u > 85 {
				add("warning", "GPU 利用率偏高", "gpu", name, "gpu_utilization_percent", fmtPct(u), ">85%")
			}
		}
	}
	// 每 endpoint 延迟 / 错误率
	for _, es := range asSlice(m["endpoint_stats"]) {
		em, _ := es.(map[string]any)
		name := strOr(em["name"], "endpoint")
		if v, ok := asFloat(em["p95_latency_ms"]); ok && v > 300 {
			add(sevFor(v, 500), "Endpoint P95 延迟升高", name, name, "p95_latency_ms", fmtMs(v), ">300ms")
		}
		if v, ok := asFloat(em["error_rate"]); ok && v > 0.01 {
			add(sevFor(v, 0.05), "Endpoint 错误率升高", name, name, "error_rate", fmtRate(v), ">1%")
		}
	}
	// 服务实例健康
	for _, inst := range instances {
		status := strOr(inst["status"], "")
		name := strOr(inst["name"], "instance")
		switch status {
		case "unreachable", "missing", "failed":
			add("critical", "服务实例不可用", name, name, "status", status, "healthy")
		case "warning":
			add("warning", "服务实例降级", name, name, "status", status, "healthy")
		}
	}
	return out
}

func sevFor(value, crit float64) string {
	if value > crit {
		return "critical"
	}
	return "warning"
}

func fmtMs(v float64) string   { return fmt.Sprintf("%.0fms", v) }
func fmtPct(v float64) string  { return fmt.Sprintf("%.0f%%", v) }
func fmtRate(v float64) string { return fmt.Sprintf("%.2f%%", v*100) }

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case *float64:
		if n != nil {
			return *n, true
		}
	}
	return 0, false
}

func asSlice(v any) []any {
	switch s := v.(type) {
	case []any:
		return s
	case []map[string]any:
		out := make([]any, len(s))
		for i := range s {
			out[i] = s[i]
		}
		return out
	}
	return nil
}

func strOr(v any, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}
