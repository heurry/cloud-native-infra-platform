import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Cpu, GitBranch, MoreVertical, RefreshCw, Route, Server, ShieldCheck, Zap } from "lucide-react";

import { KpiGrid, PageHeader, PanelHeader, Sparkline, StatusBadge } from "../components/common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { normalizeServiceInstance } from "../data/mockPlatformData";
import { servicesSnapshot, type ServiceConsoleRow } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { compact, fmt, pct, relativeTime } from "../lib/format";
import { cn } from "../lib/utils";
import type { Metrics, MetricsHistorySample, ServiceInstance } from "../types/platform";
import type { KpiItem } from "../types/ui";

// "—" 占位：真实端点缺失/加载中时显示，不再用写死数字伪装成有数据（5A.1）。
function show(value: number | null | undefined, format: (n: number) => string): string {
  return value == null || Number.isNaN(value) ? "—" : format(value);
}

export function ServicesPage() {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  const instancesQuery = useQuery({
    queryKey: ["service-instances"],
    queryFn: () => api<{ instances: ServiceInstance[] }>("/api/service-instances"),
    select: (payload) => payload.instances.map(normalizeServiceInstance)
  });

  const metricsQuery = useQuery({
    queryKey: ["metrics", "current"],
    queryFn: () => api<Metrics>("/api/metrics/current"),
    refetchInterval: 5000
  });

  const historyQuery = useQuery({
    queryKey: ["metrics", "history", "services"],
    queryFn: () => api<{ samples: MetricsHistorySample[] }>("/api/metrics/history?limit=30"),
    refetchInterval: 15000
  });

  const metrics = metricsQuery.data ?? null;
  const rows = useMemo(() => deriveRows(instancesQuery.data, metrics), [instancesQuery.data, metrics]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  const selectedInstance = instancesQuery.data?.find((item) => item.name === selected?.id);
  const healthyCount = rows.filter((row) => row.status === "正常").length;
  const warningCount = rows.filter((row) => row.status === "降级").length;
  const qps = metrics?.qps ?? null;
  const p95 = metrics?.p95_latency_ms ?? null;
  const errorRate = metrics?.error_rate ?? null;
  const gpuPeak = metrics?.gpu?.length ? Math.max(...metrics.gpu.map((gpu) => gpu.gpu_utilization_percent)) : null;

  const samples = useMemo(() => historyQuery.data?.samples ?? [], [historyQuery.data]);
  const series = (selector: (m: Partial<Metrics>) => number | null | undefined): number[] =>
    samples.map((s) => selector(s.metrics)).filter((v): v is number => typeof v === "number");
  const qpsSeries = series((m) => m.qps);
  const p95Series = series((m) => m.p95_latency_ms);
  const errSeries = series((m) => (typeof m.error_rate === "number" ? m.error_rate * 100 : null));
  const gpuSeries = series((m) => (m.gpu?.length ? Math.max(...m.gpu.map((g) => g.gpu_utilization_percent)) : null));

  const runtimeMix = useMemo(() => deriveRuntimeMix(rows), [rows]);
  // SLO 概览：由实时 metrics 派生（非示例）。无数据时显示 "—"。
  const availability = errorRate == null ? null : Math.max(0, 100 - errorRate * 100);
  const sloCards = [
    { id: "p95", label: "P95 延迟", value: p95 == null ? "—" : `${fmt(p95, 0)}ms`, target: "目标 < 200ms", status: p95 == null ? "等待数据" : p95 <= 200 ? "正常" : "告警", tone: p95 == null ? "info" : p95 <= 200 ? "success" : "warning" },
    { id: "error", label: "错误率", value: errorRate == null ? "—" : `${fmt(errorRate * 100, 2)}%`, target: "目标 < 1%", status: errorRate == null ? "等待数据" : errorRate < 0.01 ? "正常" : "告警", tone: errorRate == null ? "info" : errorRate < 0.01 ? "success" : "danger" },
    { id: "availability", label: "可用性", value: availability == null ? "—" : `${fmt(availability, 2)}%`, target: "目标 ≥ 99.9%", status: availability == null ? "等待数据" : availability >= 99.9 ? "正常" : "告警", tone: availability == null ? "info" : availability >= 99.9 ? "success" : "warning" },
    { id: "gpu", label: "GPU 峰值", value: gpuPeak == null ? "—" : `${fmt(gpuPeak, 0)}%`, target: "目标 < 85%", status: gpuPeak == null ? "等待数据" : gpuPeak < 85 ? "正常" : "告警", tone: gpuPeak == null ? "info" : gpuPeak < 85 ? "success" : "warning" },
  ];

  async function healthcheck(name: string) {
    setChecking(name);
    try {
      const result = await api<{ status?: string }>(`/api/service-instances/${encodeURIComponent(name)}/healthcheck`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["service-instances"] });
      toast.success(`${name} 健康检查已完成`, { description: result?.status ?? "unknown" });
    } catch (error) {
      toast.error(`${name} 健康检查失败`, { description: error instanceof Error ? error.message : "请求失败" });
    } finally {
      setChecking(null);
    }
  }

  const kpis: KpiItem[] = [
    { id: "services", label: "在线服务", value: compact(rows.length, 0), detail: "Serving endpoints", trend: [] },
    { id: "healthy", label: "健康实例", value: `${healthyCount}/${rows.length}`, detail: `${warningCount} 个降级`, trend: [], tone: warningCount ? "warning" : "success" },
    { id: "p95", label: "P95 延迟", value: show(p95, (v) => `${fmt(v, 0)}ms`), detail: "SLO < 200ms", trend: p95Series, ...deltaOf(p95Series), tone: p95 != null && p95 > 200 ? "warning" : "success" },
    { id: "qps", label: "QPS", value: show(qps, (v) => fmt(v, 1)), detail: "实时吞吐", trend: qpsSeries, ...deltaOf(qpsSeries) },
    { id: "error", label: "错误率", value: show(errorRate, (v) => `${fmt(v * 100, 2)}%`), detail: "请求失败", trend: errSeries, ...deltaOf(errSeries), tone: errorRate != null && errorRate > 0.01 ? "danger" : errorRate != null && errorRate > 0.001 ? "warning" : "success" },
    { id: "gpu", label: "GPU 使用", value: show(gpuPeak, (v) => pct(v, 0)), detail: "峰值压力", trend: gpuSeries, ...deltaOf(gpuSeries), tone: gpuPeak != null && gpuPeak >= 85 ? "warning" : "success" },
  ];

  return (
    <section className="infra-page services-page service-replica">
      <PageHeader
        title="模型服务"
        subtitle="模型 Serving 实例、路由拓扑、SLO 与资源治理"
        actions={
          <button
            className="console-refresh"
            type="button"
            onClick={() => {
              instancesQuery.refetch();
              metricsQuery.refetch();
            }}
          >
            <RefreshCw size={14} /> 刷新
          </button>
        }
      />

      <KpiGrid className="service-kpi-strip" items={kpis} />

      <div className="service-main-grid">
        <section className="infra-panel service-table-panel">
          <PanelHeader title="服务实例" action={`${rows.length} 个实例`} />
          <div className="service-console-table">
            <div className="service-console-row header">
              <span>服务</span>
              <span>运行时</span>
              <span>模型</span>
              <span>状态</span>
              <span>QPS</span>
              <span>P95</span>
              <span>错误率</span>
              <span>资源</span>
              <span>操作</span>
            </div>
            {instancesQuery.isLoading ? (
              <Skeleton rows={4} />
            ) : instancesQuery.isError ? (
              <ErrorState error={instancesQuery.error} onRetry={instancesQuery.refetch} />
            ) : rows.length === 0 ? (
              <EmptyState title="暂无服务实例" description="service_instances 目录为空" />
            ) : (
              rows.map((row) => (
                <div
                  className={cn("service-console-row", selected?.id === row.id && "active")}
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(row.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="service-name-cell">
                    <ServiceIcon tone={row.tone} />
                    <span>
                      <strong>{row.name}</strong>
                      <small>{row.replicas} replicas</small>
                    </span>
                  </span>
                  <span>{row.runtime}</span>
                  <span title={row.model}>{row.model}</span>
                  <StatusBadge status={row.status} />
                  <span className="service-qps-cell">
                    <Sparkline values={row.trend} tone={row.tone} width={70} height={24} />
                    <strong>{compact(row.qps, 0)}</strong>
                  </span>
                  <strong className={cn(row.p95 > 200 && "warning-text", row.p95 > 500 && "danger-text")}>{fmt(row.p95, 0)}ms</strong>
                  <strong className={cn(row.errorRate > 0.01 && "danger-text", row.errorRate > 0.001 && row.errorRate <= 0.01 && "warning-text")}>{fmt(row.errorRate * 100, 2)}%</strong>
                  <span className="service-resource-cell">
                    {row.gpu > 0 ? (
                      <>
                        <i style={{ width: `${row.gpu}%` }} />
                        <small>GPU {row.gpu}%</small>
                      </>
                    ) : (
                      <small>—</small>
                    )}
                  </span>
                  <span className="service-actions-cell">
                    <button
                      disabled={checking === row.name}
                      onClick={(event) => {
                        event.stopPropagation();
                        void healthcheck(row.name);
                      }}
                      type="button"
                    >
                      {checking === row.name ? "检查中" : "检查"}
                    </button>
                    <button
                      aria-label={`${row.name} 更多操作`}
                      onClick={(event) => event.stopPropagation()}
                      title="更多操作"
                      type="button"
                    >
                      <MoreVertical size={14} />
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <aside className="service-side-stack">
          <section className="infra-panel service-detail-panel">
            <PanelHeader title="服务详情" action={selected?.status} />
            {selected ? (
              <>
                <div className="service-detail-head">
                  <ServiceIcon tone={selected.tone} />
                  <div>
                    <strong>{selected.name}</strong>
                    <span>{selected.runtime} · {selected.model}</span>
                  </div>
                </div>
                <div className="service-detail-metrics">
                  <MetricLine label="P95" value={`${fmt(selected.p95, 0)}ms`} tone={selected.p95 > 200 ? "warning" : "success"} />
                  <MetricLine label="QPS" value={compact(selected.qps, 0)} tone="info" />
                  <MetricLine label="错误率" value={`${fmt(selected.errorRate * 100, 2)}%`} tone={selected.errorRate > 0.01 ? "danger" : "success"} />
                  <MetricLine label="GPU" value={selected.gpu ? `${selected.gpu}%` : "—"} tone={selected.gpu >= 85 ? "warning" : "info"} />
                  <MetricLine label="心跳" value={selectedInstance?.last_heartbeat_at ? relativeTime(selectedInstance.last_heartbeat_at) : "静态注册"} tone="info" />
                </div>
              </>
            ) : (
              <EmptyState title="未选择服务" />
            )}
          </section>

          <section className="infra-panel service-slo-panel">
            <PanelHeader title="SLO 概览" action="实时指标" />
            <div className="service-slo-grid">
              {sloCards.map((card) => (
                <div className={cn("service-slo-card", card.tone)} key={card.id}>
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                  <small>{card.target}</small>
                  <StatusBadge status={card.status} />
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <div className="service-bottom-grid">
        <section className="infra-panel service-topology-panel">
          <PanelHeader title="服务拓扑" action="Gateway → Router → Runtime" />
          <div className="service-topology-canvas">
            <svg aria-hidden="true" viewBox="0 0 100 100">
              <path d="M12 48 C22 48 25 48 36 48" />
              <path d="M36 48 C48 34 54 30 66 30" />
              <path d="M36 48 C48 62 54 66 66 66" />
              <path d="M66 30 C76 38 82 43 90 48" />
              <path d="M66 66 C76 58 82 53 90 48" />
            </svg>
            {servicesSnapshot.topology.map((node) => (
              <div className={cn("service-topology-node", node.tone)} key={node.id} style={{ left: `${node.x}%`, top: `${node.y}%` }}>
                <span>{topologyIcon(node.id)}</span>
                <strong>{node.label}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="infra-panel service-runtime-panel">
          <PanelHeader title="运行时分布" action="实例占比" />
          <div className="service-runtime-list">
            {runtimeMix.length === 0 ? (
              <EmptyState title="暂无实例" />
            ) : (
              runtimeMix.map((item) => (
                <div className="service-runtime-row" key={item.label}>
                  <span>{item.label}</span>
                  <div><i className={item.tone} style={{ width: `${item.value}%` }} /></div>
                  <strong>{item.value}%</strong>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="infra-panel service-governance-panel">
          <PanelHeader title="治理建议" action="AI Copilot" />
          <div className="service-governance-list">
            <Advice icon={ShieldCheck} title="保持 SLO 门禁" text="生产发布前继续校验 P95、TTFT 与错误率。" tone="success" />
            <Advice icon={Zap} title="路由再均衡" text="按活跃请求压力（least-request）观察各副本负载分布，必要时再均衡。" tone="info" />
            <Advice icon={GitBranch} title="回滚预案" text="保留当前模型版本与配置版本的回滚入口。" tone="info" />
          </div>
        </section>
      </div>
    </section>
  );
}

function deriveRows(instances: ServiceInstance[] | undefined, metrics: Metrics | null): ServiceConsoleRow[] {
  if (!instances?.length) return [];
  const endpointStats = metrics?.endpoint_stats ?? [];
  const statsByName = new Map(endpointStats.map((item) => [item.name, item]));
  const podStats = [...(metrics?.target_pod_stats?.length ? metrics.target_pod_stats : endpointStats)]
    .filter((item) => /pod|qwen|vllm|replica|customer/i.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const aggregateStat = aggregateGroupStats(endpointStats.length ? endpointStats : metrics?.target_pod_stats ?? []);
  const gpuPeak = metrics?.gpu?.length ? Math.max(...metrics.gpu.map((g) => g.gpu_utilization_percent)) : 0;
  return instances.slice(0, 8).map((item) => {
    const normalized = normalizeServiceInstance(item);
    const stat = pickServiceStat(normalized, statsByName, podStats, aggregateStat);
    const p95 = stat?.p95_latency_ms ?? 0;
    const errorRate = stat?.error_rate ?? 0;
    const qps = stat?.request_count && metrics?.window_seconds ? stat.request_count / metrics.window_seconds : 0;
    const onGpu = !!normalized.gpu_id && !["auto", "gateway"].includes(normalized.gpu_id);
    const gpu = onGpu ? Math.round(gpuPeak) : 0;
    const status: ServiceConsoleRow["status"] = normalized.status === "unreachable" || normalized.status === "failed"
      ? "异常"
      : errorRate > 0.01 ? "异常" : p95 > 200 ? "降级" : "正常";
    const tone: ServiceConsoleRow["tone"] = status === "异常" ? "danger" : status === "降级" ? "warning" : "info";
    return {
      id: normalized.name,
      name: normalized.name,
      runtime: normalized.kind === "vllm" ? "vLLM" : normalized.kind === "aibrix" ? "AIBrix Gateway" : normalized.kind || "Runtime",
      model: normalized.model_id || "-",
      status,
      replicas: normalized.routing_role === "replica" ? "1/1" : "2/2",
      qps,
      p95,
      errorRate,
      cpu: 0,
      gpu,
      tone,
      trend: [],
    };
  });
}

function pickServiceStat(
  instance: ServiceInstance,
  statsByName: Map<string, Metrics["endpoint_stats"][number]>,
  podStats: Metrics["endpoint_stats"],
  aggregateStat: Metrics["endpoint_stats"][number] | null,
): Metrics["endpoint_stats"][number] | undefined {
  const exact = statsByName.get(instance.name);
  if (exact) return exact;

  const role = String(instance.routing_role || "").toLowerCase();
  const kind = String(instance.kind || "").toLowerCase();
  if (kind === "vllm" || role === "replica") {
    const idx = Number.parseInt(String(instance.gpu_id ?? ""), 10);
    if (Number.isFinite(idx) && podStats[idx]) return podStats[idx];
    const suffix = instance.name.match(/(\d+)$/)?.[1];
    if (suffix && podStats[Number(suffix)]) return podStats[Number(suffix)];
    return podStats[0] ?? aggregateStat ?? undefined;
  }

  if (role.includes("gateway") || kind.includes("router") || kind.includes("aibrix")) {
    return statsByName.get(instance.name) ?? statsByName.get("auto-router") ?? statsByName.get("aibrix-gateway") ?? aggregateStat ?? undefined;
  }

  return aggregateStat ?? undefined;
}

function aggregateGroupStats(items: Metrics["endpoint_stats"]): Metrics["endpoint_stats"][number] | null {
  if (!items.length) return null;
  const requestCount = items.reduce((sum, item) => sum + (item.request_count || 0), 0);
  const errorCount = items.reduce((sum, item) => sum + (item.error_count || 0), 0);
  const outputTokens = items.reduce((sum, item) => sum + (item.output_tokens || 0), 0);
  const weighted = (field: "mean_latency_ms" | "p95_latency_ms" | "mean_ttft_ms" | "p95_ttft_ms") => {
    if (!requestCount) return null;
    const total = items.reduce((sum, item) => sum + ((item[field] ?? 0) * (item.request_count || 0)), 0);
    return total / requestCount;
  };
  return {
    name: "aggregate",
    request_count: requestCount,
    error_count: errorCount,
    error_rate: requestCount ? errorCount / requestCount : 0,
    mean_latency_ms: weighted("mean_latency_ms"),
    p95_latency_ms: weighted("p95_latency_ms"),
    mean_ttft_ms: weighted("mean_ttft_ms"),
    p95_ttft_ms: weighted("p95_ttft_ms"),
    output_tokens: outputTokens,
  };
}

function deriveRuntimeMix(rows: ServiceConsoleRow[]): Array<{ label: string; value: number; tone: string }> {
  if (!rows.length) return [];
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.runtime, (counts.get(row.runtime) ?? 0) + 1);
  const tones = ["info", "success", "warning", "ai", "neutral"];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count], index) => ({ label, value: Math.round((count / rows.length) * 100), tone: tones[index % tones.length] }));
}

function deltaOf(series: number[]): { delta: string; deltaTone: "up" | "down" | "flat" } {
  if (series.length < 2) return { delta: "", deltaTone: "flat" };
  const change = ((series[series.length - 1] - series[0]) / (series[0] || 1)) * 100;
  return {
    delta: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
    deltaTone: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

function ServiceIcon({ tone }: { tone: ServiceConsoleRow["tone"] }) {
  return (
    <span className={cn("service-console-icon", tone)}>
      <Server size={15} />
    </span>
  );
}

function MetricLine({ label, tone, value }: { label: string; tone: "info" | "success" | "warning" | "danger"; value: string }) {
  return (
    <div className="service-detail-line">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function topologyIcon(id: string) {
  if (id.includes("gateway")) return <Route size={16} />;
  if (id.includes("router")) return <Activity size={16} />;
  if (id.includes("cache")) return <Cpu size={16} />;
  return <Server size={16} />;
}

function Advice({ icon: Icon, text, title, tone }: { icon: typeof ShieldCheck; text: string; title: string; tone: "info" | "success" | "warning" }) {
  return (
    <div className={cn("service-advice-row", tone)}>
      <Icon size={16} />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}
