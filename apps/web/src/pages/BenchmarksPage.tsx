import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart3, Eye, MoreVertical, Play, Plus, RefreshCw, Search } from "lucide-react";

import { useGoToPage } from "../lib/useGoToPage";

import { KpiGrid, PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { describeError, EmptyState, ErrorState } from "../components/common/FeedbackStates";
import { Drawer } from "../components/common/Drawer";
import { benchmarkSnapshot, type BenchmarkTaskRow } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { fmt } from "../lib/format";
import { cn } from "../lib/utils";
import type { BenchmarkEvent } from "../types/platform";
import type { KpiItem } from "../types/ui";

const TERMINAL = new Set(["completed", "failed"]);

type BenchmarkForm = {
  endpoint_id: string;
  workload: string;
  routing_strategy: string;
  concurrency_levels: string;
  requests_per_level: string;
  max_tokens: string;
};

const defaultBenchmarkForm: BenchmarkForm = {
  endpoint_id: "auto-router",
  workload: "mixed_peak",
  routing_strategy: "least-request",
  concurrency_levels: "1,2,4,8,16,32",
  requests_per_level: "32",
  max_tokens: "256"
};

export function BenchmarksPage() {
  const [runId, setRunId] = useState("");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState("all");
  const [scenarioFilter, setScenarioFilter] = useState("all");
  const [localRows, setLocalRows] = useState<BenchmarkTaskRow[]>([]);

  const startMutation = useMutation({
    mutationFn: (form: BenchmarkForm) =>
      api<{ run_id: string }>("/api/benchmarks/serving", {
        method: "POST",
        body: JSON.stringify({
          endpoint_id: form.endpoint_id,
          workload: form.workload,
          routing_strategy: form.routing_strategy,
          concurrency_levels: parseConcurrency(form.concurrency_levels),
          requests_per_level: Number(form.requests_per_level) || 32,
          max_tokens: Number(form.max_tokens) || 256
        })
      }),
    onSuccess: (payload) => {
      setRunId(payload.run_id);
      setCreating(false);
      setPage(1);
      setLocalRows((items) => [{
        id: payload.run_id,
        name: `实时压测 ${payload.run_id.slice(0, 8)}`,
        service: "auto-router",
        version: "current",
        scenario: "Serving",
        concurrency: "运行中",
        p95: "-",
        ttft: "-",
        throughput: "-",
        errorRate: "-",
        status: "运行中",
        startedAt: "刚刚",
        tone: "info"
      }, ...items]);
      toast.success("压测已启动", { description: `Run ${payload.run_id.slice(0, 8)}` });
    },
    onError: (error) => toast.error("启动压测失败", { description: describeError(error) })
  });

  const runQuery = useQuery({
    queryKey: ["benchmark", runId],
    queryFn: () => api<Record<string, unknown> & { status?: string }>(`/api/benchmarks/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (TERMINAL.has(String(q.state.data?.status ?? "")) ? false : 2000)
  });
  const run = runQuery.data ?? null;

  const eventsQuery = useQuery({
    queryKey: ["benchmark", runId, "events"],
    queryFn: () => api<{ events: BenchmarkEvent[] }>(`/api/benchmarks/${runId}/events`),
    enabled: !!runId,
    select: (payload) => payload.events ?? [],
    refetchInterval: () => (TERMINAL.has(String(run?.status ?? "")) ? false : 2000)
  });

  const rows = useMemo(() => {
    const liveRows = deriveBenchmarkRows(eventsQuery.data);
    return [...localRows, ...liveRows];
  }, [eventsQuery.data, localRows]);
  const statusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.status))).sort(), [rows]);
  const scenarioOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.scenario))).sort(), [rows]);
  const filteredRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return rows.filter((row) =>
      (statusFilter === "all" || row.status === statusFilter) &&
      (scenarioFilter === "all" || row.scenario === scenarioFilter) &&
      (!keyword || `${row.name} ${row.service} ${row.version} ${row.scenario} ${row.status}`.toLowerCase().includes(keyword))
    );
  }, [rows, search, statusFilter, scenarioFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const kpis = useMemo(() => buildBenchmarkKpis(eventsQuery.data), [eventsQuery.data]);

  return (
    <section className="infra-page benchmarks-page benchmark-replica">
      <PageHeader
        title="压测验证"
        subtitle="SLO 门禁、性能基准对比、容量验证与回归测试"
        actions={
          <button className="console-refresh primary" disabled={startMutation.isPending} onClick={() => setCreating(true)} type="button">
            <Plus size={14} /> {startMutation.isPending ? "启动中..." : "新建压测"}
          </button>
        }
      />

      <div className="benchmark-process-ribbon">
        {benchmarkSnapshot.process.map((step, index) => (
          <div className={cn("benchmark-process-step", index === 5 && "active", index < 5 && "done")} key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </div>
        ))}
      </div>

      <KpiGrid className="benchmark-kpi-strip" items={kpis} />

      <section className="infra-panel benchmark-main-panel">
        <div className="benchmark-tabs">
          {["压测任务"].map((t) => (
            <button className="active" key={t} type="button">{t}</button>
          ))}
        </div>
        <div className="benchmark-toolbar">
          <select className="benchmark-filter" onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} value={statusFilter}>
            <option value="all">全部状态</option>
            {statusOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
          <select className="benchmark-filter" onChange={(event) => { setScenarioFilter(event.target.value); setPage(1); }} value={scenarioFilter}>
            <option value="all">全部场景</option>
            {scenarioOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
          <label className="benchmark-search-box"><Search size={14} /> <input onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }} placeholder="搜索任务名称、服务、版本..." value={search} /></label>
          <button type="button" onClick={() => runQuery.refetch()}><RefreshCw size={13} /></button>
          <button className="primary" disabled={startMutation.isPending} onClick={() => setCreating(true)} type="button">
            <Plus size={13} /> 新建压测
          </button>
        </div>
        {runId ? <div className="benchmark-run-meta">Run ID: {runId} · 状态: {String(run?.status ?? "running")}</div> : null}
        {runId && eventsQuery.isError ? (
          <ErrorState error={eventsQuery.error} onRetry={() => eventsQuery.refetch()} />
        ) : filteredRows.length === 0 ? (
          <EmptyState title="尚未发起压测" description={search ? "无匹配结果" : "点击「新建压测」对某个 endpoint 发起 serving 基准"} />
        ) : (
          <BenchmarkTable rows={pageRows} />
        )}
        <div className="benchmark-pagination">
          <span>共 {filteredRows.length} 条</span>
          <button disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">‹</button>
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((item) => (
            <button className={item === currentPage ? "active" : undefined} key={item} onClick={() => setPage(item)} type="button">{item}</button>
          ))}
          <button disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">›</button>
          <button onClick={() => { setPageSize((value) => (value === 10 ? 20 : value === 20 ? 50 : 10)); setPage(1); }} type="button">{pageSize} 条/页</button>
        </div>
      </section>

      <NewBenchmarkDrawer
        busy={startMutation.isPending}
        onClose={() => setCreating(false)}
        onSubmit={(form) => startMutation.mutate(form)}
        open={creating}
      />
    </section>
  );
}

function BenchmarkTable({ rows }: { rows: BenchmarkTaskRow[] }) {
  const goTo = useGoToPage();
  return (
    <div className="benchmark-table">
      <div className="benchmark-table-row header">
        <span>任务名称</span>
        <span>服务 / 应用</span>
        <span>版本 / 分支</span>
        <span>场景类型</span>
        <span>并发 / 用户</span>
        <span>P95 延迟</span>
        <span>TTFT</span>
        <span>吞吐量</span>
        <span>错误率</span>
        <span>状态</span>
        <span>开始时间</span>
        <span>操作</span>
      </div>
      {rows.map((row) => (
        <div className="benchmark-table-row" key={row.id}>
          <span className="benchmark-name-cell">
            <strong>{row.name}</strong>
            <small>基准对比</small>
          </span>
          <span>{row.service}</span>
          <span>{row.version}</span>
          <span>{row.scenario}</span>
          <span>{row.concurrency}</span>
          <strong className={row.p95.startsWith("8") ? "warning-text" : "success-text"}>{row.p95}</strong>
          <strong className={row.ttft.startsWith("5") ? "warning-text" : "success-text"}>{row.ttft}</strong>
          <span>{row.throughput}</span>
          <strong className={row.errorRate.startsWith("2") || row.errorRate.startsWith("1.32") ? "danger-text" : undefined}>{row.errorRate}</strong>
          <StatusBadge status={row.status} />
          <span>{row.startedAt}</span>
          <span className="benchmark-row-actions">
            <button aria-label={`${row.name} 指标`} onClick={() => goTo("observability")} title="指标" type="button"><BarChart3 color="#2563eb" size={13} strokeWidth={2.5} /></button>
            <button aria-label={`${row.name} 详情`} onClick={() => goTo("observability")} title="查看详情" type="button"><Eye color="#2563eb" size={13} strokeWidth={2.5} /></button>
            <button aria-label={`${row.name} 更多操作`} onClick={() => goTo("observability")} title="更多操作" type="button"><MoreVertical color="#2563eb" size={13} strokeWidth={2.5} /></button>
          </span>
        </div>
      ))}
    </div>
  );
}

function buildBenchmarkKpis(events: BenchmarkEvent[] | undefined): KpiItem[] {
  const list = events ?? [];
  const requestEvents = list.filter((event) => event.event_type === "request");
  const requestErrors = requestEvents.filter((event) => event.payload?.error).length;
  const latestSummary = [...list].reverse().find((item) => item.event_type === "scenario_summary")?.payload?.summary as Record<string, unknown> | undefined;
  const p95 = latestSummary?.p95_latency_seconds != null
    ? Number(latestSummary.p95_latency_seconds) * 1000
    : latestSummary?.p95_ms != null ? Number(latestSummary.p95_ms) : null;
  const ttft = latestSummary?.p95_ttft_ms != null ? Number(latestSummary.p95_ttft_ms) : null;
  const throughput = latestSummary?.output_tokens_per_second != null ? Number(latestSummary.output_tokens_per_second) : null;
  const errorRate = requestEvents.length ? (requestErrors / requestEvents.length) * 100 : null;
  return [
    { id: "tasks", label: "请求数", value: String(requestEvents.length), detail: "当前 Run", trend: [] },
    { id: "passRate", label: "通过率", value: errorRate == null ? "—" : errorRate ? `${fmt(100 - errorRate, 1)}%` : "100%", detail: "当前任务", trend: [], tone: errorRate ? "warning" : "success" },
    { id: "p95", label: "P95 延迟", value: p95 == null ? "—" : `${fmt(p95, 0)}ms`, detail: "SLO ≤ 300ms", trend: [], tone: p95 != null && p95 > 300 ? "warning" : "success" },
    { id: "ttft", label: "TTFT", value: ttft == null ? "—" : `${fmt(ttft, 0)}ms`, detail: "SLO ≤ 200ms", trend: [], tone: ttft != null && ttft > 200 ? "warning" : "success" },
    { id: "throughput", label: "吞吐量 (tokens/s)", value: throughput == null ? "—" : fmt(throughput, 0), detail: "解码吞吐", trend: [], tone: "success" },
    { id: "errorRate", label: "错误率", value: errorRate == null ? "—" : `${fmt(errorRate, 2)}%`, detail: "当前错误率", trend: [], tone: (errorRate ?? 0) > 1 ? "danger" : "success" },
  ];
}

function deriveBenchmarkRows(events: BenchmarkEvent[] | undefined): BenchmarkTaskRow[] {
  if (!events?.length) return [];
  return events.filter((event) => event.event_type === "request").slice(0, 4).map((event, index) => ({
    id: `req-${index}`,
    name: `实时请求 ${index + 1}`,
    service: "auto-router",
    version: "current",
    scenario: "Serving",
    concurrency: "实时",
    p95: event.payload?.total_ms ? `${fmt(Number(event.payload.total_ms), 0)}ms` : "-",
    ttft: event.payload?.ttft_ms ? `${fmt(Number(event.payload.ttft_ms), 0)}ms` : "-",
    throughput: String(event.payload?.output_tokens ?? "-"),
    errorRate: event.payload?.error ? "100%" : "0%",
    status: event.payload?.error ? "失败" : "通过",
    startedAt: "刚刚",
    tone: event.payload?.error ? "danger" : "success",
  }));
}

function NewBenchmarkDrawer({
  busy,
  onClose,
  onSubmit,
  open
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (form: BenchmarkForm) => void;
  open: boolean;
}) {
  const [form, setForm] = useState<BenchmarkForm>(defaultBenchmarkForm);
  if (!open) return null;
  const set = (key: keyof BenchmarkForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="新建压测"
      subtitle="提交到 /api/benchmarks/serving"
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">取消</button>
          <button className="primary-button" disabled={busy} onClick={() => onSubmit(form)} type="button">
            {busy ? "启动中..." : "启动压测"}
          </button>
        </>
      }
    >
      <div className="infra-drawer-section-title">目标与场景</div>
      <input className="drawer-input" placeholder="Endpoint ID" value={form.endpoint_id} onChange={set("endpoint_id")} />
      <select className="drawer-input" value={form.workload} onChange={set("workload")}>
        <option value="short">short</option>
        <option value="faq_short">faq_short</option>
        <option value="mixed">mixed</option>
        <option value="mixed_peak">mixed_peak</option>
        <option value="multi_turn">multi_turn</option>
        <option value="rag_shared_prefix">rag_shared_prefix</option>
        <option value="ticket_long_context">ticket_long_context</option>
        <option value="long">long</option>
      </select>
      <select className="drawer-input" value={form.routing_strategy} onChange={set("routing_strategy")}>
        <option value="least-request">least-request</option>
        <option value="round-robin">round-robin</option>
        <option value="least_queue">least_queue</option>
      </select>

      <div className="infra-drawer-section-title">压测参数</div>
      <input className="drawer-input" placeholder="并发级别，如 1,2,4,8" value={form.concurrency_levels} onChange={set("concurrency_levels")} />
      <input className="drawer-input" placeholder="每级请求数" value={form.requests_per_level} onChange={set("requests_per_level")} />
      <input className="drawer-input" placeholder="max_tokens" value={form.max_tokens} onChange={set("max_tokens")} />
    </Drawer>
  );
}

function parseConcurrency(value: string) {
  const parsed = value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length ? parsed : [1, 2, 4, 8, 16, 32];
}
