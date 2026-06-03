import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Gauge,
  Home,
  Layers,
  MoreVertical,
  Play,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import {
  Donut,
  KpiGrid,
  PageHeader,
  PanelHeader,
  Sparkline,
  StatusBadge,
} from "../components/common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { dashboardSnapshot } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { bytes, byteRate, compact, fmt, pct, relativeTime } from "../lib/format";
import { cn } from "../lib/utils";
import type { Page } from "../types/navigation";
import type { Metrics, MetricsHistorySample } from "../types/platform";
import type { Deployment, Incident } from "../types/ops";
import type { KpiItem } from "../types/ui";

type Overview = {
  health_score: number;
  services: { total: number; healthy: number };
  active_alerts: number;
  recent_benchmarks: number;
  recent_benchmark_runs: Array<Record<string, unknown>>;
  kubernetes: { available: boolean; pods: unknown[] };
};

type TrendTone = "info" | "success" | "warning" | "danger";

type ServiceRow = {
  id: string;
  name: string;
  subtitle: string;
  status: string;
  qps: number;
  p95: number;
  errorRate: number;
  availability: number;
  tone: TrendTone;
  trend: number[];
};

type DeployRow = { id: string; pipeline: string; version: string; env: string; status: string; time: string };

type WeeklyRow = { id: string; label: string; value: string; delta: string; tone: TrendTone; values: number[] };

// "—" 占位：真实端点缺失/加载中时显示，绝不用写死数字伪装成有数据（5A.1）。
function show(value: number | null | undefined, format: (n: number) => string): string {
  return value == null || Number.isNaN(value) ? "—" : format(value);
}

function deltaOf(series: number[]): { delta: string; deltaTone: "up" | "down" | "flat" } {
  if (series.length < 2) return { delta: "", deltaTone: "flat" };
  const change = ((series[series.length - 1] - series[0]) / (series[0] || 1)) * 100;
  return {
    delta: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
    deltaTone: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

function deltaArrow(series: number[]): string {
  const { delta, deltaTone } = deltaOf(series);
  if (!delta) return "";
  const arrow = deltaTone === "up" ? "↑" : deltaTone === "down" ? "↓" : "→";
  return `${arrow} ${delta.replace(/^[+-]/, "")}`;
}

export function PlatformOverviewPage({ setPage }: { setPage: (page: Page) => void }) {
  const overviewQuery = useQuery({
    queryKey: ["platform", "overview"],
    queryFn: () => api<Overview>("/api/platform/overview"),
    refetchInterval: 10000,
  });
  const metricsQuery = useQuery({
    queryKey: ["metrics", "current"],
    queryFn: () => api<Metrics>("/api/metrics/current"),
    refetchInterval: 5000,
  });
  const historyQuery = useQuery({
    queryKey: ["metrics", "history", "dashboard"],
    queryFn: () => api<{ samples: MetricsHistorySample[] }>("/api/metrics/history?limit=30"),
    refetchInterval: 15000,
  });
  const deploymentsQuery = useQuery({
    queryKey: ["deployments", "dashboard"],
    queryFn: () => api<{ deployments: Deployment[] }>("/api/deployments"),
    refetchInterval: 15000,
  });
  const incidentsQuery = useQuery({
    queryKey: ["incidents", "dashboard"],
    queryFn: () => api<{ incidents: Incident[] }>("/api/incidents?status=open"),
    refetchInterval: 15000,
  });

  const overview = overviewQuery.data;
  const metrics = metricsQuery.data ?? null;
  const samples = useMemo(() => historyQuery.data?.samples ?? [], [historyQuery.data]);
  const incidents = useMemo(() => incidentsQuery.data?.incidents ?? [], [incidentsQuery.data]);
  const deployments = useMemo(() => deploymentsQuery.data?.deployments ?? [], [deploymentsQuery.data]);

  // 真实标量：缺失即为 null → 显示 "—"，不再回退写死默认值。
  const serviceCount = overview?.services.total ?? metrics?.service_instances?.length ?? null;
  const healthyCount = overview?.services.healthy ?? metrics?.service_instances?.filter((i) => i.status === "healthy").length ?? null;
  const podCount = overview?.kubernetes.pods.length ?? metrics?.kubernetes.pods.length ?? null;
  const incidentCount = incidentsQuery.data ? incidents.length : overview?.active_alerts ?? null;
  const healthScore = overview?.health_score ?? null;
  const reqCount = metrics?.request_count ?? null;
  const qps = metrics?.qps ?? null;
  const p95 = metrics?.p95_latency_ms ?? null;
  const ttft = metrics?.p95_ttft_ms ?? null;
  const errorRate = metrics?.error_rate ?? null;
  const throughput = metrics?.tokens_per_second ?? null;
  const gpuUtil = metrics?.gpu?.length ? Math.max(...metrics.gpu.map((g) => g.gpu_utilization_percent)) : null;
  const host = metrics?.host;
  const cpuUtil = host?.cpu?.usage_percent ?? null;
  const cpuCount = host?.cpu?.count || null;
  const memUtil = host?.memory?.used_percent ?? null;
  const memUsed = host?.memory?.used_bytes ?? null;
  const memTotal = host?.memory?.total_bytes || null;
  const rootDisk = pickRootDisk(host?.disk);
  const net = host?.network ?? null;
  const activeModels = metrics?.service_instances?.length
    ? new Set(metrics.service_instances.map((i) => i.model_id).filter(Boolean)).size
    : null;
  const k8sHealth = overview?.kubernetes.available ?? metrics?.kubernetes.available ?? null;
  const finishedDeploys = deployments.filter((d) => d.status === "success" || d.status === "failed");
  const deploySuccess = finishedDeploys.length
    ? Math.round((finishedDeploys.filter((d) => d.status === "success").length / finishedDeploys.length) * 100)
    : null;

  // 迷你趋势：一律从 /api/metrics/history 派生；无对应序列则留空（Sparkline 不渲染）。
  const series = (selector: (m: Partial<Metrics>) => number | null | undefined): number[] =>
    samples.map((s) => selector(s.metrics)).filter((v): v is number => typeof v === "number");
  const reqSeries = series((m) => m.request_count);
  const qpsSeries = series((m) => m.qps);
  const errSeries = series((m) => (typeof m.error_rate === "number" ? m.error_rate * 100 : null));
  const p95Series = series((m) => m.p95_latency_ms);
  const tpsSeries = series((m) => m.tokens_per_second);
  const gpuSeries = series((m) => (m.gpu?.length ? Math.max(...m.gpu.map((g) => g.gpu_utilization_percent)) : null));

  const serviceRows = useMemo(() => deriveServiceRows(metrics), [metrics]);
  const deploymentRows = useMemo(() => deriveDeployments(deployments), [deployments]);
  const alertBreakdown = useMemo(() => deriveAlertBreakdown(incidents), [incidents]);
  const weeklyTrend = useMemo<WeeklyRow[]>(() => {
    if (!samples.length) return [];
    return [
      { id: "requests", label: "请求量", value: show(reqCount, (v) => compact(v, 0)), delta: deltaArrow(reqSeries), tone: "info", values: reqSeries },
      { id: "errors", label: "错误率", value: show(errorRate, (v) => `${fmt(v * 100, 2)}%`), delta: deltaArrow(errSeries), tone: "success", values: errSeries },
      { id: "latency", label: "P95 延迟", value: show(p95, (v) => `${fmt(v, 0)}ms`), delta: deltaArrow(p95Series), tone: "warning", values: p95Series },
      { id: "gpu", label: "GPU 利用率", value: show(gpuUtil, (v) => `${fmt(v, 0)}%`), delta: deltaArrow(gpuSeries), tone: "info", values: gpuSeries },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, reqCount, errorRate, p95, gpuUtil]);

  const gpuTone: TrendTone = gpuUtil == null ? "info" : gpuUtil >= 90 ? "danger" : gpuUtil >= 75 ? "warning" : "success";
  const gpuKpiTone: "success" | "warning" | "danger" | undefined =
    gpuUtil == null ? undefined : gpuUtil >= 90 ? "danger" : gpuUtil >= 75 ? "warning" : "success";
  // 资源使用概览：CPU/内存/存储/网络 由 metrics.host（Agent 节点采集）派生，GPU 由 metrics.gpu；
  // 无 Agent（host 为空降级结构）时显示"等待 Agent 采集"，不再用写死的 "186/320 Core" 占位。
  const gpuCount = metrics?.gpu?.length ?? 0;
  const gpuStatus = metrics?.gpu_status;
  const gpuDetail = gpuCount ? `${gpuCount}×GPU` : gpuStatus?.error ? "Agent GPU 采集异常" : "等待 GPU 指标";
  const resourceLines: Array<{ id: string; label: string; value: number | null; detail: string; tone: TrendTone }> = [
    { id: "cpu", label: "CPU", value: cpuUtil, tone: utilTone(cpuUtil), detail: cpuCount && cpuUtil != null ? `${fmt((cpuCount * cpuUtil) / 100, 1)} / ${cpuCount} Core` : cpuCount ? `— / ${cpuCount} Core` : "等待 Agent 采集" },
    { id: "memory", label: "内存", value: memUtil, tone: utilTone(memUtil), detail: memTotal ? `${bytes(memUsed)} / ${bytes(memTotal)}` : "等待 Agent 采集" },
    { id: "storage", label: "存储", value: rootDisk?.used_percent ?? null, tone: utilTone(rootDisk?.used_percent ?? null), detail: rootDisk ? `${bytes(rootDisk.used_bytes)} / ${bytes(rootDisk.total_bytes)}` : "等待 Agent 采集" },
    { id: "gpu", label: "GPU", value: gpuUtil, tone: gpuStatus?.error && !gpuCount ? "warning" : gpuTone, detail: gpuDetail },
    { id: "network", label: "网络", value: null, tone: "info", detail: net ? `↓${byteRate(net.rx_bytes_per_second)} ↑${byteRate(net.tx_bytes_per_second)}` : "等待 Agent 采集" },
  ];

  const kpis: KpiItem[] = [
    {
      id: "health",
      label: "整体健康",
      value: healthScore == null ? "—" : healthScore >= 90 ? "健康" : String(healthScore),
      detail: healthScore == null ? "等待数据" : healthScore >= 90 ? "无严重告警" : `${healthScore} 分`,
      trend: [],
      tone: healthScore == null ? undefined : healthScore >= 90 ? "success" : healthScore >= 70 ? "warning" : "danger",
    },
    {
      id: "services",
      label: "服务实例",
      value: show(serviceCount, (v) => compact(v, 0)),
      detail: serviceCount == null ? "等待数据" : `运行中 ${healthyCount ?? "—"} | 异常 ${healthyCount != null ? Math.max(serviceCount - healthyCount, 0) : "—"}`,
      trend: [],
    },
    { id: "models", label: "活跃模型", value: show(activeModels, (v) => compact(v, 0)), detail: "在线绑定", trend: [] },
    {
      id: "k8s",
      label: "Kubernetes",
      value: show(podCount, (v) => compact(v, 0)),
      detail: k8sHealth == null ? "等待数据" : k8sHealth ? "集群正常" : "Agent 不可用",
      trend: [],
      tone: k8sHealth === false ? "warning" : undefined,
    },
    { id: "gpu", label: "GPU 健康", value: show(gpuUtil, (v) => pct(v, 0)), detail: gpuCount ? "利用率" : gpuStatus?.error ? "采集异常" : "等待指标", trend: gpuSeries, ...deltaOf(gpuSeries), tone: gpuStatus?.error && !gpuCount ? "warning" : gpuKpiTone },
    {
      id: "events",
      label: "待处理事件",
      value: show(incidentCount, (v) => String(v)),
      detail: incidentCount == null ? "等待数据" : `${incidentCount} 个未解决`,
      trend: [],
      tone: (incidentCount ?? 0) > 3 ? "warning" : undefined,
    },
    { id: "deploy", label: "部署成功率", value: deploySuccess == null ? "—" : `${deploySuccess}%`, detail: finishedDeploys.length ? `近 ${finishedDeploys.length} 次` : "暂无完成记录", trend: [], tone: "success" },
  ];

  return (
    <section className="infra-page dashboard-page replica-dashboard">
      <PageHeader
        title="平台总览"
        subtitle="基础设施健康与业务运行全局态势"
        actions={
          <button
            className="console-refresh"
            type="button"
            onClick={() => {
              overviewQuery.refetch();
              metricsQuery.refetch();
              historyQuery.refetch();
              deploymentsQuery.refetch();
              incidentsQuery.refetch();
            }}
          >
            <RefreshCw size={14} /> 刷新
          </button>
        }
      />

      <KpiGrid className="dashboard-kpi-strip dashboard-kpi-strip-seven" items={kpis} />

      <div className="dashboard-top-grid">
        <section className="infra-panel dashboard-alert-panel">
          <PanelHeader title="告警概览" action="按未解决事件" />
          <div className="dashboard-alert-content">
            <div className="dashboard-alert-breakdown">
              {incidentsQuery.isLoading ? (
                <Skeleton rows={2} />
              ) : incidentsQuery.isError ? (
                <ErrorState error={incidentsQuery.error} onRetry={incidentsQuery.refetch} />
              ) : alertBreakdown.length ? (
                alertBreakdown.map((item) => (
                  <div className={cn("dashboard-alert-tile", item.tone)} key={item.id}>
                    <span>{item.label}</span>
                    <strong>{item.count}</strong>
                    <small>{item.status}</small>
                  </div>
                ))
              ) : (
                <EmptyState title="暂无未解决事件" />
              )}
            </div>
          </div>
        </section>

        <section className="infra-panel dashboard-resource-panel">
          <PanelHeader title="资源使用概览" action="实时" />
          <div className="dashboard-resource-list">
            {resourceLines.map((resource) => (
              <ResourceLine
                detail={resource.detail}
                key={resource.id}
                label={resource.label}
                tone={resource.tone}
                value={resource.value}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="dashboard-mid-grid">
        <section className="infra-panel dashboard-service-panel">
          <PanelHeader title="关键服务状态" action={serviceCount != null ? `共 ${serviceCount} 个服务` : undefined} />
          <div className="dashboard-service-table">
            <div className="dashboard-service-row header">
              <span>服务</span>
              <span>状态</span>
              <span>请求量 (QPS)</span>
              <span>P95 延迟</span>
              <span>错误率</span>
              <span>可用性</span>
              <span>操作</span>
            </div>
            {metricsQuery.isLoading ? (
              <Skeleton rows={4} />
            ) : metricsQuery.isError ? (
              <ErrorState error={metricsQuery.error} onRetry={metricsQuery.refetch} />
            ) : serviceRows.length === 0 ? (
              <EmptyState title="暂无服务指标" description="等待 endpoint 指标采集" />
            ) : (
              serviceRows.map((row) => (
                <div className="dashboard-service-row" key={row.id}>
                  <div className="dashboard-service-name">
                    <ServiceGlyph tone={row.tone} />
                    <div>
                      <strong>{row.name}</strong>
                      <small>{row.subtitle}</small>
                    </div>
                  </div>
                  <StatusBadge status={row.status} />
                  <div className="dashboard-qps-cell">
                    <Sparkline values={row.trend} tone={row.tone} width={74} height={28} />
                    <strong>{compact(row.qps, 0)}</strong>
                  </div>
                  <strong className={cn(row.p95 > 500 && "danger-text", row.p95 > 250 && row.p95 <= 500 && "warning-text")}>{fmt(row.p95, 0)}ms</strong>
                  <strong className={cn(row.errorRate > 0.02 && "danger-text", row.errorRate > 0.005 && row.errorRate <= 0.02 && "warning-text")}>{fmt(row.errorRate * 100, 2)}%</strong>
                  <strong className={cn(row.availability < 99 && "danger-text", row.availability >= 99 && row.availability < 99.9 && "warning-text")}>{fmt(row.availability, 2)}%</strong>
                  <div className="dashboard-service-actions">
                    <button aria-label={`打开 ${row.name}`} onClick={() => setPage("services")} title="打开服务" type="button"><Play size={13} /></button>
                    <button aria-label={`${row.name} 更多操作`} onClick={() => setPage("observability")} title="更多操作" type="button"><MoreVertical size={13} /></button>
                  </div>
                </div>
              ))
            )}
          </div>
          <button className="dashboard-link-button" onClick={() => setPage("services")} type="button">
            查看全部服务{serviceCount != null ? ` (${serviceCount})` : ""}
          </button>
        </section>

        <section className="infra-panel dashboard-quick-panel">
          <PanelHeader title="快速入口" action="常用能力" />
          <div className="dashboard-entry-grid">
            {dashboardSnapshot.quickEntries.map((entry) => (
              <QuickEntry
                description={entry.description}
                icon={entryIcon(entry.id)}
                key={entry.id}
                onClick={() => setPage(entry.page as Page)}
                title={entry.title}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="dashboard-bottom-grid">
        <section className="infra-panel dashboard-deploy-panel">
          <PanelHeader title="最近部署" action="部署流水线" />
          <div className="dashboard-deploy-table">
            <div className="dashboard-deploy-row header">
              <span>流水线</span>
              <span>版本</span>
              <span>环境</span>
              <span>状态</span>
              <span>时间</span>
              <span>操作</span>
            </div>
            {deploymentsQuery.isLoading ? (
              <Skeleton rows={3} />
            ) : deploymentsQuery.isError ? (
              <ErrorState error={deploymentsQuery.error} onRetry={deploymentsQuery.refetch} />
            ) : deploymentRows.length === 0 ? (
              <EmptyState title="暂无部署记录" />
            ) : (
              deploymentRows.map((row) => (
                <div className="dashboard-deploy-row" key={row.id}>
                  <strong>{row.pipeline}</strong>
                  <span>{row.version}</span>
                  <span>{row.env}</span>
                  <StatusBadge status={row.status} />
                  <span>{row.time}</span>
                  <button aria-label={`打开 ${row.pipeline}`} onClick={() => setPage("pipelines")} title="打开部署" type="button"><Play size={13} /></button>
                </div>
              ))
            )}
          </div>
          <button className="dashboard-link-button" onClick={() => setPage("pipelines")} type="button">
            查看全部部署
          </button>
        </section>

        <section className="infra-panel dashboard-weekly-panel">
          <PanelHeader title="资源趋势" action={`近 ${samples.length || 0} 个采样点`} />
          <div className="dashboard-weekly-grid">
            {weeklyTrend.length === 0 ? (
              <EmptyState title="暂无历史采样" description="等待 metrics 历史样本累积" />
            ) : (
              weeklyTrend.map((item) => (
                <div className="dashboard-weekly-card" key={item.id}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  {item.delta && <small className={item.delta.startsWith("↑") ? "up" : "down"}>{item.delta}</small>}
                  <Sparkline values={item.values} tone={item.tone} width={160} height={46} />
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="infra-panel dashboard-core-strip">
        <PanelHeader title="AI Serving 核心指标" action="近 10 分钟窗口" />
        <div className="dashboard-core-metric-row">
          <CoreMetric label="总请求" value={show(reqCount, (v) => compact(v, 0))} detail="request_count" values={reqSeries} tone="info" />
          <CoreMetric label="QPS" value={show(qps, (v) => fmt(v, 1))} detail="实时吞吐" values={qpsSeries} tone="info" />
          <CoreMetric label="错误率" value={show(errorRate, (v) => `${fmt(v * 100, 2)}%`)} detail="请求失败" values={errSeries} tone={(errorRate ?? 0) > 0.01 ? "danger" : "success"} />
          <CoreMetric label="P95 延迟" value={show(p95, (v) => `${fmt(v, 0)}ms`)} detail={`TTFT ${show(ttft, (v) => `${fmt(v, 0)}ms`)}`} values={p95Series} tone={(p95 ?? 0) > 250 ? "warning" : "success"} />
          <CoreMetric label="解码吞吐" value={show(throughput, (v) => compact(v, 0))} detail="tok/s" values={tpsSeries} tone="info" />
          <div className="dashboard-core-donut">
            <Donut value={gpuUtil ?? 0} max={100} size={64} thickness={7} tone={gpuTone} />
            <div>
              <strong>GPU</strong>
              <span>{show(gpuUtil, (v) => pct(v, 0))} 利用率</span>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

function deriveServiceRows(metrics: Metrics | null): ServiceRow[] {
  if (!metrics?.endpoint_stats?.length) return [];
  const statusByName = new Map((metrics.service_instances ?? []).map((item) => [item.name, item.status]));
  const windowSeconds = metrics.window_seconds || 600;
  return metrics.endpoint_stats.slice(0, 5).map((item, index) => {
    const p95 = item.p95_latency_ms ?? item.mean_latency_ms ?? 0;
    const errorRate = item.error_rate ?? 0;
    const availability = Math.max(0, 100 - errorRate * 100);
    const tone: TrendTone = errorRate > 0.02 ? "danger" : p95 > 250 ? "warning" : "info";
    return {
      id: item.name || `endpoint-${index}`,
      name: item.name || `服务 ${index + 1}`,
      subtitle: statusByName.get(item.name) || "endpoint",
      status: errorRate > 0.02 ? "异常" : p95 > 250 ? "降级" : "正常",
      qps: item.request_count / windowSeconds,
      p95,
      errorRate,
      availability,
      tone,
      trend: [],
    };
  });
}

function deriveDeployments(items: Deployment[]): DeployRow[] {
  return items.slice(0, 3).map((item) => ({
    id: item.id,
    pipeline: item.name || "deployment",
    version: item.version || "latest",
    env: item.env || "dev",
    status: item.status === "success" ? "成功" : item.status === "failed" ? "失败" : "运行中",
    time: relativeTime(item.finished_at ?? item.started_at),
  }));
}

function deriveAlertBreakdown(incidents: Incident[]): Array<{ id: string; label: string; count: number; status: string; tone: string }> {
  const counts = new Map<string, number>();
  for (const inc of incidents) {
    const key = (inc.severity || "unknown").toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labelFor = (k: string): string =>
    ({ critical: "严重", high: "高", major: "重要", medium: "中", minor: "次要", low: "低", warning: "告警", info: "提示" } as Record<string, string>)[k] ?? k;
  const toneFor = (k: string): string =>
    k.includes("crit") ? "danger" : k.includes("high") || k.includes("warn") || k.includes("major") ? "warning" : k.includes("med") || k.includes("minor") || k.includes("info") ? "info" : "neutral";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ id: key, label: labelFor(key), count, status: "未解决", tone: toneFor(key) }));
}

function ResourceLine({ detail, label, tone, value }: { detail: string; label: string; tone: TrendTone; value: number | null }) {
  const known = value != null && !Number.isNaN(value);
  return (
    <div className="dashboard-resource-line">
      <span>{label}</span>
      <div className="dashboard-resource-track">
        <i className={tone} style={{ width: known ? `${Math.max(4, Math.min(100, value as number))}%` : "0%" }} />
      </div>
      <strong>{known ? `${fmt(value as number, 0)}%` : "—"}</strong>
      <small>{detail}</small>
    </div>
  );
}

// 资源占用展示辅助。
function utilTone(value: number | null): TrendTone {
  if (value == null) return "info";
  return value >= 90 ? "danger" : value >= 75 ? "warning" : "info";
}

function pickRootDisk(
  disks: Array<{ path: string; total_bytes: number; used_bytes: number; free_bytes: number; used_percent: number | null }> | undefined
): { used_bytes: number; total_bytes: number; used_percent: number | null } | null {
  if (!disks?.length) return null;
  const root = disks.find((d) => d.path === "/");
  if (root) return root;
  // 退而取容量最大的挂载点（通常是根/数据盘）。
  return [...disks].sort((a, b) => b.total_bytes - a.total_bytes)[0];
}

function ServiceGlyph({ tone }: { tone: TrendTone }) {
  const Icon = tone === "danger" ? AlertTriangle : tone === "warning" ? Route : Server;
  return (
    <span className={cn("dashboard-service-glyph", tone)}>
      <Icon size={14} />
    </span>
  );
}

function QuickEntry({
  description,
  icon: Icon,
  onClick,
  title,
}: {
  description: string;
  icon: LucideIcon;
  onClick: () => void;
  title: string;
}) {
  return (
    <button className="dashboard-entry-card" onClick={onClick} type="button">
      <span><Icon size={20} /></span>
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
    </button>
  );
}

function entryIcon(id: string): LucideIcon {
  const icons: Record<string, LucideIcon> = {
    services: Server,
    config: ShieldCheck,
    pipelines: Route,
    observability: Gauge,
    aiOps: Activity,
    knowledge: Layers,
  };
  return icons[id] ?? Home;
}

function CoreMetric({
  detail,
  label,
  tone,
  value,
  values,
}: {
  detail: string;
  label: string;
  tone: TrendTone;
  value: string;
  values: number[];
}) {
  return (
    <div className="dashboard-core-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      <Sparkline values={values} tone={tone} width={108} height={34} />
    </div>
  );
}
