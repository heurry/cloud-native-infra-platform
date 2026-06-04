import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, MoreVertical, RefreshCw, Scaling } from "lucide-react";

import { useGoToPage } from "../lib/useGoToPage";
import { useK8sScaling } from "../lib/useK8sScaling";

import { Donut, KpiGrid, PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { WorkloadScaleDrawer, type ScaleTarget } from "../components/kubernetes/WorkloadScaleDrawer";
import type { KubernetesWorkloadRow } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { bytes, compact, fmt, shortTime } from "../lib/format";
import { cn } from "../lib/utils";
import type { K8sDeployment, K8sEvent, K8sNode, K8sPod, KubernetesSnapshot, Metrics } from "../types/platform";
import type { KpiItem } from "../types/ui";

type ResourceTone = "info" | "success" | "warning" | "danger";

export function KubernetesPage() {
  const goTo = useGoToPage();
  const [workloadFilter, setWorkloadFilter] = useState<"all" | "abnormal" | "warning" | "normal">("all");
  const [eventFilter, setEventFilter] = useState<"all" | "warning" | "error">("all");
  const [workloadSearch, setWorkloadSearch] = useState("");
  const [scaleTarget, setScaleTarget] = useState<ScaleTarget | null>(null);
  const scaling = useK8sScaling();
  const snapshotQuery = useQuery({
    queryKey: ["kubernetes", "snapshot"],
    queryFn: () => api<KubernetesSnapshot>("/api/kubernetes/snapshot"),
    refetchInterval: 15000
  });
  const metricsQuery = useQuery({
    queryKey: ["metrics", "current"],
    queryFn: () => api<Metrics>("/api/metrics/current"),
    refetchInterval: 5000
  });

  const snapshot = snapshotQuery.data;
  const pods = snapshot?.pods ?? [];
  const deployments = snapshot?.deployments ?? [];
  const events = snapshot?.events ?? [];
  const nodes = snapshot?.nodes ?? [];
  const hpas = snapshot?.hpas ?? [];
  const available = snapshot?.available ?? false;
  const disabled = snapshot?.disabled ?? false;
  // A2：写能力由后端 feature flag 决定；前端据此灰显/启用扩缩容控件（后端仍强约束）。
  const writesEnabled = snapshot?.writes_enabled ?? false;
  const writeNamespaces = snapshot?.write_namespaces ?? [];
  const canWrite = (namespace: string, name: string) => writesEnabled && isWritable(namespace, name, writeNamespaces);
  const hpaFor = (namespace: string, name: string) =>
    hpas.find((h) => h.namespace === namespace && h.target_name === name) ?? null;
  const openScaleFor = (namespace: string, name: string) => {
    const dep = deployments.find((d) => d.namespace === namespace && d.name === name);
    const desired = dep?.desired ?? hpaFor(namespace, name)?.desired_replicas ?? 1;
    setScaleTarget({ namespace, name, desired, ready: dep?.ready ?? "—" });
  };

  const workloadRows = useMemo(() => deriveWorkloads(deployments, pods), [deployments, pods]);
  const eventRows = useMemo(() => deriveEvents(events), [events]);
  const nodeRows = useMemo(() => deriveNodeRows(nodes, pods), [nodes, pods]);
  const namespaceDist = useMemo(() => deriveNamespaceDist(pods), [pods]);
  const podStatusDist = useMemo(() => derivePodStatusDist(pods), [pods]);
  const resourceMeters = useMemo(() => deriveResourceMeters(metricsQuery.data), [metricsQuery.data]);
  const filteredWorkloadRows = useMemo(
    () => workloadRows.filter((row) => {
      const matchesFilter = workloadFilter === "all"
        || (workloadFilter === "abnormal" && row.status === "异常")
        || (workloadFilter === "warning" && row.status === "警告")
        || (workloadFilter === "normal" && row.status === "正常");
      const keyword = workloadSearch.trim().toLowerCase();
      const matchesSearch = !keyword || `${row.name} ${row.kind} ${row.namespace}`.toLowerCase().includes(keyword);
      return matchesFilter && matchesSearch;
    }),
    [workloadRows, workloadFilter, workloadSearch]
  );
  const filteredEventRows = useMemo(
    () => eventRows.filter((event) => {
      if (eventFilter === "all") return true;
      if (eventFilter === "warning") return event.type === "Warning" || event.type === "警告";
      return event.type === "Error" || event.type === "错误";
    }),
    [eventRows, eventFilter]
  );
  const podCount = pods.length;
  const runningPods = pods.filter((pod) => pod.phase === "Running").length;
  const deploymentCount = deployments.length;
  const namespaceCount = new Set(pods.map((pod) => pod.namespace).filter(Boolean)).size;
  const nodeCount = nodes.length;
  const readyNodes = nodes.filter((node) => node.status === "Ready").length;
  const warningEvents = eventRows.filter((event) => event.type === "Warning").length;
  const corednsReady = pods.some((pod) => pod.name.includes("coredns") && pod.phase === "Running");

  const kpis: KpiItem[] = [
    { id: "health", label: "集群状态", value: available ? "健康" : disabled ? "未配置" : "不可用", detail: available ? "client-go 直读" : disabled ? "未提供 kubeconfig" : "集群不可达", trend: [], tone: available ? "success" : "warning" },
    { id: "nodes", label: "节点", value: nodeCount ? `${readyNodes} / ${nodeCount}` : "—", detail: nodeCount ? "Ready / 总数" : "等待数据", trend: [], tone: nodeCount && readyNodes === nodeCount ? "success" : nodeCount ? "warning" : undefined },
    { id: "pods", label: "Pod", value: podCount ? `${runningPods} / ${podCount}` : "—", detail: podCount ? `${fmt((runningPods / Math.max(podCount, 1)) * 100, 0)}% Running` : "等待数据", trend: [] },
    { id: "deployments", label: "Deployment", value: podCount || deploymentCount ? compact(deploymentCount, 0) : "—", detail: "全命名空间", trend: [] },
    { id: "namespace", label: "Namespace", value: namespaceCount ? compact(namespaceCount, 0) : "—", detail: "活跃", trend: [] },
    { id: "events", label: "事件", value: available ? compact(eventRows.length, 0) : "—", detail: `${warningEvents} 个告警`, trend: [], tone: warningEvents ? "warning" : "success" },
  ];

  return (
    <section className="infra-page kubernetes-page k8s-replica">
      <PageHeader
        title="Kubernetes"
        subtitle="集群与工作负载运行状态、资源与事件监控"
        actions={
          <button className="console-refresh" onClick={() => snapshotQuery.refetch()} type="button">
            <RefreshCw className={snapshotQuery.isFetching ? "spinning" : undefined} size={14} /> 刷新
          </button>
        }
      />

      <div className="k8s-process-ribbon">
        {["发现问题", "定位对象", "分析原因", "推荐动作", "执行修复", "验证恢复"].map((label, index) => (
          <div className={cn("k8s-process-step", index === 1 && "active")} key={label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
            <small>{index === 1 ? "集群资源" : index === 0 ? "监控告警" : "健康检查"}</small>
          </div>
        ))}
      </div>

      <KpiGrid className="k8s-kpi-strip" items={kpis} />

      {!available && !snapshotQuery.isLoading ? (
        <section className="infra-panel">
          {snapshotQuery.isError ? (
            <ErrorState error={snapshotQuery.error} onRetry={() => snapshotQuery.refetch()} />
          ) : (
            <EmptyState
              title={disabled ? "Kubernetes 集成未配置" : "集群不可达"}
              description={snapshot?.error || (disabled ? "控制面未提供 kubeconfig（KUBECONFIG）" : "client-go 无法连接集群 API")}
            />
          )}
        </section>
      ) : null}

      <div className="k8s-top-grid">
        <section className="infra-panel k8s-resource-panel">
          <PanelHeader title="资源使用率" action="节点 (Agent 采集)" />
          <div className="k8s-resource-grid">
            {metricsQuery.isLoading ? (
              <Skeleton rows={2} />
            ) : (
              resourceMeters.map((resource) => (
                <ResourceMeter
                  detail={resource.detail}
                  key={resource.id}
                  label={resource.label}
                  tone={resource.tone}
                  value={resource.value}
                />
              ))
            )}
          </div>
        </section>

        <section className="infra-panel k8s-node-panel">
          <PanelHeader title="节点状态" action={nodeCount ? `${nodeCount} 个节点` : undefined} />
          <div className="k8s-node-table">
            <div className="k8s-node-row header">
              <span>节点</span>
              <span>状态</span>
              <span>CPU(核)</span>
              <span>内存(GiB)</span>
              <span>Pod</span>
              <span>GPU</span>
            </div>
            {snapshotQuery.isLoading ? (
              <Skeleton rows={2} />
            ) : nodeRows.length === 0 ? (
              <EmptyState title="暂无节点数据" />
            ) : (
              nodeRows.map((node) => (
                <div className="k8s-node-row" key={node.name}>
                  <strong title={`${node.roles} · ${node.version}`}>{node.name}</strong>
                  <StatusBadge status={node.status} />
                  <span>{node.cpu}</span>
                  <span>{node.memGiB}</span>
                  <span>{node.podCount}</span>
                  <span>{node.gpu}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="k8s-mid-grid">
        <section className="infra-panel k8s-workload-panel">
          <PanelHeader title="工作负载健康" action={`显示 ${filteredWorkloadRows.length} / ${workloadRows.length}`} />
          {available && !writesEnabled ? (
            <p className="k8s-write-hint">只读模式 · 设置 ALLOW_K8S_WRITES=true 并配置 K8S_WRITE_NAMESPACES 后可在行内扩缩容</p>
          ) : null}
          <div className="k8s-filter-row">
            <button className={workloadFilter === "all" ? "active" : undefined} onClick={() => setWorkloadFilter("all")} type="button">全部 ({workloadRows.length})</button>
            <button className={workloadFilter === "abnormal" ? "active" : undefined} onClick={() => setWorkloadFilter("abnormal")} type="button">异常 ({workloadRows.filter((row) => row.status === "异常").length})</button>
            <button className={workloadFilter === "warning" ? "active" : undefined} onClick={() => setWorkloadFilter("warning")} type="button">警告 ({workloadRows.filter((row) => row.status === "警告").length})</button>
            <button className={workloadFilter === "normal" ? "active" : undefined} onClick={() => setWorkloadFilter("normal")} type="button">正常 ({workloadRows.filter((row) => row.status === "正常").length})</button>
            <label>
              <input onChange={(event) => setWorkloadSearch(event.target.value)} placeholder="搜索 Deployment / StatefulSet..." value={workloadSearch} />
            </label>
          </div>
          <div className="k8s-workload-table">
            <div className="k8s-workload-row header">
              <span>名称</span>
              <span>类型</span>
              <span>命名空间</span>
              <span>就绪副本</span>
              <span>期望副本</span>
              <span>可用性</span>
              <span>状态</span>
              <span>操作</span>
            </div>
            {snapshotQuery.isLoading ? (
              <Skeleton rows={4} />
            ) : filteredWorkloadRows.length === 0 ? (
              <EmptyState title="暂无工作负载" description={workloadSearch ? "无匹配结果" : undefined} />
            ) : (
              filteredWorkloadRows.map((row) => (
                <div className="k8s-workload-row" key={row.id}>
                  <span className="k8s-workload-name">
                    <Boxes size={14} />
                    <strong>{row.name}</strong>
                  </span>
                  <span>{row.kind}</span>
                  <span>{row.namespace}</span>
                  <span>{row.replicas}</span>
                  <span>{row.desired}</span>
                  <span>{row.availability}%</span>
                  <StatusBadge status={row.status} />
                  {canWrite(row.namespace, row.name) ? (
                    <button aria-label={`${row.name} 弹性伸缩`} onClick={() => openScaleFor(row.namespace, row.name)} title="弹性伸缩（扩缩副本 / 配 HPA）" type="button"><Scaling size={14} /></button>
                  ) : (
                    <button aria-label={`${row.name} 操作`} onClick={() => goTo("observability")} title="更多操作" type="button"><MoreVertical size={14} /></button>
                  )}
                </div>
              ))
            )}
          </div>
          <button className="dashboard-link-button" onClick={() => {
            setWorkloadFilter("all");
            setWorkloadSearch("");
          }} type="button">查看全部工作负载</button>
        </section>

        <section className="infra-panel k8s-event-panel">
          <PanelHeader title="事件" action={`显示 ${filteredEventRows.length} / ${eventRows.length}`} />
          <div className="k8s-event-tabs">
            <button className={eventFilter === "all" ? "active" : undefined} onClick={() => setEventFilter("all")} type="button">全部</button>
            <button className={eventFilter === "warning" ? "active" : undefined} onClick={() => setEventFilter("warning")} type="button">警告</button>
            <button className={eventFilter === "error" ? "active" : undefined} onClick={() => setEventFilter("error")} type="button">错误</button>
          </div>
          <div className="k8s-event-table">
            <div className="k8s-event-row header">
              <span>时间</span>
              <span>类型</span>
              <span>对象</span>
              <span>消息</span>
            </div>
            {snapshotQuery.isLoading ? (
              <Skeleton rows={4} />
            ) : filteredEventRows.length === 0 ? (
              <EmptyState title="暂无事件" />
            ) : (
              filteredEventRows.map((event) => (
                <div className="k8s-event-row" key={event.id}>
                  <span>{event.time}</span>
                  <StatusBadge status={event.type} />
                  <span title={event.object}>{event.object}</span>
                  <strong title={event.message}>{event.message}</strong>
                </div>
              ))
            )}
          </div>
          <button className="dashboard-link-button" onClick={() => setEventFilter("all")} type="button">查看全部事件</button>
        </section>
      </div>

      <section className="infra-panel k8s-hpa-panel">
        <PanelHeader title="弹性伸缩 (HPA)" action={hpas.length ? `${hpas.length} 个` : undefined} />
        <div className="k8s-hpa-table">
          <div className="k8s-hpa-row header">
            <span>名称</span>
            <span>目标</span>
            <span>副本(当前/期望)</span>
            <span>范围</span>
            <span>指标</span>
            <span>状态</span>
          </div>
          {snapshotQuery.isLoading ? (
            <Skeleton rows={2} />
          ) : hpas.length === 0 ? (
            <EmptyState title="暂无 HPA" description="未配置 HorizontalPodAutoscaler" />
          ) : (
            hpas.map((h) => (
              <div className="k8s-hpa-row" key={`${h.namespace}/${h.name}`}>
                <strong title={`${h.namespace}/${h.name}`}>{h.name}</strong>
                <span>{h.target_kind}/{h.target_name}</span>
                <span>{h.current_replicas} / {h.desired_replicas}</span>
                <span>{h.min_replicas}–{h.max_replicas}</span>
                <span title={h.metric}>{h.metric}</span>
                <StatusBadge status={h.scaling_active ? "active" : "待命"} />
              </div>
            ))
          )}
        </div>
      </section>

      <div className="k8s-bottom-grid">
        <section className="infra-panel k8s-donut-panel">
          <PanelHeader title="命名空间资源分布" />
          {namespaceDist.length === 0 ? <EmptyState title="暂无 Pod" /> : <DistributionDonut items={namespaceDist} center={`${podCount} Pods`} />}
        </section>
        <section className="infra-panel k8s-donut-panel">
          <PanelHeader title="Pod 状态分布" />
          {podStatusDist.length === 0 ? <EmptyState title="暂无 Pod" /> : <DistributionDonut items={podStatusDist} center={`${podCount} 总数`} />}
        </section>
        <section className="infra-panel k8s-info-panel">
          <PanelHeader title="集群信息" />
          <InfoLine label="节点名称" value={nodes[0]?.name ?? "—"} />
          <InfoLine label="Kubernetes 版本" value={nodes[0]?.version ?? "—"} />
          <InfoLine label="容器运行时" value={nodes[0]?.container_runtime ?? "—"} />
          <InfoLine label="节点 OS" value={nodes[0]?.os_image ?? "—"} />
          <InfoLine label="CoreDNS" value={pods.length ? (corednsReady ? "Running" : "未就绪") : "—"} />
        </section>
      </div>

      {scaleTarget ? (
        <WorkloadScaleDrawer
          target={scaleTarget}
          hpa={hpaFor(scaleTarget.namespace, scaleTarget.name)}
          scaling={scaling}
          onClose={() => setScaleTarget(null)}
        />
      ) : null}
    </section>
  );
}

// isWritable：前端镜像后端命名空间守卫（仅用于灰显控件；后端始终强约束）。
const PROTECTED_NS = ["kube-system", "kube-public", "kube-node-lease"];
const PROTECTED_SUBSTR = ["aibrix", "envoy", "vllm", "qwen"];
function isWritable(namespace: string, name: string, allowlist: string[]): boolean {
  const ns = namespace.toLowerCase();
  const target = name.toLowerCase();
  if (PROTECTED_NS.includes(ns)) return false;
  if (PROTECTED_SUBSTR.some((p) => ns.includes(p) || target.includes(p))) return false;
  return allowlist.some((w) => w.toLowerCase() === ns);
}

function deriveWorkloads(deployments: K8sDeployment[], pods: K8sPod[]): KubernetesWorkloadRow[] {
  return deployments.map((deployment) => {
    const matched = pods.filter((pod) => pod.namespace === deployment.namespace && pod.name.startsWith(deployment.name));
    const unavailable = matched.some((pod) => pod.phase !== "Running");
    const desired = deployment.desired || matched.length || 1;
    const available = deployment.available || matched.filter((pod) => pod.phase === "Running").length;
    return {
      id: `${deployment.namespace}/${deployment.name}`,
      name: deployment.name,
      kind: "Deployment",
      namespace: deployment.namespace,
      replicas: deployment.ready || `${available}/${desired}`,
      desired,
      availability: Math.round((available / Math.max(desired, 1)) * 100),
      status: unavailable || available < desired ? "异常" : "正常",
    };
  });
}

function deriveEvents(events: K8sEvent[]) {
  return events.slice(0, 20).map((event, index) => ({
    id: `${event.namespace}/${event.resource_name}/${index}`,
    time: event.event_time ? shortTime(event.event_time) : "-",
    type: event.type,
    object: `${event.resource_kind}/${event.resource_name}`,
    message: event.message || event.reason,
  }));
}

type NodeRow = { name: string; status: string; roles: string; version: string; cpu: string; memGiB: string; podCount: number; gpu: string };

function deriveNodeRows(nodes: K8sNode[], pods: K8sPod[]): NodeRow[] {
  return nodes.map((node) => ({
    name: node.name,
    status: node.status,
    roles: node.roles,
    version: node.version,
    cpu: node.cpu_capacity || "—",
    memGiB: node.memory_bytes ? fmt(node.memory_bytes / 1024 ** 3, 1) : "—",
    podCount: pods.filter((pod) => pod.node === node.name).length,
    gpu: node.gpu_capacity || "0",
  }));
}

function deriveNamespaceDist(pods: K8sPod[]): Array<{ label: string; value: number; detail: string; tone: ResourceTone | "neutral" }> {
  if (!pods.length) return [];
  const tones: Array<ResourceTone | "neutral"> = ["info", "success", "warning", "danger", "neutral"];
  const counts = new Map<string, number>();
  for (const pod of pods) counts.set(pod.namespace || "default", (counts.get(pod.namespace || "default") ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label, value, detail: `${fmt((value / pods.length) * 100, 0)}%`, tone: tones[index % tones.length] }));
}

function derivePodStatusDist(pods: K8sPod[]): Array<{ label: string; value: number; detail: string; tone: ResourceTone | "neutral" }> {
  if (!pods.length) return [];
  const toneFor = (phase: string): ResourceTone | "neutral" =>
    phase === "Running" ? "success" : phase === "Pending" ? "warning" : phase === "Failed" ? "danger" : "neutral";
  const counts = new Map<string, number>();
  for (const pod of pods) counts.set(pod.phase || "Unknown", (counts.get(pod.phase || "Unknown") ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value, detail: `${fmt((value / pods.length) * 100, 0)}%`, tone: toneFor(label) }));
}

type ResourceMeterRow = { id: string; label: string; value: number | null; detail: string; tone: ResourceTone };

// 节点资源用量由 metrics.host（Agent 采集）+ metrics.gpu 派生；无 Agent 时显示"等待采集"。
function deriveResourceMeters(metrics: Metrics | undefined): ResourceMeterRow[] {
  const host = metrics?.host;
  const cpuCount = host?.cpu?.count || null;
  const cpuUtil = host?.cpu?.usage_percent ?? null;
  const memUtil = host?.memory?.used_percent ?? null;
  const memTotal = host?.memory?.total_bytes || null;
  const disks = host?.disk ?? [];
  const root = disks.find((d) => d.path === "/") ?? [...disks].sort((a, b) => b.total_bytes - a.total_bytes)[0];
  const gpuCount = metrics?.gpu?.length ?? 0;
  const gpuUtil = gpuCount ? Math.max(...(metrics?.gpu ?? []).map((g) => g.gpu_utilization_percent)) : null;
  const gpuStatus = metrics?.gpu_status;
  const gpuDetail = gpuCount ? `${gpuCount}×GPU` : gpuStatus?.error ? "Agent GPU 采集异常" : "等待 GPU 指标";
  const tone = (v: number | null): ResourceTone => (v == null ? "info" : v >= 90 ? "danger" : v >= 75 ? "warning" : "success");
  return [
    { id: "cpu", label: "CPU", value: cpuUtil, tone: tone(cpuUtil), detail: cpuCount && cpuUtil != null ? `${fmt((cpuCount * cpuUtil) / 100, 1)} / ${cpuCount} Core` : cpuCount ? `— / ${cpuCount} Core` : "等待 Agent 采集" },
    { id: "memory", label: "内存", value: memUtil, tone: tone(memUtil), detail: memTotal ? `${bytes(host?.memory?.used_bytes)} / ${bytes(memTotal)}` : "等待 Agent 采集" },
    { id: "storage", label: "存储", value: root?.used_percent ?? null, tone: tone(root?.used_percent ?? null), detail: root ? `${bytes(root.used_bytes)} / ${bytes(root.total_bytes)}` : "等待 Agent 采集" },
    { id: "gpu", label: "GPU", value: gpuUtil, tone: gpuStatus?.error && !gpuCount ? "warning" : tone(gpuUtil), detail: gpuDetail },
  ];
}

function ResourceMeter({ detail, label, tone, value }: { detail: string; label: string; tone: ResourceTone; value: number | null }) {
  const known = value != null && !Number.isNaN(value);
  return (
    <div className="k8s-resource-meter">
      <span>{label}</span>
      <div><i className={tone} style={{ width: known ? `${value}%` : "0%" }} /></div>
      <strong>{known ? `${fmt(value as number, 0)}%` : "—"}</strong>
      <small>{detail}</small>
    </div>
  );
}

function DistributionDonut({
  center,
  items,
}: {
  center: string;
  items: Array<{ label: string; value: number; detail: string; tone: ResourceTone | "neutral" }>;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const primary = Math.round((items[0]?.value ?? 0) / total * 100);
  return (
    <div className="k8s-distribution">
      <Donut value={primary} size={132} thickness={18} tone={items[0]?.tone === "neutral" ? "info" : items[0]?.tone ?? "info"} label={center} />
      <div className="k8s-dist-list">
        {items.map((item) => (
          <div className="k8s-dist-row" key={item.label}>
            <span className={item.tone}><i />{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="k8s-info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
