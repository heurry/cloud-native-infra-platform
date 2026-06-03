import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, CheckCircle, Database, Eye, FileText, GitBranch, MoreVertical, Plus, RefreshCw, Search, Server, ShieldCheck, Sparkles, Users } from "lucide-react";

import { useGoToPage } from "../lib/useGoToPage";

import { KpiGrid, PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { api } from "../lib/api";
import { fmt } from "../lib/format";
import type { ConfigItem, Deployment, Incident } from "../types/ops";
import type { KubernetesSnapshot, Metrics } from "../types/platform";
import type { KpiItem } from "../types/ui";

type DiagnosisListItem = {
  id: string;
  question: string;
  status: string;
  root_cause?: string | null;
  confidence?: number | null;
  created_at?: string;
};

type AiOpsIncidentRow = {
  id: string;
  rawId?: string;
  severity: string;
  title: string;
  service: string;
  signal: string;
  confidence: string;
  status: string;
  duration: string;
};

export function AIOpsPage() {
  const goTo = useGoToPage();
  const queryClient = useQueryClient();
  const [incidentSearch, setIncidentSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const incidentsQuery = useQuery({
    queryKey: ["incidents", "aiops"],
    queryFn: () => api<{ incidents: Incident[] }>("/api/incidents"),
    refetchInterval: 15000
  });
  const diagnosesQuery = useQuery({
    queryKey: ["ai", "diagnoses"],
    queryFn: () => api<{ diagnoses: DiagnosisListItem[] }>("/api/ai/diagnoses?limit=20"),
    refetchInterval: 15000
  });
  const metricsQuery = useQuery({
    queryKey: ["metrics", "current"],
    queryFn: () => api<Metrics>("/api/metrics/current"),
    refetchInterval: 5000
  });
  const k8sQuery = useQuery({
    queryKey: ["kubernetes", "snapshot"],
    queryFn: () => api<KubernetesSnapshot>("/api/kubernetes/snapshot"),
    refetchInterval: 15000
  });
  const configQuery = useQuery({
    queryKey: ["config", "items"],
    queryFn: () => api<{ items: ConfigItem[] }>("/api/config/items"),
    refetchInterval: 15000
  });
  const deploymentsQuery = useQuery({
    queryKey: ["deployments", "aiops"],
    queryFn: () => api<{ deployments: Deployment[] }>("/api/deployments"),
    refetchInterval: 15000
  });

  const createIncidentMutation = useMutation({
    mutationFn: () => api<{ id: string; status: string }>("/api/incidents", {
      method: "POST",
      body: JSON.stringify({
        title: "llm-chat-service 延迟升高",
        severity: "critical",
        summary: "llm-chat-service P95 256ms / TTFT 186ms，建议进入 AI Ops 诊断",
        operator: "frontend"
      })
    }),
    onSuccess: (payload) => {
      toast.success("Incident 已创建", { description: payload.id.slice(0, 8) });
      queryClient.invalidateQueries({ queryKey: ["incidents", "aiops"] });
    },
    onError: (error) => toast.error("创建 Incident 失败", { description: describeAIOpsError(error) })
  });

  const diagnoseMutation = useMutation({
    mutationFn: () => api<{ diagnosis?: { id?: string; status?: string }; mode?: string }>("/api/ai/diagnose", {
      method: "POST",
      body: JSON.stringify({
        question: "请基于当前 metrics、Kubernetes、配置和发布记录诊断 llm-chat-service 延迟升高的根因，并给出修复建议。",
        max_tokens: 768,
        temperature: 0.2,
        operator: "frontend"
      }),
      timeoutMs: 60_000
    }),
    onSuccess: (payload) => {
      toast.success("AI 诊断已完成", { description: payload.diagnosis?.id?.slice(0, 8) ?? payload.mode ?? "diagnosis" });
      queryClient.invalidateQueries({ queryKey: ["ai", "diagnoses"] });
    },
    onError: (error) => toast.error("AI 诊断失败", { description: describeAIOpsError(error) })
  });

  const incidentTransitionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "ack" | "resolve" }) => api<{ id: string; status: string }>(`/api/incidents/${id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ operator: "frontend" })
    }),
    onSuccess: (payload) => {
      toast.success("Incident 状态已更新", { description: `${payload.id.slice(0, 8)} · ${payload.status}` });
      queryClient.invalidateQueries({ queryKey: ["incidents", "aiops"] });
    },
    onError: (error) => toast.error("Incident 操作失败", { description: describeAIOpsError(error) })
  });

  const incidents = useMemo(() => deriveIncidents(incidentsQuery.data?.incidents), [incidentsQuery.data?.incidents]);
  const severityOptions = useMemo(() => Array.from(new Set(incidents.map((row) => row.severity))).sort(), [incidents]);
  const statusOptions = useMemo(() => Array.from(new Set(incidents.map((row) => row.status))).sort(), [incidents]);
  const filteredIncidents = useMemo(() => {
    const q = incidentSearch.trim().toLowerCase();
    return incidents.filter((row) =>
      (severityFilter === "all" || row.severity === severityFilter) &&
      (statusFilter === "all" || row.status === statusFilter) &&
      (!q || `${row.id} ${row.title} ${row.service}`.toLowerCase().includes(q))
    );
  }, [incidents, incidentSearch, severityFilter, statusFilter]);
  const diagnoses = useMemo(() => diagnosesQuery.data?.diagnoses ?? [], [diagnosesQuery.data]);
  const diagnosisCount = diagnoses.length;
  const confidences = diagnoses.map((item) => item.confidence ?? 0).filter((value) => value > 0);
  const topConfidence = confidences.length ? Math.round(Math.max(...confidences) * 100) : null;
  const latestDiagnosis = diagnoses[0];
  const metrics = metricsQuery.data;
  const contextItems = useMemo(
    () => buildAiOpsContext(metrics, k8sQuery.data, configQuery.data?.items, deploymentsQuery.data?.deployments),
    [metrics, k8sQuery.data, configQuery.data?.items, deploymentsQuery.data?.deployments]
  );
  const evidenceList = useMemo(() => buildEvidenceList(metrics, latestDiagnosis), [metrics, latestDiagnosis]);
  const criticalCount = incidents.filter((item) => item.severity === "严重").length;
  const warningCount = incidents.filter((item) => item.severity === "警告").length;
  const p95 = metrics?.p95_latency_ms ?? null;
  const busy = createIncidentMutation.isPending || diagnoseMutation.isPending || incidentTransitionMutation.isPending;

  const kpis: KpiItem[] = [
    { id: "incidents", label: "打开的 Incident", value: String(incidents.length), detail: `${criticalCount} 严重 · ${warningCount} 警告`, trend: [], tone: criticalCount ? "danger" : warningCount ? "warning" : "success" },
    { id: "confidence", label: "诊断置信度", value: topConfidence == null ? "—" : `${topConfidence}%`, detail: "最高置信度", trend: [], tone: "success" },
    { id: "latency", label: "P95 延迟", value: p95 == null ? "—" : `${fmt(p95, 0)}ms`, detail: "实时指标", trend: [], tone: p95 != null && p95 > 300 ? "danger" : "success" },
    { id: "tools", label: "诊断记录", value: String(diagnosisCount), detail: "AI 诊断次数", trend: [] },
    { id: "guard", label: "拦截模式", value: "Manual", detail: "需人工确认执行", tone: "success" },
  ];

  return (
    <section className="infra-page aiops-page aiops-replica">
      <PageHeader
        title="AI Ops / 智能诊断"
        subtitle="基于多源观测数据与知识库的智能根因分析与修复建议"
        actions={
          <>
            <button className="console-refresh" disabled={busy} onClick={() => createIncidentMutation.mutate()} type="button">
              <Plus size={14} /> 创建 Incident
            </button>
            <button className="console-refresh primary" disabled={busy} onClick={() => diagnoseMutation.mutate()} type="button">
              <Sparkles size={14} /> {diagnoseMutation.isPending ? "诊断中..." : "运行诊断"}
            </button>
            <button
              className="console-refresh"
              type="button"
              onClick={() => {
                incidentsQuery.refetch();
                diagnosesQuery.refetch();
                metricsQuery.refetch();
                k8sQuery.refetch();
                configQuery.refetch();
                deploymentsQuery.refetch();
              }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </>
        }
      />

      <div className="aiops-process-ribbon">
        {["发现问题", "定位对象", "分析原因", "推荐动作", "执行修复", "验证恢复"].map((label, index) => (
          <div className={index === 2 ? "active" : undefined} key={label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
            <small>{index === 2 ? "根因分析" : index === 0 ? "异常检测" : "修复建议"}</small>
          </div>
        ))}
      </div>

      <KpiGrid className="aiops-kpi-strip" items={kpis} />

      <section className="infra-panel aiops-context-panel">
        <PanelHeader title="上下文信息" action="Go 取证链路：metrics / k8s / config / deployments" />
        <div className="aiops-context-grid">
          {contextItems.map((item) => (
            <div className="aiops-context-card" key={item.id}>
              <ContextIcon id={item.id} />
              <div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="infra-panel aiops-incident-panel">
        <PanelHeader title="Incident 列表" action="后端实时数据" />
        <div className="aiops-toolbar">
          <select className="aiops-filter" onChange={(event) => setSeverityFilter(event.target.value)} value={severityFilter}>
            <option value="all">所有严重性</option>
            {severityOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
          <select className="aiops-filter" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
            <option value="all">所有状态</option>
            {statusOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
          <label className="aiops-search">
            <Search size={13} />
            <input onChange={(event) => setIncidentSearch(event.target.value)} placeholder="搜索 Incident ID / 标题 / 服务..." value={incidentSearch} />
          </label>
        </div>
        <div className="aiops-incident-table">
          <div className="aiops-incident-row header">
            <span>ID</span>
            <span>严重性</span>
            <span>标题</span>
            <span>服务</span>
            <span>信号</span>
            <span>置信度</span>
            <span>状态</span>
            <span>持续时间</span>
            <span>操作</span>
          </div>
          {incidentsQuery.isLoading ? (
            <Skeleton rows={3} />
          ) : incidentsQuery.isError ? (
            <ErrorState error={incidentsQuery.error} onRetry={incidentsQuery.refetch} />
          ) : filteredIncidents.length === 0 ? (
            <EmptyState title="暂无 Incident" description={incidents.length ? "无匹配的筛选结果" : "点击「创建 Incident」或等待告警触发"} />
          ) : (
          filteredIncidents.map((incident) => (
            <div className="aiops-incident-row" key={incident.id}>
              <span>{incident.id}</span>
              <StatusBadge status={incident.severity} />
              <strong>{incident.title}</strong>
              <span>{incident.service}</span>
              <span>{incident.signal}</span>
              <span>{incident.confidence}</span>
              <StatusBadge status={incident.status} />
              <span>{incident.duration}</span>
              <span className="aiops-row-actions">
                <button onClick={() => goTo("observability")} type="button" title="查看证据"><Eye size={13} /></button>
                <button
                  disabled={!incident.rawId || busy}
                  onClick={() => incident.rawId && incidentTransitionMutation.mutate({ id: incident.rawId, action: "ack" })}
                  type="button"
                  title="确认 Incident"
                >
                  <CheckCircle size={13} />
                </button>
                <button
                  disabled={!incident.rawId || busy}
                  onClick={() => incident.rawId && incidentTransitionMutation.mutate({ id: incident.rawId, action: "resolve" })}
                  type="button"
                  title="解决 Incident"
                >
                  <Bot size={13} />
                </button>
                <button onClick={() => goTo("observability")} type="button"><MoreVertical size={13} /></button>
              </span>
            </div>
          )))}
        </div>
      </section>

      <div className="aiops-bottom-grid">
        <section className="infra-panel aiops-rca-panel">
          <PanelHeader title="根因分析" action={latestDiagnosis ? `最新诊断 ${latestDiagnosis.id.slice(0, 8)}` : "待运行诊断"} />
          <div className="aiops-root-cause">
            <strong>根因结论</strong>
            <p>{latestDiagnosis?.root_cause || "尚无诊断结论，点击「运行诊断」生成"}</p>
          </div>
          <div className="aiops-evidence-list">
            <strong>关键证据</strong>
            {evidenceList.length ? (
              evidenceList.map((item) => <span key={item}>{item}</span>)
            ) : (
              <span className="aiops-evidence-empty">尚无证据，运行诊断后由 metrics / 诊断结果生成</span>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function buildAiOpsContext(
  metrics: Metrics | undefined,
  k8s: KubernetesSnapshot | undefined,
  configItems: ConfigItem[] | undefined,
  deployments: Deployment[] | undefined
) {
  const service = metrics?.service_instances?.[0];
  const runningPods = k8s?.pods?.filter((pod) => pod.phase === "Running").length ?? metrics?.kubernetes?.pods?.filter((pod) => pod.phase === "Running").length;
  const podTotal = k8s?.pods?.length ?? metrics?.kubernetes?.pods?.length;
  const latestConfig = configItems?.[0];
  const latestDeployment = deployments?.[0];
  const gpuPeak = metrics?.gpu?.length ? Math.max(...metrics.gpu.map((gpu) => gpu.gpu_utilization_percent)) : null;
  const requestCount = metrics?.request_count ?? 0;

  return [
    { id: "env", label: "环境", value: latestDeployment?.env ? `${latestDeployment.env} / Go` : "Go 控制面" },
    { id: "ns", label: "命名空间", value: k8s?.pods?.[0]?.namespace ?? metrics?.kubernetes?.pods?.[0]?.namespace ?? "default" },
    { id: "service", label: "受影响服务", value: service?.name ?? latestDeployment?.name ?? "llm-chat-service" },
    { id: "replica", label: "运行 Pod", value: podTotal ? `${runningPods ?? 0} / ${podTotal} Running` : "等待 Agent" },
    { id: "slo", label: "SLO 状态", value: metrics?.p95_latency_ms ? `P95 ${fmt(metrics.p95_latency_ms, 0)}ms` : "等待 metrics" },
    { id: "config", label: "关联配置", value: latestConfig ? `${latestConfig.config_key} v${latestConfig.active_version}` : "等待配置项" },
    { id: "deploy", label: "关联部署", value: latestDeployment ? `${latestDeployment.name}:${latestDeployment.version ?? "-"}` : "等待部署记录" },
    { id: "model", label: "关联模型", value: service?.model_id ?? "qwen3-4b" },
    { id: "impact", label: "影响请求", value: requestCount ? `${fmt(requestCount, 0)} / 10m` : "等待请求数据" },
    { id: "resource", label: "资源占用", value: gpuPeak !== null ? `GPU ${fmt(gpuPeak, 0)}%` : "等待 GPU 指标" },
  ];
}

function buildEvidenceList(metrics: Metrics | undefined, diagnosis: DiagnosisListItem | undefined) {
  const evidence: string[] = [];
  if (diagnosis?.root_cause) evidence.push(diagnosis.root_cause);
  if (metrics?.p95_latency_ms !== null && metrics?.p95_latency_ms !== undefined) evidence.push(`P95 延迟 ${fmt(metrics.p95_latency_ms, 0)}ms`);
  if (metrics?.p95_ttft_ms !== null && metrics?.p95_ttft_ms !== undefined) evidence.push(`TTFT P95 ${fmt(metrics.p95_ttft_ms, 0)}ms`);
  if (metrics?.error_rate !== null && metrics?.error_rate !== undefined) evidence.push(`错误率 ${fmt(metrics.error_rate * 100, 2)}%`);
  if (metrics?.target_pod_stats?.length) {
    const slowest = [...metrics.target_pod_stats].sort((a, b) => (b.p95_latency_ms ?? 0) - (a.p95_latency_ms ?? 0))[0];
    evidence.push(`最慢目标 ${slowest.name} · P95 ${fmt(slowest.p95_latency_ms ?? 0, 0)}ms`);
  }
  return evidence.slice(0, 5);
}

function deriveIncidents(items: Incident[] | undefined): AiOpsIncidentRow[] {
  if (!items?.length) return [];
  return items.slice(0, 50).map((item) => ({
    id: item.id.slice(0, 8),
    rawId: item.id,
    severity: severityLabel(item.severity),
    title: item.title,
    service: item.summary?.split(" ")[0] || "llm-chat-service",
    signal: item.summary || "AI 诊断事件",
    confidence: "实时",
    status: statusLabel(item.status),
    duration: item.resolved_at ? "已恢复" : "进行中",
  }));
}

function describeAIOpsError(error: unknown) {
  if (error instanceof Error) return error.message;
  return "unknown error";
}

function severityLabel(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("critical") || lower.includes("severe")) return "严重";
  if (lower.includes("warn")) return "警告";
  return "提示";
}

function statusLabel(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("resolved")) return "诊断完成";
  if (lower.includes("ack")) return "处理中";
  return "等待确认";
}

function ContextIcon({ id }: { id: string }) {
  const Icon = id === "env" ? Server
    : id === "ns" ? ShieldCheck
      : id === "service" || id === "replica" ? Bot
        : id === "slo" ? Sparkles
          : id === "config" ? FileText
            : id === "deploy" ? GitBranch
              : id === "model" ? Database
                : id === "impact" ? Users
                  : ShieldCheck;
  return <Icon size={16} />;
}
