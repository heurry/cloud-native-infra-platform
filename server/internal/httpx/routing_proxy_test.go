package httpx

import (
	"encoding/json"
	"testing"
)

// TestPickVariantWeighting 验证加权随机长期收敛到配置权重比例，且 0 权重永不命中。
func TestPickVariantWeighting(t *testing.T) {
	variants := []routingVariant{
		{Label: "stable", Endpoint: "vllm-a", Weight: 90},
		{Label: "canary", Endpoint: "vllm-b", Weight: 10},
		{Label: "dark", Endpoint: "vllm-c", Weight: 0},
	}
	counts := map[string]int{}
	const n = 20000
	for i := 0; i < n; i++ {
		v, ok := pickVariant(variants)
		if !ok {
			t.Fatal("pickVariant failed with positive total weight")
		}
		counts[v.Label]++
	}
	if counts["dark"] != 0 {
		t.Fatalf("zero-weight variant should never be picked, got %d", counts["dark"])
	}
	stableShare := float64(counts["stable"]) / float64(n)
	if stableShare < 0.85 || stableShare > 0.95 {
		t.Fatalf("stable share %.3f not within [0.85,0.95] of configured 0.9", stableShare)
	}
}

// TestPickVariantNoWeight 全 0 权重 → 选择失败（数据面回 503）。
func TestPickVariantNoWeight(t *testing.T) {
	if _, ok := pickVariant([]routingVariant{{Label: "a", Weight: 0}}); ok {
		t.Fatal("expected pickVariant to fail when all weights are zero")
	}
	if _, ok := pickVariant(nil); ok {
		t.Fatal("expected pickVariant to fail on empty variants")
	}
}

// TestRewriteModel 覆盖：覆盖 model 字段、空覆盖透传、非法 JSON 原样返回。
func TestRewriteModel(t *testing.T) {
	body := []byte(`{"model":"base","messages":[]}`)
	out := rewriteModel(body, "canary-v2")
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("rewriteModel produced invalid JSON: %v", err)
	}
	if m["model"] != "canary-v2" {
		t.Fatalf("model not rewritten: %v", m["model"])
	}
	if string(rewriteModel(body, "")) != string(body) {
		t.Fatal("empty override should pass body through unchanged")
	}
	bad := []byte(`not json`)
	if string(rewriteModel(bad, "x")) != string(bad) {
		t.Fatal("invalid JSON should be returned unchanged")
	}
}

// TestModelFor 覆盖优先级：override 优先，否则回退 payload model。
func TestModelFor(t *testing.T) {
	if modelFor("a", "b") != "a" {
		t.Fatal("override should win")
	}
	if modelFor("", "b") != "b" {
		t.Fatal("empty override should fall back to payload model")
	}
	if modelFor("", "") != "" {
		t.Fatal("both empty should be empty")
	}
}

// TestValidateVariants 覆盖校验分支。
func TestValidateVariants(t *testing.T) {
	cases := []struct {
		name string
		in   []routingVariant
		ok   bool
	}{
		{"empty", nil, false},
		{"no-label", []routingVariant{{Endpoint: "e", Weight: 1}}, false},
		{"no-endpoint", []routingVariant{{Label: "a", Weight: 1}}, false},
		{"dup-label", []routingVariant{{Label: "a", Endpoint: "e", Weight: 1}, {Label: "a", Endpoint: "f", Weight: 1}}, false},
		{"neg-weight", []routingVariant{{Label: "a", Endpoint: "e", Weight: -1}}, false},
		{"zero-total", []routingVariant{{Label: "a", Endpoint: "e", Weight: 0}}, false},
		{"valid", []routingVariant{{Label: "a", Endpoint: "e", Weight: 90}, {Label: "b", Endpoint: "f", Weight: 10}}, true},
	}
	for _, c := range cases {
		got := validateVariants(c.in) == ""
		if got != c.ok {
			t.Errorf("%s: validateVariants ok=%v want %v (msg=%q)", c.name, got, c.ok, validateVariants(c.in))
		}
	}
}
