import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, BarChart3, Box, Eye, MoreVertical, Plus, RefreshCw, Route, Search } from "lucide-react";

import { KpiGrid, PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { describeError, EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { Drawer, DrawerField } from "../components/common/Drawer";
import { modelsSnapshot, type ModelRegistryRow } from "../data/platformSnapshots";
import { normalizeServiceInstance, PLATFORM_MODEL_ID } from "../data/mockPlatformData";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type { Metrics, ServiceInstance } from "../types/platform";
import type { KpiItem } from "../types/ui";

function isRouter(item: ServiceInstance): boolean {
  return item.kind === "auto_router" || item.kind === "client_round_robin" || item.kind === "aibrix" || item.routing_role === "gateway" || item.routing_role === "auto_router";
}

export function ModelsPage() {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState<string | null>(null);
  const [routeTarget, setRouteTarget] = useState<ServiceInstance | null>(null);
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [localModels, setLocalModels] = useState<ModelRegistryRow[]>([]);

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

  async function healthcheck(instance: ServiceInstance) {
    setChecking(instance.name);
    try {
      const result = await api<{ status?: string }>(`/api/service-instances/${encodeURIComponent(instance.name)}/healthcheck`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["service-instances"] });
      const status = result?.status ?? "已完成";
      if (status === "healthy") toast.success(`${instance.name} 健康检查通过`);
      else toast.warning(`${instance.name} 健康检查：${status}`);
    } catch (error) {
      toast.error(`${instance.name} 健康检查失败`, { description: describeError(error) });
    } finally {
      setChecking(null);
    }
  }

  const rows = useMemo(() => [...localModels, ...deriveModelRows(instancesQuery.data)], [instancesQuery.data, localModels]);
  const filteredRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return keyword ? rows.filter((row) => `${row.name} ${row.description} ${row.type} ${row.version}`.toLowerCase().includes(keyword)) : rows;
  }, [rows, search]);
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const kpis = useMemo(() => buildModelKpis(instancesQuery.data, metricsQuery.data), [instancesQuery.data, metricsQuery.data]);

  function registerModel(row: ModelRegistryRow) {
    setLocalModels((items) => [row, ...items]);
    setPage(1);
    setCreating(false);
    toast.success("模型已加入当前会话", { description: "Go 后端暂未提供模型注册写接口" });
  }

  return (
    <section className="infra-page models-page models-replica">
      <PageHeader
        title="模型注册"
        subtitle="统一管理模型、版本、元数据与运行时绑定"
        actions={
          <button className="console-refresh primary" onClick={() => setCreating(true)} type="button">
            <Plus size={14} /> 注册模型
          </button>
        }
      />

      <div className="models-process-ribbon">
        {modelsSnapshot.process.map((step, index) => (
          <div className={cn("models-process-step", index === 5 && "active", index < 5 && "done")} key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </div>
        ))}
      </div>

      <KpiGrid className="models-kpi-strip" items={kpis} />

      <section className="infra-panel models-main-panel">
        <div className="models-tabs">
          {["模型列表", "版本管理", "运行时绑定", "元数据管理", "合规检查"].map((tab, index) => (
            <button className={index === 0 ? "active" : undefined} key={tab} type="button">{tab}</button>
          ))}
        </div>
        <div className="models-toolbar">
          <button type="button">全部类型</button>
          <button type="button">全部状态</button>
          <button type="button">全部环境</button>
          <label className="models-search-box"><Search size={14} /> <input onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }} placeholder="搜索模型名称、描述、标签..." value={search} /></label>
          <button type="button">标签筛选</button>
          <button type="button" onClick={() => instancesQuery.refetch()}><RefreshCw size={13} /></button>
          <button className="primary" onClick={() => setCreating(true)} type="button"><Plus size={13} /> 注册模型</button>
        </div>

        <div className="models-table">
          <div className="models-table-row header">
            <span>模型名称</span>
            <span>类型</span>
            <span>最新版本</span>
            <span>状态</span>
            <span>环境</span>
            <span>质量评分</span>
            <span>运行实例</span>
            <span>更新时间</span>
            <span>操作</span>
          </div>
          {instancesQuery.isLoading && rows.length === 0 ? (
            <Skeleton rows={5} />
          ) : instancesQuery.isError && rows.length === 0 ? (
            <ErrorState error={instancesQuery.error} onRetry={instancesQuery.refetch} />
          ) : filteredRows.length === 0 ? (
            <EmptyState title="暂无模型" description={search ? "无匹配结果" : "service_instances 目录为空"} />
          ) : (
          pageRows.map((row) => (
            <div className="models-table-row" key={row.id}>
              <span className="models-name-cell">
                <Box size={16} />
                <span>
                  <strong>{row.name}</strong>
                  <small>{row.description}</small>
                </span>
              </span>
              <span><em className="models-type-pill">{row.type}</em></span>
              <span className="models-version-cell">
                <strong>{row.version}</strong>
                <small>最新</small>
              </span>
              <StatusBadge status={row.status} />
              <span>{row.env}</span>
              <span className="models-quality-cell">
                {row.quality === null ? <strong>-</strong> : <><strong>{row.quality.toFixed(1)}</strong><i style={{ width: `${row.quality}%` }} /></>}
              </span>
              <span>{row.instances}</span>
              <span>{row.updatedAt}</span>
              <span className="models-row-actions">
                <button type="button" title="查看"><Eye color="#2563eb" size={13} strokeWidth={2.5} /></button>
                <button disabled={!row.source || checking === row.source.name} onClick={() => row.source && void healthcheck(row.source)} type="button" title="健康检查">
                  <Activity color="#2563eb" size={13} strokeWidth={2.5} />
                </button>
                <button disabled={!row.source || !isRouter(row.source)} onClick={() => row.source && setRouteTarget(row.source)} type="button" title="路由策略">
                  <Route color="#2563eb" size={13} strokeWidth={2.5} />
                </button>
                <button type="button" title="趋势"><BarChart3 color="#2563eb" size={13} strokeWidth={2.5} /></button>
                <button type="button" title="更多"><MoreVertical color="#2563eb" size={13} strokeWidth={2.5} /></button>
              </span>
            </div>
          )))}
        </div>

        <div className="models-pagination">
          <span>共 {filteredRows.length} 项</span>
          <button disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">‹</button>
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((item) => (
            <button className={item === currentPage ? "active" : undefined} key={item} onClick={() => setPage(item)} type="button">{item}</button>
          ))}
          <button disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">›</button>
          <button type="button">10 条/页</button>
        </div>
      </section>

      <RoutingPolicyDrawer instance={routeTarget} onClose={() => setRouteTarget(null)} />
      <RegisterModelDrawer open={creating} onClose={() => setCreating(false)} onSubmit={registerModel} />
    </section>
  );
}

function deriveModelRows(instances: ServiceInstance[] | undefined): ModelRegistryRow[] {
  if (!instances?.length) return [];
  return instances.slice(0, 8).map((item) => ({
    id: item.name,
    name: item.name,
    description: item.kind === "vllm" ? "vLLM 推理服务模型" : item.kind === "aibrix" ? "AIBrix 网关模型绑定" : "运行时模型实例",
    type: item.model_id?.includes("embed") ? "Embedding" : "LLM",
    version: item.model_id || PLATFORM_MODEL_ID,
    status: item.status === "healthy" ? "运行中" : "告警",
    env: "prod",
    quality: null, // 质量评分暂无后端来源（待评测端点）
    instances: item.kind === "vllm" ? 1 : 0,
    updatedAt: "实时",
    source: item,
  }));
}

function buildModelKpis(instances: ServiceInstance[] | undefined, metrics: Metrics | undefined): KpiItem[] {
  const list = instances ?? [];
  const modelCount = new Set(list.map((item) => item.model_id || PLATFORM_MODEL_ID)).size;
  const healthy = list.filter((item) => item.status === "healthy").length;
  const totalInstances = metrics?.service_instances?.length ?? list.length;
  const types = new Set(list.map((item) => item.kind)).size;
  const compliance = list.length ? (healthy / list.length) * 100 : null;
  return [
    { id: "total", label: "模型总数", value: String(modelCount), detail: "已注册模型", trend: [] },
    { id: "versions", label: "活跃版本", value: String(modelCount), detail: "生产环境运行中", trend: [] },
    { id: "instances", label: "运行实例", value: String(totalInstances), detail: "绑定实例总数", trend: [] },
    { id: "types", label: "模型类型", value: String(types), detail: "Runtime 类型", trend: [] },
    { id: "compliance", label: "合规检查", value: compliance == null ? "—" : `${compliance.toFixed(1)}%`, detail: "健康占比", trend: [], tone: compliance != null && compliance < 90 ? "warning" : "success" },
  ];
}

function RoutingPolicyDrawer({ instance, onClose }: { instance: ServiceInstance | null; onClose: () => void }) {
  if (!instance) return null;
  const meta = instance.metadata ?? {};
  const strategies = Array.isArray(meta.routing_strategies)
    ? meta.routing_strategies
    : meta.routing_strategies
      ? [String(meta.routing_strategies)]
      : [];
  const kindLabel =
    instance.kind === "auto_router" ? "自动路由器"
      : instance.kind === "client_round_robin" ? "客户端轮询"
        : instance.kind === "aibrix" ? "AIBrix 网关"
          : instance.kind;
  return (
    <Drawer open={!!instance} onClose={onClose} title={instance.name} subtitle={`路由策略 · ${kindLabel}`}>
      <div className="infra-drawer-section-title">类型</div>
      <DrawerField label="kind" value={instance.kind} />
      <DrawerField label="路由角色" value={instance.routing_role || "-"} />

      <div className="infra-drawer-section-title">路由策略</div>
      {strategies.length > 0 ? (
        strategies.map((s) => <DrawerField key={s} label="strategy" value={s} />)
      ) : (
        <DrawerField label="strategy" value="未配置（使用默认 least-request）" />
      )}

      {Array.isArray(meta.candidate_endpoints) && meta.candidate_endpoints.length > 0 && (
        <>
          <div className="infra-drawer-section-title">候选 Endpoint</div>
          {meta.candidate_endpoints.map((ep) => <DrawerField key={ep} label="candidate" value={ep} />)}
        </>
      )}

      {Array.isArray(meta.target_instances) && meta.target_instances.length > 0 && (
        <>
          <div className="infra-drawer-section-title">轮询目标</div>
          {meta.target_instances.map((t) => <DrawerField key={t} label="target" value={t} />)}
        </>
      )}
    </Drawer>
  );
}

function RegisterModelDrawer({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (row: ModelRegistryRow) => void }) {
  const [form, setForm] = useState({
    name: "custom-llm",
    description: "自定义模型服务",
    type: "LLM",
    version: "v1.0.0",
    env: "prod",
    quality: "90"
  });
  if (!open) return null;
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="注册模型"
      subtitle="当前会话草稿"
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">取消</button>
          <button
            className="primary-button"
            onClick={() => onSubmit({
              id: `local-${Date.now()}`,
              name: form.name.trim() || "custom-llm",
              description: form.description.trim() || "自定义模型服务",
              type: form.type,
              version: form.version.trim() || "v1.0.0",
              status: "未发布",
              env: form.env,
              quality: Number(form.quality) || null,
              instances: 0,
              updatedAt: "刚刚"
            })}
            type="button"
          >
            保存模型
          </button>
        </>
      }
    >
      <div className="infra-drawer-section-title">基础信息</div>
      <input className="drawer-input" placeholder="模型名称" value={form.name} onChange={set("name")} />
      <input className="drawer-input" placeholder="描述" value={form.description} onChange={set("description")} />
      <select className="drawer-input" value={form.type} onChange={set("type")}>
        <option value="LLM">LLM</option>
        <option value="Embedding">Embedding</option>
        <option value="Vision">Vision</option>
        <option value="Rerank">Rerank</option>
        <option value="Classifier">Classifier</option>
      </select>
      <input className="drawer-input" placeholder="版本" value={form.version} onChange={set("version")} />
      <select className="drawer-input" value={form.env} onChange={set("env")}>
        <option value="prod">prod</option>
        <option value="staging">staging</option>
        <option value="dev">dev</option>
      </select>
      <input className="drawer-input" placeholder="质量评分" value={form.quality} onChange={set("quality")} />
    </Drawer>
  );
}
