package obs

import (
	"testing"
	"time"
)

func edge(snap GraphSnapshot, source, target string) (GraphEdgeSnapshot, bool) {
	for _, e := range snap.Edges {
		if e.Source == source && e.Target == target {
			return e, true
		}
	}
	return GraphEdgeSnapshot{}, false
}

func TestServiceGraphAggregatesEdges(t *testing.T) {
	g := newServiceGraph("go-control-plane")
	now := time.Now()
	// 3 次入站；2 次出站到 ai-service（其中 1 次错误）。
	for i := 0; i < 3; i++ {
		g.record("client", "ingress", "go-control-plane", "control-plane", now, false)
	}
	g.record("go-control-plane", "control-plane", "ai-service", "service", now, false)
	g.record("go-control-plane", "control-plane", "ai-service", "service", now, true)

	snap := g.Snapshot()
	if len(snap.Nodes) != 3 {
		t.Fatalf("want 3 nodes, got %d (%v)", len(snap.Nodes), snap.Nodes)
	}
	ingress, ok := edge(snap, "client", "go-control-plane")
	if !ok || ingress.Requests != 3 {
		t.Fatalf("ingress edge: ok=%v requests=%d (want 3)", ok, ingress.Requests)
	}
	out, ok := edge(snap, "go-control-plane", "ai-service")
	if !ok || out.Requests != 2 || out.Errors != 1 {
		t.Fatalf("ai-service edge: ok=%v requests=%d errors=%d (want 2/1)", ok, out.Requests, out.Errors)
	}
	if out.QPS <= 0 {
		t.Fatalf("expected positive qps for recent traffic, got %v", out.QPS)
	}
}

func TestServiceGraphIgnoresSelfLoopAndEmpty(t *testing.T) {
	g := newServiceGraph("svc")
	now := time.Now()
	g.record("svc", "control-plane", "svc", "control-plane", now, false) // 自环忽略
	g.record("", "ingress", "svc", "control-plane", now, false)           // 空 source 忽略
	if snap := g.Snapshot(); len(snap.Edges) != 0 {
		t.Fatalf("expected no edges, got %v", snap.Edges)
	}
}

func TestRollingRateWindowExpiry(t *testing.T) {
	var r rollingRate
	base := time.Unix(1_000_000, 0)
	for i := 0; i < 5; i++ {
		r.observe(base, false)
	}
	if reqs, _ := r.sum(base); reqs != 5 {
		t.Fatalf("want 5 within window, got %d", reqs)
	}
	// 越过整个 60s 窗口后清零。
	if reqs, _ := r.sum(base.Add(61 * time.Second)); reqs != 0 {
		t.Fatalf("want 0 after window expiry, got %d", reqs)
	}
}
