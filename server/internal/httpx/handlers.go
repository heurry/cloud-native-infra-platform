package httpx

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/heurry/cloudnative-infra-platform/server/internal/agentcli"
	"github.com/heurry/cloudnative-infra-platform/server/internal/aiclient"
	"github.com/heurry/cloudnative-infra-platform/server/internal/cache"
	"github.com/heurry/cloudnative-infra-platform/server/internal/k8s"
	"github.com/heurry/cloudnative-infra-platform/server/internal/metrics"
	"github.com/heurry/cloudnative-infra-platform/server/internal/serving"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// API 持有各 handler 依赖（DB 连接池 / agent 客户端 / 指标服务 / 领域 store /
// AI 服务客户端 + 反向代理 / k8s 直读 collector）。
type API struct {
	Pool        *pgxpool.Pool
	Agent       *agentcli.Client
	Metrics     *metrics.Service
	Store       *store.Store
	AI          *aiclient.Client // Phase 3：调 Python /internal/diagnose
	AIProxy     *Proxy           // Phase 3：SSE 透传到 AI 服务（chat:stream）
	LegacyProxy *Proxy           // Phase 3：迁移期把 aiops/knowledge 透传给 Python 单体
	LegacyBase  string           // legacy Python 单体 base URL；迁移期用于桥接 metrics/request_traces
	K8s         *k8s.Collector   // Phase 5 / 5B.1：控制面 client-go 直读集群（nil=未配置）
	K8sErr      string           // collector 初始化错误（降级展示用）
	Serving     *serving.Scraper // Phase 5 / Option A：vLLM Prometheus 指标抓取器（nil=未启用）
	Cadvisor    *metrics.CadvisorCollector
	CORSOrigins []string
	// 5B.4a：Redis 横切（缓存 / 限流 / 幂等）。Cache 为 nil 或禁用时全降级。
	Cache          *cache.Client
	CacheTTL       time.Duration
	IdempotencyTTL time.Duration
	RateLimitRPS   float64
	RateLimitBurst int
}

// ---- GET /api/service-instances（复刻 ServiceInstanceController.listServiceInstances） ----

func (a *API) serviceInstances(w http.ResponseWriter, r *http.Request) {
	rows, err := a.Pool.Query(r.Context(), `
		SELECT name, base_url, model_id, kind, gpu_id, routing_role, status, last_checked_at, last_heartbeat_at, metadata
		  FROM service_instances ORDER BY name`)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer rows.Close()

	instances := []map[string]any{}
	for rows.Next() {
		var name, baseURL, kind, status string
		var modelID, gpuID, routingRole *string
		var lastChecked, lastHeartbeat *time.Time
		var metadata []byte
		if err := rows.Scan(&name, &baseURL, &modelID, &kind, &gpuID, &routingRole, &status, &lastChecked, &lastHeartbeat, &metadata); err != nil {
			a.fail(w, r, err)
			return
		}
		instances = append(instances, map[string]any{
			"name": name, "base_url": baseURL, "model_id": modelID, "kind": kind,
			"gpu_id": gpuID, "routing_role": routingRole, "status": status,
			"last_checked_at": tsOrNil(lastChecked), "last_heartbeat_at": tsOrNil(lastHeartbeat),
			"metadata": jsonbObject(metadata),
		})
	}
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}
	instances = mergeLegacyServiceInstances(instances, a.legacyMetrics(r.Context()))
	WriteJSON(w, http.StatusOK, map[string]any{"instances": instances})
}

// ---- GET /api/platform/overview（复刻 PlatformOverviewController.overview） ----

func (a *API) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var firstErr error
	get := func(sql string) int {
		if firstErr != nil {
			return 0
		}
		var n int
		if err := a.Pool.QueryRow(ctx, sql).Scan(&n); err != nil {
			firstErr = err
		}
		return n
	}
	total := get(`SELECT count(*) FROM service_instances`)
	healthy := get(`SELECT count(*) FROM service_instances WHERE status = 'healthy'`)
	unhealthy := get(`SELECT count(*) FROM service_instances WHERE status IN ('unreachable','missing','failed')`)
	openIncidents := get(`SELECT count(*) FROM incidents WHERE status <> 'resolved'`)
	recentBench := get(`SELECT count(*) FROM benchmark_runs WHERE created_at > now() - interval '1 day'`)
	if firstErr != nil {
		a.fail(w, r, firstErr)
		return
	}

	runs, err := a.recentBenchmarkRuns(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}

	known := healthy + unhealthy
	healthScore := 100
	if known > 0 {
		healthScore = int(math.Round(float64(healthy) * 100.0 / float64(known)))
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"health_score":          healthScore,
		"services":              map[string]any{"total": total, "healthy": healthy},
		"active_alerts":         openIncidents,
		"recent_benchmarks":     recentBench,
		"recent_benchmark_runs": runs,
		// 5B.1：控制面 client-go 直读（取代经 Agent 透传）。
		"kubernetes": a.k8sSnapshot(ctx, true, false, false, false, false),
	})
}

func (a *API) recentBenchmarkRuns(ctx context.Context) ([]map[string]any, error) {
	rows, err := a.Pool.Query(ctx,
		`SELECT run_id, endpoint_id, workload, status, created_at FROM benchmark_runs ORDER BY created_at DESC LIMIT 5`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var runID, status string
		var endpoint, workload *string
		var createdAt time.Time
		if err := rows.Scan(&runID, &endpoint, &workload, &status, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"run_id": runID, "endpoint_id": endpoint, "workload": workload,
			"status": status, "created_at": createdAt.UTC().Format(time.RFC3339Nano),
		})
	}
	return out, rows.Err()
}

// ---- GET /api/kubernetes/*（5B.1：控制面 client-go 直读，实现见 k8s_handlers.go） ----

// ---- GET /api/metrics/*（复刻 MetricsController/MetricsService） ----

func (a *API) metricsCurrent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	m, err := a.Metrics.Current(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	legacyMetrics := a.legacyMetrics(ctx)
	mergeLegacyServingMetrics(m, legacyMetrics)
	gpuResp := a.agentGpu(ctx)
	m["gpu"] = gpuResp["gpu"]
	m["gpu_status"] = gpuResp["status"]
	m["host"] = a.agentHost(ctx)
	m["cadvisor"] = a.cadvisor(ctx)
	si, err := a.Metrics.ServiceInstanceSummary(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	m["service_instances"] = mergeLegacyServiceInstances(si, legacyMetrics)
	m["upstream_metrics"] = []any{}
	m["kubernetes"] = a.k8sSnapshot(ctx, true, false, false, true, false)
	// Option A：用真实 vLLM Prometheus 指标覆盖 serving 字段（request_traces 为空时此处提供真实值）。
	if a.Serving != nil {
		if sm := a.Serving.Snapshot(); sm != nil {
			for k, v := range sm {
				m[k] = v
			}
		}
	}
	a.Metrics.PersistSample(ctx, "api", m) // best-effort 落采样（含真实 serving 指标→history 也变真）
	WriteJSON(w, http.StatusOK, m)
}

func (a *API) metricsHistory(w http.ResponseWriter, r *http.Request) {
	limit := clamp(queryInt(r, "limit", 200), 1, 2000)
	h, err := a.Metrics.History(r.Context(), limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"samples": h})
}

func (a *API) metricsRequests(w http.ResponseWriter, r *http.Request) {
	limit := clamp(queryInt(r, "limit", 100), 1, 500)
	reqs, err := a.Metrics.RecentRequests(r.Context(), limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if len(reqs) == 0 {
		if legacy := a.fetchLegacyJSON(r.Context(), "/api/metrics/requests?limit="+strconv.Itoa(limit)); legacy != nil {
			if legacyReqs, ok := legacy["requests"].([]any); ok && len(legacyReqs) > 0 {
				WriteJSON(w, http.StatusOK, map[string]any{"requests": legacyReqs, "source": "legacy-python"})
				return
			}
		}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"requests": reqs})
}

// agentHost 取 agent /api/host 的 host 子对象；不可用时降级为 emptyHost()。
func (a *API) agentHost(ctx context.Context) any {
	resp := a.Agent.FetchObject(ctx, "/api/host")
	if avail, _ := resp["available"].(bool); avail {
		if host, ok := resp["host"].(map[string]any); ok {
			return host
		}
	}
	return emptyHost()
}

// agentGpu 取 agent /api/gpu 的 gpu 数组和状态；不可用时降级为空数组，并保留诊断原因。
func (a *API) agentGpu(ctx context.Context) map[string]any {
	resp := a.Agent.FetchObject(ctx, "/api/gpu")
	status := map[string]any{
		"available": false,
		"source":    "agent:/api/gpu",
		"gpu_count": 0,
		"error":     "",
	}
	if avail, ok := resp["available"].(bool); ok {
		status["available"] = avail
	}
	if errText, ok := resp["error"].(string); ok {
		status["error"] = errText
	}
	if gpu, ok := resp["gpu"].([]any); ok {
		status["gpu_count"] = len(gpu)
		return map[string]any{"gpu": gpu, "status": status}
	}
	if errText, ok := resp["error"].(string); ok && errText != "" {
		status["error"] = errText
	} else {
		status["error"] = "agent did not return a gpu array"
	}
	return map[string]any{"gpu": []any{}, "status": status}
}

func (a *API) cadvisor(ctx context.Context) any {
	if a.Cadvisor == nil {
		return emptyCadvisor()
	}
	return a.Cadvisor.Snapshot(ctx)
}

func (a *API) legacyMetrics(ctx context.Context) map[string]any {
	return a.fetchLegacyJSON(ctx, "/api/metrics/current")
}

func (a *API) fetchLegacyJSON(ctx context.Context, path string) map[string]any {
	if strings.TrimSpace(a.LegacyBase) == "" {
		return nil
	}
	base := strings.TrimRight(a.LegacyBase, "/")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return nil
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil || out == nil {
		return nil
	}
	return out
}

func mergeLegacyServingMetrics(dst, legacy map[string]any) {
	if dst == nil || legacy == nil {
		return
	}
	legacyCount, ok := asFloat(legacy["request_count"])
	if !ok || legacyCount <= 0 {
		return
	}
	nativeCount, _ := asFloat(dst["request_count"])
	if nativeCount > legacyCount {
		return
	}
	for _, key := range []string{
		"request_count", "qps", "error_count", "error_rate",
		"mean_latency_ms", "mean_ttft_ms",
		"p50_latency_ms", "p95_latency_ms", "p99_latency_ms",
		"p50_ttft_ms", "p95_ttft_ms", "p99_ttft_ms",
		"p95_generation_ms",
		"input_tokens", "output_tokens", "total_tokens", "tokens_per_second",
		"target_pod_counts", "endpoint_counts", "status_counts", "fallback_counts",
		"target_pod_stats", "endpoint_stats",
	} {
		if v, ok := legacy[key]; ok {
			dst[key] = v
		}
	}
	dst["metrics_source"] = "legacy-python/request_traces"
}

func mergeLegacyServiceInstances(native []map[string]any, legacy map[string]any) []map[string]any {
	if legacy == nil {
		return native
	}
	legacyRows := asSlice(legacy["service_instances"])
	if len(legacyRows) == 0 {
		return native
	}
	byName := map[string]map[string]any{}
	for _, item := range legacyRows {
		if row, ok := item.(map[string]any); ok {
			if name := strOr(row["name"], ""); name != "" {
				byName[name] = row
			}
		}
	}
	if len(native) == 0 {
		out := make([]map[string]any, 0, len(byName))
		for _, row := range byName {
			out = append(out, row)
		}
		return out
	}
	for _, row := range native {
		name := strOr(row["name"], "")
		legacyRow := byName[name]
		if legacyRow == nil {
			continue
		}
		if status := strOr(row["status"], ""); status == "" || status == "unknown" {
			if v := strOr(legacyRow["status"], ""); v != "" {
				row["status"] = v
			}
		}
		if row["last_checked_at"] == nil || strOr(row["last_checked_at"], "") == "" {
			if v := strOr(legacyRow["last_checked_at"], ""); v != "" {
				row["last_checked_at"] = v
			}
		}
	}
	return native
}

// ---- helpers ----

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("handler error", "path", r.URL.Path, "err", err, "request_id", RequestIDFrom(r.Context()))
	WriteError(w, r, http.StatusInternalServerError, "internal_error", "internal server error")
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func tsOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// jsonbObject 把 JSONB 字节解析为对象（对齐 Java JsonUtil/parseJson：null/非法 → 空对象）。
func jsonbObject(b []byte) map[string]any {
	if len(b) == 0 {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

// emptyHost / emptyCadvisor 与 Java 的降级结构逐字段一致，保证前端 HostMetrics/CadvisorMetrics 不缺字段。
func emptyHost() map[string]any {
	return map[string]any{
		"cpu": map[string]any{"usage_percent": nil, "count": 0, "load_average": []any{}},
		"memory": map[string]any{
			"total_bytes": 0, "available_bytes": 0, "used_bytes": 0,
			"used_percent": nil, "swap_total_bytes": 0, "swap_free_bytes": 0,
		},
		"disk": []any{},
		"network": map[string]any{
			"rx_bytes_per_second": 0, "tx_bytes_per_second": 0, "interfaces": []any{},
		},
	}
}

func emptyCadvisor() map[string]any {
	return map[string]any{
		"configured_url": "", "available": false, "error": "",
		"summary": map[string]any{
			"container_count": 0, "cpu_cores": 0, "memory_working_set_bytes": 0,
			"network_rx_bytes_per_second": 0, "network_tx_bytes_per_second": 0,
		},
		"containers": []any{},
	}
}
