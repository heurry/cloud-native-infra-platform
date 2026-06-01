import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle,
  Eye,
  MoreVertical,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";

import { Donut, KpiGrid, PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { describeError, EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { Drawer } from "../components/common/Drawer";
import { pipelineSnapshot, type PipelineConsoleRow } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { compactMeta, fmt, relativeTime, shortTime } from "../lib/format";
import { cn } from "../lib/utils";
import type { Deployment } from "../types/ops";
import type { KpiItem } from "../types/ui";

const RUNNING = "running";

export function PipelinesPage() {
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const qc = useQueryClient();

  const deploymentsQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: () => api<{ deployments: Deployment[] }>("/api/deployments"),
    refetchInterval: 8000
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["deployments"] });

  const finishMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "success" | "failed" }) =>
      api(`/api/deployments/${id}/finish`, { method: "POST", body: JSON.stringify({ status }) }),
    onSuccess: (_d, vars) => {
      toast.success(vars.status === "success" ? "已标记部署成功" : "已标记部署失败");
      invalidate();
    },
    onError: (e) => toast.error(`操作失败：${describeError(e)}`)
  });

  const rollbackMutation = useMutation({
    mutationFn: (id: string) => api(`/api/deployments/${id}/rollback`, { method: "POST" }),
    onSuccess: () => {
      toast.success("已触发回滚");
      invalidate();
    },
    onError: (e) => toast.error(`回滚失败：${describeError(e)}`)
  });

  const rows = useMemo(() => derivePipelineRows(deploymentsQuery.data?.deployments), [deploymentsQuery.data?.deployments]);
  const kpis = useMemo(() => buildPipelineKpis(deploymentsQuery.data?.deployments), [deploymentsQuery.data?.deployments]);
  const envDist = useMemo(() => deriveEnvDistribution(deploymentsQuery.data?.deployments), [deploymentsQuery.data?.deployments]);
  const busy = finishMutation.isPending || rollbackMutation.isPending;
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.name, row.service, row.env, row.version, row.commit, row.status, row.stage, row.trigger]
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [rows, search]);
  const pageSize = 7;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <section className="infra-page pipelines-page pipeline-replica">
      <PageHeader
        title="发布流水线"
        subtitle="自动化构建、测试、部署与回滚，保障发布质量与安全"
        actions={
          <button className="console-refresh primary" onClick={() => setCreating(true)} type="button">
            <Plus size={14} /> 新建流水线
          </button>
        }
      />

      <div className="pipeline-process-ribbon">
        {pipelineSnapshot.process.map((step, index) => (
          <div className={cn("pipeline-process-step", index === 4 && "active")} key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </div>
        ))}
      </div>

      <KpiGrid className="pipeline-kpi-strip" items={kpis} />

      <div className="pipeline-main-grid">
        <section className="infra-panel pipeline-list-panel">
          <div className="pipeline-panel-title">
            <PanelHeader title="流水线列表" action={`${filteredRows.length} 条`} />
            <div className="pipeline-toolbar">
              <button type="button">全部环境</button>
              <button type="button">全部状态</button>
              <button type="button">全部类型</button>
              <label className="pipeline-search"><Search size={14} />
                <input
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="搜索流水线名称、服务..."
                  value={search}
                />
              </label>
              <button type="button">近 7 天</button>
              <button onClick={() => deploymentsQuery.refetch()} type="button"><RefreshCw size={13} /> 刷新</button>
              <button className="primary" onClick={() => setCreating(true)} type="button"><Plus size={13} /> 新建流水线</button>
            </div>
          </div>

          <div className="pipeline-table">
            <div className="pipeline-table-row header">
              <span>流水线名称</span>
              <span>环境</span>
              <span>版本 / 提交</span>
              <span>状态</span>
              <span>当前阶段</span>
              <span>耗时</span>
              <span>操作</span>
            </div>
            {deploymentsQuery.isLoading ? (
              <Skeleton rows={5} />
            ) : deploymentsQuery.isError ? (
              <ErrorState error={deploymentsQuery.error} onRetry={deploymentsQuery.refetch} />
            ) : filteredRows.length === 0 ? (
              <EmptyState title="暂无流水线" description={search ? "无匹配结果" : "点击「新建流水线」触发一次部署"} />
            ) : (
              pageRows.map((row) => (
                <PipelineTableRow
                  busy={busy}
                  key={row.id}
                  onFinish={(status) => finishMutation.mutate({ id: row.source.id, status })}
                  onRollback={() => rollbackMutation.mutate(row.source.id)}
                  row={row}
                />
              ))
            )}
          </div>

          <div className="pipeline-pagination">
            <span>共 {filteredRows.length} 条</span>
            <button disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">‹</button>
            {Array.from({ length: totalPages }, (_, index) => index + 1).map((item) => (
              <button className={item === currentPage ? "active" : undefined} key={item} onClick={() => setPage(item)} type="button">{item}</button>
            ))}
            <button disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">›</button>
            <button type="button">10 条/页</button>
          </div>
        </section>

        <aside className="pipeline-side-stack">
          <section className="infra-panel">
            <PanelHeader title="环境分布" action={`${envDist.total} 条`} />
            {envDist.items.length === 0 ? (
              <EmptyState title="暂无部署" />
            ) : (
              <div className="pipeline-donut-block">
                <Donut value={envDist.total} max={envDist.total || 1} size={124} thickness={20} tone="info" label={`${envDist.total} 总流水线`} />
                <div className="pipeline-dist-list">
                  {envDist.items.map((item) => (
                    <div className={item.tone} key={item.label}>
                      <span><i />{item.label}</span>
                      <strong>{item.value}</strong>
                      <small>{item.percent}</small>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>

      {creating ? <TriggerDeployDrawer onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function PipelineTableRow({
  row,
  onFinish,
  onRollback,
  busy,
}: {
  row: PipelineConsoleRow;
  onFinish: (status: "success" | "failed") => void;
  onRollback: () => void;
  busy: boolean;
}) {
  const isRunning = normalizeStatus(row.source.status) === RUNNING || row.status === "运行中";
  return (
    <div className="pipeline-table-row">
      <span className="pipeline-name-cell">
        <i className={cn("pipeline-status-dot", row.tone)} />
        <span>
          <strong>{row.name}</strong>
          <small>{row.service}</small>
        </span>
      </span>
      <span><em className={cn("pipeline-env-pill", row.env.toLowerCase())}>{row.env}</em></span>
      <span className="pipeline-version-cell">
        <strong>{row.version}</strong>
        <small>{row.commit}</small>
      </span>
      <span className="pipeline-status-cell">
        <StatusBadge status={row.status} />
        <small>{row.stageMeta}</small>
      </span>
      <span className="pipeline-stage-cell">
        <strong>{row.stage}</strong>
        {isRunning ? <em /> : null}
      </span>
      <span>{row.duration}</span>
      <span className="pipeline-row-actions">
        <button type="button" title="查看详情"><Eye color="#2563eb" size={14} strokeWidth={2.5} /></button>
        {isRunning ? (
          <>
            <button disabled={busy} onClick={() => onFinish("success")} type="button" title="标记成功"><CheckCircle color="#2563eb" size={14} strokeWidth={2.5} /></button>
            <button disabled={busy} onClick={() => onFinish("failed")} type="button" title="标记失败"><XCircle color="#2563eb" size={14} strokeWidth={2.5} /></button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={onRollback} type="button" title="回滚"><RotateCcw color="#2563eb" size={14} strokeWidth={2.5} /></button>
            <button type="button" title="更多"><MoreVertical color="#2563eb" size={14} strokeWidth={2.5} /></button>
          </>
        )}
      </span>
    </div>
  );
}

function TriggerDeployDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", version: "latest", env: "prod", image: "", branch: "main", gate: "approved", owner: "system" });
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const triggerMutation = useMutation({
    mutationFn: () => api("/api/deployments", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: () => {
      toast.success("部署已触发");
      qc.invalidateQueries({ queryKey: ["deployments"] });
      onClose();
    },
    onError: (e) => toast.error(`触发失败：${describeError(e)}`)
  });

  return (
    <Drawer open title="触发部署" subtitle="创建一次新的发布流水线" onClose={onClose}>
      <div className="drawer-section">
        <input className="drawer-input" placeholder="服务名" value={form.name} onChange={set("name")} />
        <input className="drawer-input" placeholder="版本" value={form.version} onChange={set("version")} />
        <input className="drawer-input" placeholder="环境（dev/staging/prod）" value={form.env} onChange={set("env")} />
        <input className="drawer-input" placeholder="镜像" value={form.image} onChange={set("image")} />
        <input className="drawer-input" placeholder="分支" value={form.branch} onChange={set("branch")} />
        <input className="drawer-input" placeholder="门禁" value={form.gate} onChange={set("gate")} />
        <input className="drawer-input" placeholder="Owner" value={form.owner} onChange={set("owner")} />
        <button
          className="infra-action-btn"
          type="button"
          disabled={!form.name.trim() || triggerMutation.isPending}
          onClick={() => triggerMutation.mutate()}
        >
          {triggerMutation.isPending ? "触发中..." : "触发部署"}
        </button>
      </div>
    </Drawer>
  );
}

function buildPipelineKpis(deployments: Deployment[] | undefined): KpiItem[] {
  const list = deployments ?? [];
  const running = list.filter((item) => normalizeStatus(item.status) === RUNNING).length;
  const success = list.filter((item) => normalizeStatus(item.status) === "success").length;
  const failed = list.filter((item) => normalizeStatus(item.status) === "failed").length;
  const finished = success + failed;
  const successRate = finished ? (success / finished) * 100 : null;
  const durations = list
    .filter((item) => item.started_at && item.finished_at)
    .map((item) => (new Date(item.finished_at as string).getTime() - new Date(item.started_at as string).getTime()) / 1000)
    .filter((seconds) => seconds >= 0);
  const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  return [
    { id: "pipelines", label: "流水线总数", value: String(list.length), detail: `活跃 ${running}`, trend: [] },
    { id: "deploys", label: "部署次数", value: String(list.length), detail: successRate == null ? "暂无完成" : `${fmt(successRate, 0)}% 成功`, trend: [], tone: "success" },
    { id: "success", label: "变更成功率", value: successRate == null ? "—" : `${fmt(successRate, 1)}%`, detail: finished ? `已完成 ${finished} 次` : "暂无完成记录", trend: [], tone: successRate != null && successRate < 95 ? "warning" : "success" },
    { id: "duration", label: "平均部署时长", value: avgDuration == null ? "—" : formatDuration(avgDuration), detail: durations.length ? `${durations.length} 次完成` : "暂无耗时数据", trend: [], tone: "success" },
    { id: "rollback", label: "失败次数", value: String(failed), detail: failed ? "需要关注" : "无失败", trend: [], tone: failed ? "warning" : "success" },
  ];
}

function deriveEnvDistribution(deployments: Deployment[] | undefined): { total: number; items: Array<{ label: string; value: number; percent: string; tone: string }> } {
  const list = deployments ?? [];
  const counts = new Map<string, number>();
  for (const item of list) counts.set(item.env || "unknown", (counts.get(item.env || "unknown") ?? 0) + 1);
  const total = list.length;
  const tones = ["info", "success", "warning", "ai", "neutral"];
  return {
    total,
    items: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], index) => ({ label, value, percent: total ? `${Math.round((value / total) * 100)}%` : "0%", tone: tones[index % tones.length] })),
  };
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
}

function derivePipelineRows(deployments: Deployment[] | undefined): PipelineConsoleRow[] {
  if (!deployments?.length) return [];
  return deployments.map((item) => {
    const status = statusLabel(item.status);
    const normalized = normalizeStatus(item.status);
    const version = item.version ?? "latest";
    const service = item.name || "deployment";
    return {
      id: item.id,
      name: `${service} 发布`,
      service,
      env: item.env ?? "prod",
      version,
      commit: compactMeta([item.metadata.branch, item.metadata.gate]) || "-",
      status,
      stage: normalized === RUNNING ? "部署中" : normalized === "failed" ? "测试失败" : "已完成",
      stageMeta: normalized === RUNNING ? "Rolling Update" : normalized === "failed" ? "Test Failed" : "Deployed",
      trigger: item.metadata.owner ?? "system",
      startedAt: item.started_at ? shortTime(item.started_at) : "-",
      duration: item.finished_at && item.started_at ? relativeTime(item.started_at) : "进行中",
      tone: normalized === "failed" ? "danger" : normalized === RUNNING ? "warning" : normalized === "success" ? "success" : "neutral",
      source: item,
    };
  });
}

function normalizeStatus(value: string) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("run") || lower.includes("progress") || lower.includes("deploy")) return RUNNING;
  if (lower.includes("fail") || lower.includes("error")) return "failed";
  if (lower.includes("cancel")) return "cancelled";
  return "success";
}

function statusLabel(value: string) {
  const normalized = normalizeStatus(value);
  if (normalized === RUNNING) return "运行中";
  if (normalized === "failed") return "失败";
  if (normalized === "cancelled") return "已取消";
  return "成功";
}
