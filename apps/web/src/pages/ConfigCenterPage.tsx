import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Clock3,
  Copy,
  Eye,
  History,
  MoreVertical,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";

import { KpiGrid, PageHeader, PanelHeader } from "../components/common/PlatformPrimitives";
import { EmptyState, ErrorState, QueryBoundary, Skeleton, describeError } from "../components/common/FeedbackStates";
import { Drawer, DrawerField } from "../components/common/Drawer";
import { configSnapshot, type ConfigConsoleRow } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { fmt, relativeTime } from "../lib/format";
import { cn } from "../lib/utils";
import type { ConfigItem, ConfigVersion, ConfigVersionsResponse } from "../types/ops";
import type { KpiItem } from "../types/ui";

type AuditEventLite = { id: string; action: string; resource_id: string | null; created_at: string };

export function ConfigCenterPage() {
  const [activeItem, setActiveItem] = useState<ConfigItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const configQuery = useQuery({
    queryKey: ["config", "items"],
    queryFn: () => api<{ items: ConfigItem[] }>("/api/config/items"),
    refetchInterval: 15000
  });

  const auditQuery = useQuery({
    queryKey: ["audit", "config_item"],
    queryFn: () => api<{ events: AuditEventLite[] }>("/api/audit/events?resourceType=config_item&limit=20"),
    refetchInterval: 15000
  });

  const rows = useMemo(() => deriveConfigRows(configQuery.data?.items), [configQuery.data?.items]);
  const kpis = useMemo(() => buildConfigKpis(configQuery.data?.items), [configQuery.data?.items]);
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.name, row.key, row.namespace, row.env, row.type, row.status, row.owner]
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [rows, search]);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <section className="infra-page config-page config-replica">
      <PageHeader
        title="配置中心"
        subtitle="统一管理配置、版本与变更，保障配置安全与合规"
        actions={
          <button className="console-refresh primary" onClick={() => setCreating(true)} type="button">
            <Plus size={14} /> 新建配置项
          </button>
        }
      />

      <div className="config-process-ribbon">
        {configSnapshot.process.map((step, index) => (
          <div className={cn("config-process-step", index === 1 && "active")} key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </div>
        ))}
      </div>

      <KpiGrid className="config-kpi-strip" items={kpis} />

      <section className="infra-panel config-main-panel">
        <div className="config-tabs">
          {["配置项", "变更记录", "版本历史", "合规检查", "策略管理"].map((tab, index) => (
            <button className={index === 0 ? "active" : undefined} key={tab} type="button">{tab}</button>
          ))}
        </div>

        <div className="config-toolbar">
          <button type="button">全部命名空间</button>
          <button type="button">全部环境</button>
          <button type="button">全部类型</button>
          <label className="config-search"><Search size={14} />
            <input
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="搜索配置项名称、Key 或描述..."
              value={search}
            />
          </label>
          <button className="icon-button" onClick={() => configQuery.refetch()} type="button" title="刷新">
            <RefreshCw size={14} />
          </button>
          <button className="config-create-button" onClick={() => setCreating(true)} type="button">
            <Plus size={14} /> 新建配置项
          </button>
        </div>

        <div className="config-table">
          <div className="config-table-row header">
            <span>名称 / Key</span>
            <span>命名空间</span>
            <span>环境</span>
            <span>类型</span>
            <span>当前版本</span>
            <span>更新时间</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {configQuery.isLoading ? (
            <Skeleton rows={5} />
          ) : configQuery.isError ? (
            <ErrorState error={configQuery.error} onRetry={configQuery.refetch} />
          ) : filteredRows.length === 0 ? (
            <EmptyState title="暂无配置项" description={search ? "无匹配结果" : "点击「新建配置项」创建"} />
          ) : (
            pageRows.map((row) => (
              <ConfigTableRow item={row} key={row.id} onOpen={() => setActiveItem(row.source)} />
            ))
          )}
        </div>

        <div className="config-pagination">
          <span>共 {filteredRows.length} 项</span>
          <button disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">‹</button>
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((item) => (
            <button className={item === currentPage ? "active" : undefined} key={item} onClick={() => setPage(item)} type="button">{item}</button>
          ))}
          <button disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">›</button>
          <button type="button">10 条/页</button>
          <span className="jump">第 <strong>{currentPage}</strong> / {totalPages} 页</span>
        </div>
      </section>

      <div className="config-bottom-grid">
        <section className="infra-panel">
          <PanelHeader title="最近变更" action="审计链路" />
          <div className="config-change-list">
            {auditQuery.isLoading ? (
              <Skeleton rows={3} />
            ) : auditQuery.isError ? (
              <ErrorState error={auditQuery.error} onRetry={auditQuery.refetch} />
            ) : !auditQuery.data?.events?.length ? (
              <EmptyState title="暂无变更记录" />
            ) : (
              auditQuery.data.events.slice(0, 5).map((event) => (
                <div className="config-change-row" key={event.id}>
                  <History size={15} />
                  <div>
                    <strong>{event.action}</strong>
                    <span>{event.resource_id ?? "config_item"}</span>
                  </div>
                  <small>{relativeTime(event.created_at)}</small>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {activeItem ? <ConfigItemDrawer item={activeItem} onClose={() => setActiveItem(null)} /> : null}
      {creating ? <CreateConfigDrawer onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function ConfigTableRow({ item, onOpen }: { item: ConfigConsoleRow; onOpen: () => void }) {
  return (
    <div className="config-table-row">
      <span className="config-name-cell">
        <strong>{item.name}</strong>
        <small>{item.key}</small>
      </span>
      <span>{item.namespace}</span>
      <span><em className={cn("config-env-pill", item.env.toLowerCase())}>{item.env}</em></span>
      <span>{item.type}</span>
      <span className="config-version-cell">
        <strong>{item.version}</strong>
        <small>当前</small>
      </span>
      <span className="config-time-cell">
        <strong>{item.updatedAt}</strong>
        <small>{item.owner}</small>
      </span>
      <span><em className="config-state-pill">{item.status}</em></span>
      <span className="config-row-actions">
        <button onClick={onOpen} type="button" title="查看版本"><Eye color="#2563eb" size={14} strokeWidth={2.5} /></button>
        <button onClick={onOpen} type="button" title="复制配置"><Copy color="#2563eb" size={14} strokeWidth={2.5} /></button>
        <button onClick={onOpen} type="button" title="回滚历史"><Clock3 color="#2563eb" size={14} strokeWidth={2.5} /></button>
        <button onClick={onOpen} type="button" title="更多"><MoreVertical color="#2563eb" size={14} strokeWidth={2.5} /></button>
      </span>
    </div>
  );
}

function ConfigItemDrawer({ item, onClose }: { item: ConfigItem; onClose: () => void }) {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");

  const versionsQuery = useQuery({
    queryKey: ["config", "versions", item.id],
    queryFn: () => api<ConfigVersionsResponse>(`/api/config/items/${item.id}/versions`)
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["config", "items"] });
    qc.invalidateQueries({ queryKey: ["config", "versions", item.id] });
    qc.invalidateQueries({ queryKey: ["audit", "config_item"] });
  };

  const publishMutation = useMutation({
    mutationFn: () =>
      api(`/api/config/items/${item.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ content, change_reason: reason || "更新配置" })
      }),
    onSuccess: () => {
      toast.success("已发布新版本");
      setContent("");
      setReason("");
      invalidate();
    },
    onError: (e) => toast.error(`发布失败：${describeError(e)}`)
  });

  const rollbackMutation = useMutation({
    mutationFn: (version: number) =>
      api(`/api/config/items/${item.id}/rollback`, { method: "POST", body: JSON.stringify({ version }) }),
    onSuccess: (_d, version) => {
      toast.success(`已回滚到 v${version}`);
      invalidate();
    },
    onError: (e) => toast.error(`回滚失败：${describeError(e)}`)
  });

  return (
    <Drawer
      open
      title={item.config_key}
      subtitle={`${item.env} · ${item.namespace ?? "default"} · ${item.config_type}`}
      onClose={onClose}
    >
      <DrawerField label="活跃版本" value={`v${versionsQuery.data?.active_version ?? item.active_version}`} />

      <div className="drawer-section">
        <h4>发布新版本</h4>
        <textarea
          className="drawer-textarea"
          rows={5}
          placeholder="配置内容..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <input
          className="drawer-input"
          placeholder="变更原因"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="infra-action-btn"
          type="button"
          disabled={!content.trim() || publishMutation.isPending}
          onClick={() => publishMutation.mutate()}
        >
          {publishMutation.isPending ? "发布中..." : "发布"}
        </button>
      </div>

      <div className="drawer-section">
        <h4>历史版本</h4>
        <QueryBoundary query={versionsQuery}>
          {(data) => (
            <ul className="version-list">
              {data.versions.map((v) => (
                <VersionRow
                  key={v.version}
                  v={v}
                  active={v.version === data.active_version}
                  onRollback={() => rollbackMutation.mutate(v.version)}
                  rollingBack={rollbackMutation.isPending}
                />
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </Drawer>
  );
}

function VersionRow({
  v,
  active,
  onRollback,
  rollingBack
}: {
  v: ConfigVersion;
  active: boolean;
  onRollback: () => void;
  rollingBack: boolean;
}) {
  return (
    <li className="version-item">
      <div className="version-head">
        <strong>v{v.version}</strong>
        {active ? <em className="config-state-pill">生效</em> : null}
        <small>{v.operator ?? "-"} · {relativeTime(v.created_at)}</small>
        {!active ? (
          <button className="link-btn" type="button" disabled={rollingBack} onClick={onRollback}>
            <RotateCcw size={13} /> 回滚到此版本
          </button>
        ) : null}
      </div>
      {v.change_reason ? <p className="version-reason">{v.change_reason}</p> : null}
      {v.content ? <pre className="version-content">{v.content}</pre> : null}
    </li>
  );
}

function CreateConfigDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ config_key: "", env: "dev", namespace: "default", config_type: "yaml", content: "", change_reason: "初始化" });
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const createMutation = useMutation({
    mutationFn: () => api("/api/config/items", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: () => {
      toast.success("配置项已创建");
      qc.invalidateQueries({ queryKey: ["config", "items"] });
      qc.invalidateQueries({ queryKey: ["audit", "config_item"] });
      onClose();
    },
    onError: (e) => toast.error(`创建失败：${describeError(e)}`)
  });

  return (
    <Drawer open title="新建配置项" onClose={onClose}>
      <div className="drawer-section">
        <input className="drawer-input" placeholder="配置名（config_key）" value={form.config_key} onChange={set("config_key")} />
        <input className="drawer-input" placeholder="环境（dev/staging/prod）" value={form.env} onChange={set("env")} />
        <input className="drawer-input" placeholder="Namespace" value={form.namespace} onChange={set("namespace")} />
        <input className="drawer-input" placeholder="类型（yaml/ConfigMap/...）" value={form.config_type} onChange={set("config_type")} />
        <textarea className="drawer-textarea" rows={5} placeholder="配置内容..." value={form.content} onChange={set("content")} />
        <button
          className="infra-action-btn"
          type="button"
          disabled={!form.config_key.trim() || createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? "创建中..." : "创建"}
        </button>
      </div>
    </Drawer>
  );
}

function buildConfigKpis(items: ConfigItem[] | undefined): KpiItem[] {
  const list = items ?? [];
  const namespaces = new Set(list.map((item) => item.namespace ?? "default")).size;
  const envs = new Set(list.map((item) => item.env || "dev")).size;
  const totalVersions = list.reduce((acc, item) => acc + (item.version_count ?? 0), 0);
  const pending = list.filter((item) => String(item.status).toLowerCase().includes("pending")).length;
  const compliance = list.length ? ((list.length - pending) / list.length) * 100 : null;

  return [
    { id: "configs", label: "配置项总数", value: String(list.length), detail: "已托管", trend: [] },
    { id: "namespaces", label: "命名空间", value: String(namespaces), detail: "命名空间数", trend: [] },
    { id: "envs", label: "环境", value: String(envs), detail: "环境数", trend: [] },
    { id: "versions", label: "活跃版本", value: String(totalVersions), detail: "当前生效", trend: [], tone: "success" },
    { id: "changes", label: "待审批", value: String(pending), detail: "pending 配置", trend: [], tone: pending ? "warning" : "success" },
    { id: "compliance", label: "合规检查", value: compliance == null ? "—" : `${fmt(compliance, 1)}%`, detail: "非 pending 占比", trend: [], tone: "success" },
  ];
}

function deriveConfigRows(items: ConfigItem[] | undefined): ConfigConsoleRow[] {
  if (!items?.length) return [];
  return items.map((item) => ({
    id: item.id,
    name: item.config_key,
    key: item.config_key.includes(".") ? item.config_key : `${item.namespace ?? "default"}.${item.config_key}`,
    namespace: item.namespace ?? "default",
    env: item.env || "dev",
    type: normalizeConfigType(item.config_type),
    version: `v${item.active_version}`,
    updatedAt: formatDateTime(item.updated_at),
    owner: item.created_by ?? "system",
    status: normalizeConfigStatus(item.status),
    versionCount: item.version_count ?? 0,
    trend: [],
    source: item,
  }));
}

function normalizeConfigType(value: string) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("yaml") || lower.includes("yml")) return "YAML";
  if (lower.includes("properties")) return "Properties";
  if (lower.includes("json")) return "JSON";
  if (lower.includes("configmap")) return "ConfigMap";
  return value || "YAML";
}

function normalizeConfigStatus(value: string) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("pending") || lower.includes("draft")) return "待审批";
  if (lower.includes("disabled") || lower.includes("failed")) return "异常";
  return "生效";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const d = date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
  const t = date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${d} ${t}`;
}
