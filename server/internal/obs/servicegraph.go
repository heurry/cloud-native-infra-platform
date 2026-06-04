package obs

import (
	"context"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// C3：真实服务拓扑——从 OTel span 在进程内派生调用图（不依赖外部 Tempo/Prometheus）。
// 本进程能看到自己产生的 span：入站 server span（ingress → 本服务）、出站 client span
// （本服务 → ai-service / vLLM 网关，经 otelhttp 传输）。据此聚合「边」并按近 60s 滚动计 QPS。
// 即便未配 OTLP 导出，该 SpanProcessor 也始终安装，故调用图始终有真实流量数据。

const graphWindowSeconds = 60

// ServiceGraph 是 sdktrace.SpanProcessor，OnEnd 时把 span 归并成调用图的边。
type ServiceGraph struct {
	mu    sync.Mutex
	self  string
	nodes map[string]*graphNode
	edges map[string]*graphEdge
}

type graphNode struct {
	id, label, kind string
	requests        int64
	errors          int64
}

type graphEdge struct {
	source, target, targetKind string
	total, errTotal            int64
	rate                       rollingRate
}

func newServiceGraph(self string) *ServiceGraph {
	if self == "" {
		self = "go-control-plane"
	}
	return &ServiceGraph{self: self, nodes: map[string]*graphNode{}, edges: map[string]*graphEdge{}}
}

// --- sdktrace.SpanProcessor ---

func (g *ServiceGraph) OnStart(context.Context, sdktrace.ReadWriteSpan) {}

func (g *ServiceGraph) OnEnd(s sdktrace.ReadOnlySpan) {
	now := time.Now()
	isErr := s.Status().Code == codes.Error
	switch s.SpanKind() {
	case trace.SpanKindServer:
		// 入站：外部客户端 → 本服务。
		g.record("client", "ingress", g.self, "control-plane", now, isErr)
	case trace.SpanKindClient:
		target, kind := classifyClientTarget(s)
		g.record(g.self, "control-plane", target, kind, now, isErr)
	}
}

func (g *ServiceGraph) Shutdown(context.Context) error  { return nil }
func (g *ServiceGraph) ForceFlush(context.Context) error { return nil }

func (g *ServiceGraph) record(source, sourceKind, target, targetKind string, now time.Time, isErr bool) {
	if source == "" || target == "" || source == target {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.touchNode(source, sourceKind)
	tn := g.touchNode(target, targetKind)
	tn.requests++
	if isErr {
		tn.errors++
	}
	key := source + "\x00" + target
	e := g.edges[key]
	if e == nil {
		e = &graphEdge{source: source, target: target, targetKind: targetKind}
		g.edges[key] = e
	}
	e.total++
	if isErr {
		e.errTotal++
	}
	e.rate.observe(now, isErr)
}

func (g *ServiceGraph) touchNode(id, kind string) *graphNode {
	n := g.nodes[id]
	if n == nil {
		n = &graphNode{id: id, label: id, kind: kind}
		g.nodes[id] = n
	}
	return n
}

// --- 快照（对外 JSON） ---

type GraphNodeSnapshot struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Kind     string `json:"kind"`
	Requests int64  `json:"requests"`
	Errors   int64  `json:"errors"`
}

type GraphEdgeSnapshot struct {
	Source     string  `json:"source"`
	Target     string  `json:"target"`
	TargetKind string  `json:"target_kind"`
	Requests   int64   `json:"requests"`   // 近 window 内
	Errors     int64   `json:"errors"`     // 近 window 内
	Total      int64   `json:"total"`      // 累计
	QPS        float64 `json:"qps"`        // 近 window 平均
}

type GraphSnapshot struct {
	Self          string              `json:"self"`
	WindowSeconds int                 `json:"window_seconds"`
	GeneratedAt   string              `json:"generated_at"`
	Nodes         []GraphNodeSnapshot `json:"nodes"`
	Edges         []GraphEdgeSnapshot `json:"edges"`
}

// Snapshot 返回当前调用图（节点 + 边，边带近 60s QPS）。
func (g *ServiceGraph) Snapshot() GraphSnapshot {
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	out := GraphSnapshot{
		Self: g.self, WindowSeconds: graphWindowSeconds,
		GeneratedAt: now.UTC().Format(time.RFC3339),
		Nodes:       make([]GraphNodeSnapshot, 0, len(g.nodes)),
		Edges:       make([]GraphEdgeSnapshot, 0, len(g.edges)),
	}
	for _, n := range g.nodes {
		out.Nodes = append(out.Nodes, GraphNodeSnapshot{ID: n.id, Label: n.label, Kind: n.kind, Requests: n.requests, Errors: n.errors})
	}
	for _, e := range g.edges {
		reqs, errs := e.rate.sum(now)
		out.Edges = append(out.Edges, GraphEdgeSnapshot{
			Source: e.source, Target: e.target, TargetKind: e.targetKind,
			Requests: reqs, Errors: errs, Total: e.total,
			QPS: float64(reqs) / float64(graphWindowSeconds),
		})
	}
	sort.Slice(out.Nodes, func(i, j int) bool { return out.Nodes[i].ID < out.Nodes[j].ID })
	sort.Slice(out.Edges, func(i, j int) bool {
		if out.Edges[i].Source != out.Edges[j].Source {
			return out.Edges[i].Source < out.Edges[j].Source
		}
		return out.Edges[i].Target < out.Edges[j].Target
	})
	return out
}

// classifyClientTarget 由出站 client span 的属性推断目标组件（ai-service / vLLM 网关 / redis / pg）。
func classifyClientTarget(s sdktrace.ReadOnlySpan) (target, kind string) {
	host := strings.ToLower(hostFromSpan(s))
	switch {
	case host == "":
		return "downstream", "service"
	case strings.Contains(host, "ai-service") || strings.Contains(host, ":8200"):
		return "ai-service", "service"
	case strings.Contains(host, "redis") || strings.Contains(host, ":6379"):
		return "redis", "cache"
	case strings.Contains(host, "postgres") || strings.Contains(host, ":5432"):
		return "postgres", "datastore"
	default:
		// 控制面其余出站均为推理上游（proxy / benchmark → vLLM/AIBrix 网关）。
		return "serving-gateway", "serving"
	}
}

// hostFromSpan 从 span 属性还原目标 host:port（兼容新旧 semconv 键）。
func hostFromSpan(s sdktrace.ReadOnlySpan) string {
	var addr, port, full string
	for _, kv := range s.Attributes() {
		switch string(kv.Key) {
		case "server.address", "net.peer.name", "http.host":
			if addr == "" {
				addr = kv.Value.AsString()
			}
		case "server.port", "net.peer.port":
			if kv.Value.Type() == attribute.INT64 {
				port = strconv.FormatInt(kv.Value.AsInt64(), 10)
			} else if v := kv.Value.AsString(); v != "" {
				port = v
			}
		case "url.full", "http.url":
			full = kv.Value.AsString()
		}
	}
	if addr != "" {
		if port != "" {
			return addr + ":" + port
		}
		return addr
	}
	if full != "" {
		if u, err := url.Parse(full); err == nil && u.Host != "" {
			return u.Host
		}
	}
	return ""
}

// rollingRate 用 60 个 1 秒桶维护近 60s 的请求/错误计数（懒清扫过期桶）。
type rollingRate struct {
	reqs    [graphWindowSeconds]int64
	errs    [graphWindowSeconds]int64
	lastSec int64
}

func (r *rollingRate) observe(now time.Time, isErr bool) {
	sec := now.Unix()
	r.advance(sec)
	idx := sec % graphWindowSeconds
	r.reqs[idx]++
	if isErr {
		r.errs[idx]++
	}
}

// advance 清掉 (lastSec, sec] 之间跳过的桶。
func (r *rollingRate) advance(sec int64) {
	if r.lastSec == 0 {
		r.lastSec = sec
		return
	}
	gap := sec - r.lastSec
	if gap <= 0 {
		return
	}
	if gap >= graphWindowSeconds {
		for i := range r.reqs {
			r.reqs[i], r.errs[i] = 0, 0
		}
		r.lastSec = sec
		return
	}
	for s := r.lastSec + 1; s <= sec; s++ {
		idx := s % graphWindowSeconds
		r.reqs[idx], r.errs[idx] = 0, 0
	}
	r.lastSec = sec
}

func (r *rollingRate) sum(now time.Time) (reqs, errs int64) {
	r.advance(now.Unix())
	for i := 0; i < graphWindowSeconds; i++ {
		reqs += r.reqs[i]
		errs += r.errs[i]
	}
	return reqs, errs
}
