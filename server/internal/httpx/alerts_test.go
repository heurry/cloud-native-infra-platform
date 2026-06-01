package httpx

import "testing"

const ts = "2026-06-01T00:00:00Z"

func find(alerts []map[string]any, metric, instance string) map[string]any {
	for _, a := range alerts {
		if a["metric"] == metric && a["instance"] == instance {
			return a
		}
	}
	return nil
}

func TestEvaluateAlerts_Thresholds(t *testing.T) {
	m := map[string]any{
		"p95_latency_ms": float64(600), // > 500 → critical
		"p95_ttft_ms":    float64(250), // > 200 → warning
		"error_rate":     0.06,         // > 0.05 → critical
		"endpoint_stats": []map[string]any{
			{"name": "/v1/chat", "p95_latency_ms": float64(350), "error_rate": 0.0}, // p95 warning
			{"name": "/v1/embed", "p95_latency_ms": float64(120), "error_rate": 0.02},
		},
	}
	gpu := []any{
		map[string]any{"name": "gpu-0", "gpu_utilization_percent": float64(96)}, // critical
		map[string]any{"name": "gpu-1", "gpu_utilization_percent": float64(50)}, // ok
	}
	instances := []map[string]any{
		{"name": "vllm-0", "status": "healthy"},
		{"name": "vllm-1", "status": "unreachable"}, // critical
	}

	alerts := evaluateAlerts(m, gpu, instances, ts)

	cases := []struct {
		metric, instance, severity string
	}{
		{"p95_latency_ms", "aggregate", "critical"},
		{"p95_ttft_ms", "aggregate", "warning"},
		{"error_rate", "aggregate", "critical"},
		{"p95_latency_ms", "/v1/chat", "warning"},
		{"error_rate", "/v1/embed", "warning"},
		{"gpu_utilization_percent", "gpu-0", "critical"},
		{"status", "vllm-1", "critical"},
	}
	for _, c := range cases {
		al := find(alerts, c.metric, c.instance)
		if al == nil {
			t.Errorf("expected alert metric=%s instance=%s, got none", c.metric, c.instance)
			continue
		}
		if al["severity"] != c.severity {
			t.Errorf("alert %s/%s: severity = %v, want %s", c.metric, c.instance, al["severity"], c.severity)
		}
		if al["triggered_at"] != ts || al["status"] != "firing" {
			t.Errorf("alert %s/%s: missing triggered_at/status", c.metric, c.instance)
		}
	}

	// gpu-1 (50%), embed p95 (120), healthy instance → 不应产生告警
	if find(alerts, "gpu_utilization_percent", "gpu-1") != nil {
		t.Error("gpu-1 at 50% should not alert")
	}
	if find(alerts, "status", "vllm-0") != nil {
		t.Error("healthy instance should not alert")
	}
}

func TestEvaluateAlerts_QuietWhenHealthy(t *testing.T) {
	m := map[string]any{
		"p95_latency_ms": float64(120),
		"p95_ttft_ms":    float64(40),
		"error_rate":     0.0,
		"request_count":  0,
		"endpoint_stats": []map[string]any{},
	}
	alerts := evaluateAlerts(m, []any{}, []map[string]any{{"name": "ok", "status": "healthy"}}, ts)
	if len(alerts) != 0 {
		t.Errorf("expected no alerts when healthy, got %d: %v", len(alerts), alerts)
	}
}

// 缺失指标（nil）不应 panic，也不应产生告警。
func TestEvaluateAlerts_NilMetricsSafe(t *testing.T) {
	m := map[string]any{"p95_latency_ms": nil, "error_rate": nil, "p95_ttft_ms": nil}
	alerts := evaluateAlerts(m, nil, nil, ts)
	if len(alerts) != 0 {
		t.Errorf("expected no alerts for nil metrics, got %d", len(alerts))
	}
}
