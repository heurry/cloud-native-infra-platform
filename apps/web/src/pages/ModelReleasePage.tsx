import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { parse, stringify } from "yaml";
import { AlertTriangle, CheckCircle2, Circle, Code2, ExternalLink, RefreshCw, Rocket, Server, SlidersHorizontal, Square } from "lucide-react";

import { describeError, EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { api, listModelRegistry } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useGoToPage } from "../lib/useGoToPage";
import { useDeliveryContext } from "../lib/useDeliveryContext";
import type { Deployment } from "../types/ops";
import type { ServiceInstance } from "../types/platform";
import { PipelinesPage } from "./PipelinesPage";

type ReleaseCandidate = {
  profile: string;
  label: string;
  description: string;
  available: boolean;
  gate_passed: boolean;
  run_id?: string;
  scenarios: number;
  min_success_rate: number;
  min_quality_rate: number;
  average_p95_ttft_ms: number;
  average_p95_tpot_ms: number;
  average_output_tokens_per_second: number;
  max_p95_ttft_ms: number;
  max_p95_tpot_ms: number;
  slo_ttft_limit_ms: number;
  slo_tpot_limit_ms: number;
  max_num_seqs: number;
  max_num_batched_tokens: number;
  error?: string;
};

type ReleaseState = {
  model_id: string;
  endpoint_id: string;
  candidates: ReleaseCandidate[];
  requested_candidate?: ReleaseCandidate;
  runtime: { status?: string; profile?: string; endpoint?: string; config?: Record<string, unknown>; error?: string };
  progress: {
    active_stage: string;
    weight_percent?: number;
    stages: Array<{ key: string; label: string; state: "pending" | "active" | "complete"; detail?: string }>;
  };
};

type RuntimeForm = {
  parallelism: "tp2" | "pp2";
  maxNumSeqs: number;
  maxNumBatchedTokens: number;
  schedulingPolicy: "fcfs" | "priority";
  prefixCaching: boolean;
  asyncScheduling: boolean;
  gpuMemoryUtilization: number;
  maxModelLen: number;
  kvCacheDType: "auto" | "fp8";
};

type BenchmarkRun = {
  run_id: string;
  status: string;
  endpoint_id?: string;
  config?: { vllm?: Record<string, unknown> };
};

const DEFAULT_RUNTIME: RuntimeForm = {
  parallelism: "tp2",
  maxNumSeqs: 8,
  maxNumBatchedTokens: 4096,
  schedulingPolicy: "fcfs",
  prefixCaching: true,
  asyncScheduling: true,
  gpuMemoryUtilization: 0.9,
  maxModelLen: 4096,
  kvCacheDType: "auto",
};

export function ModelReleasePage({ initialTab = "model" }: { initialTab?: "model" | "pipeline" }) {
  const qc = useQueryClient();
  const goTo = useGoToPage();
  const { context, update } = useDeliveryContext();
  const [versionID, setVersionID] = useState("");
  const [env, setEnv] = useState("prod");
  const [approved, setApproved] = useState(false);
  const [centerTab, setCenterTab] = useState<"model" | "pipeline">(initialTab);
  const [configMode, setConfigMode] = useState<"form" | "yaml">("form");
  const [runtimeForm, setRuntimeForm] = useState<RuntimeForm>(DEFAULT_RUNTIME);
  const [yamlDraft, setYamlDraft] = useState("");
  const [yamlError, setYamlError] = useState("");
  const [yamlDirty, setYamlDirty] = useState(false);
  const hydratedRun = useRef("");

  const runtimeRequest = useMemo(() => runtimeRequestFromForm(runtimeForm), [runtimeForm]);
  const releaseQuery = useMemo(() => {
    const params = new URLSearchParams({
      max_num_seqs: String(runtimeForm.maxNumSeqs),
      max_num_batched_tokens: String(runtimeForm.maxNumBatchedTokens),
      prefix_caching: String(runtimeForm.prefixCaching),
    });
    if (context.benchmarkRunId) params.set("benchmark_run_id", context.benchmarkRunId);
    return params.toString();
  }, [context.benchmarkRunId, runtimeForm.maxNumBatchedTokens, runtimeForm.maxNumSeqs, runtimeForm.prefixCaching]);

  const registry = useQuery({ queryKey: ["model-registry"], queryFn: listModelRegistry, refetchInterval: 10000 });
  const releases = useQuery({ queryKey: ["inference", "releases", releaseQuery], queryFn: () => api<ReleaseState>(`/api/inference/releases?${releaseQuery}`), refetchInterval: 5000 });
  const benchmarkRun = useQuery({
    queryKey: ["benchmark", "release", context.benchmarkRunId],
    queryFn: () => api<BenchmarkRun>(`/api/benchmarks/${encodeURIComponent(context.benchmarkRunId!)}`),
    enabled: Boolean(context.benchmarkRunId),
  });
  const deployments = useQuery({ queryKey: ["deployments"], queryFn: () => api<{ deployments: Deployment[] }>("/api/deployments"), refetchInterval: 5000 });
  const instances = useQuery({ queryKey: ["service-instances"], queryFn: () => api<{ instances: ServiceInstance[] }>("/api/service-instances"), refetchInterval: 10000 });

  const releaseModelID = releases.data?.model_id || "qwen36-27b-fp8";
  const benchmarkModelID = modelIDFromEndpoint(benchmarkRun.data?.endpoint_id);
  const benchmarkModelMatches = !benchmarkModelID || benchmarkModelID === releaseModelID;
  const versions = useMemo(() => (registry.data?.versions ?? []).filter((item) => item.model_id === releaseModelID), [registry.data, releaseModelID]);
  useEffect(() => {
    if (context.modelVersionId && versions.some((item) => item.id === context.modelVersionId)) {
      if (versionID !== context.modelVersionId) setVersionID(context.modelVersionId);
      return;
    }
    if (!versionID && versions[0]) setVersionID(versions.find((item) => item.status === "serving")?.id ?? versions[0].id);
  }, [context.modelVersionId, versionID, versions]);
  const selected = versions.find((item) => item.id === versionID);
  const candidate = releases.data?.requested_candidate ?? releases.data?.candidates.find((item) =>
    runtimeForm.prefixCaching && item.max_num_seqs === runtimeForm.maxNumSeqs && item.max_num_batched_tokens === runtimeForm.maxNumBatchedTokens
  );
  const recent = useMemo(() => (deployments.data?.deployments ?? []).filter((item) => item.metadata.mode === "inference_runtime").slice(0, 8), [deployments.data]);
  const latest = recent[0];
  const runtimeStatus = releases.data?.runtime.status ?? "unknown";
  const runtimeActive = runtimeStatus === "ready" || runtimeStatus === "starting";
  const activeBindings = selected ? (registry.data?.bindings[selected.model_id] ?? []) : [];
  const generatedYAML = useMemo(() => stringify(releaseSpec(versionID, env, runtimeRequest)), [env, runtimeRequest, versionID]);

  const updateRuntime = <K extends keyof RuntimeForm,>(key: K, value: RuntimeForm[K]) => {
    setRuntimeForm((current) => ({ ...current, [key]: value }));
    setApproved(false);
    setYamlDraft("");
    setYamlError("");
    setYamlDirty(false);
  };

  const applyTemplate = (next: RuntimeForm) => {
    setRuntimeForm(next);
    setApproved(false);
    setYamlDraft("");
    setYamlError("");
    setYamlDirty(false);
  };

  const applyBenchmarkConfig = () => {
    const vllm = benchmarkRun.data?.config?.vllm;
    if (!vllm) return;
    setRuntimeForm((current) => runtimeFormFromBenchmark(vllm, current));
    setApproved(false);
    setYamlDraft("");
    setYamlError("");
    setYamlDirty(false);
  };

  useEffect(() => {
    const runID = benchmarkRun.data?.run_id;
    if (!runID || hydratedRun.current === runID || !benchmarkRun.data?.config?.vllm) return;
    hydratedRun.current = runID;
    applyBenchmarkConfig();
  // 只在交付上下文切换到新的 Run 时自动回填；随后允许人工调整并触发“不匹配”门禁。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchmarkRun.data?.run_id]);

  const applyYAML = () => {
    try {
      const parsed = parse(yamlDraft || generatedYAML) as Record<string, unknown>;
      const next = runtimeFormFromSpec(parsed);
      setRuntimeForm(next.runtime);
      if (next.modelVersionID) setVersionID(next.modelVersionID);
      if (next.env) setEnv(next.env);
      setYamlError("");
      setYamlDirty(false);
      setApproved(false);
      toast.success("YAML 已校验并应用到发布参数");
    } catch (error) {
      const message = error instanceof Error ? error.message : "YAML 格式无效";
      setYamlError(message);
      toast.error("YAML 校验失败", { description: message });
    }
  };

  const release = useMutation({
    mutationFn: () => api<{ id: string; status: string }>("/api/inference/releases", {
      method: "POST",
      body: JSON.stringify({
        model_version_id: versionID,
        runtime_request: runtimeRequest,
        release_spec: yamlDraft || generatedYAML,
        benchmark_run_id: candidate?.run_id || context.benchmarkRunId || "",
        env,
        operator: "frontend",
      }),
    }),
    onSuccess: (payload) => {
      toast.success("发布任务已提交", { description: "正在启动并检查 vLLM OpenAI-Compatible endpoint" });
      setApproved(false);
      update({
        deliveryKind: "inference",
        modelId: selected?.model_id || releaseModelID,
        modelVersionId: versionID,
        benchmarkRunId: candidate?.run_id || context.benchmarkRunId,
        deploymentId: payload.id,
        trainingJobId: null,
      });
      qc.invalidateQueries({ queryKey: ["deployments"] });
      qc.invalidateQueries({ queryKey: ["inference", "releases"] });
    },
    onError: (error) => toast.error("发布失败", { description: describeError(error) }),
  });

  const stop = useMutation({
    mutationFn: () => api<{ status: string }>(`/api/inference/releases/${latest?.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("生产推理服务已下线");
      qc.invalidateQueries({ queryKey: ["deployments"] });
      qc.invalidateQueries({ queryKey: ["inference", "releases"] });
      qc.invalidateQueries({ queryKey: ["model-registry"] });
    },
    onError: (error) => toast.error("下线失败", { description: describeError(error) }),
  });

  const evidenceMatches = !context.benchmarkRunId || (benchmarkModelMatches && candidate?.run_id === context.benchmarkRunId);
  const hardReady = Boolean(selected && selected.status !== "deprecated" && candidate?.gate_passed && evidenceMatches && approved && !yamlDirty && !yamlError && !release.isPending);

  return (
    <section className="infra-page release-page">
      <PageHeader
        title="发布中心"
        subtitle="统一管理通用服务 CI/CD、模型推理发布、发布门禁、上线进度、发布记录和回滚"
        actions={centerTab === "model" ? <button className="console-refresh" type="button" onClick={() => { registry.refetch(); releases.refetch(); deployments.refetch(); instances.refetch(); }}><RefreshCw size={14} /> 刷新</button> : null}
      />

      <div className="release-center-tabs" role="tablist" aria-label="发布中心工作区">
        <button aria-selected={centerTab === "model"} className={centerTab === "model" ? "active" : ""} onClick={() => setCenterTab("model")} role="tab" type="button">模型服务发布</button>
        <button aria-selected={centerTab === "pipeline"} className={centerTab === "pipeline" ? "active" : ""} onClick={() => setCenterTab("pipeline")} role="tab" type="button">通用服务 CI/CD</button>
      </div>

      <div className="release-center-explainer">
        {centerTab === "model"
          ? "模型服务发布：选择已注册模型和 GPU 运行参数，必须绑定同参数压测证据，通过质量/SLO 门禁后启动 vLLM，并提供稳定的 OpenAI-Compatible API。"
          : "通用服务 CI/CD：从 GitLab 源码触发构建、测试、镜像和 Kubernetes 部署，适用于控制面、网关及普通微服务；它不替代模型性能验收。"}
      </div>

      {centerTab === "pipeline" ? <PipelinesPage embedded /> : <>

      <div className="delivery-flow" aria-label="模型交付链路">
        {["推理模型版本", "运行时配置", "压测验收", "生产发布", "服务观测", "故障诊断"].map((label, index) => (
          <button type="button" key={label} onClick={() => goTo((["models", "config", "benchmarks", "release", "observability", "aiOps"] as const)[index])}>
            <span>{index + 1}</span><strong>{label}</strong>
          </button>
        ))}
      </div>

      <section className="infra-panel release-progress-panel" aria-live="polite">
        <PanelHeader title="发布进度" action={latest ? `${latest.metadata.phase ?? latest.status} · ${relativeTime(latest.started_at)}` : "等待首次发布"} />
        <div className="release-progress-track">
          {(releases.data?.progress?.stages ?? []).map((stage, index) => {
            const Icon = stage.state === "complete" ? CheckCircle2 : Circle;
            const weightProgress = stage.key === "weights" && stage.state === "active" ? releases.data?.progress?.weight_percent : undefined;
            return <div className={`release-progress-step ${stage.state}`} key={stage.key}>
              <div className="release-progress-marker"><Icon size={16} /><span>{index + 1}</span></div>
              <div><strong>{stage.label}</strong><small>{stage.detail || (stage.state === "pending" ? "等待前序阶段" : "处理中")}</small></div>
              {weightProgress !== undefined ? <div className="release-weight-progress" role="progressbar" aria-label="模型权重加载进度" aria-valuenow={weightProgress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${weightProgress}%` }} /></div> : null}
            </div>;
          })}
        </div>
        {latest?.metadata.events?.length ? <div className="release-progress-events">
          {latest.metadata.events.slice(-4).map((event) => <div key={`${event.at}-${event.phase}`}><time>{event.at.slice(11, 19)}</time><StatusBadge status={event.phase} /><span>{releaseEventMessage(event.phase, event.message)}</span></div>)}
        </div> : <p className="release-progress-empty">提交发布后，这里会显示容器创建、权重加载、编译和健康检查状态。</p>}
      </section>

      <div className="release-main-grid">
        <section className="infra-panel release-control-panel">
          <PanelHeader title="发布配置" action="受控 vLLM 生产运行时" />
          {registry.isLoading || releases.isLoading ? <Skeleton rows={5} /> : registry.isError ? <ErrorState error={registry.error} onRetry={registry.refetch} /> : releases.isError ? <ErrorState error={releases.error} onRetry={releases.refetch} /> : versions.length === 0 ? (
            <EmptyState title="暂无 Qwen3.6-27B-FP8 版本" description="请先在模型与版本中心注册推理模型" />
          ) : (
            <div className="release-form">
              <label>模型版本<select value={versionID} onChange={(event) => {
                const nextID = event.target.value;
                const next = versions.find((item) => item.id === nextID);
                setVersionID(nextID);
                update({ deliveryKind: "inference", modelId: next?.model_id || releaseModelID, modelVersionId: nextID });
              }}>{versions.map((item) => <option key={item.id} value={item.id}>{item.model_id} · {item.version} · {item.status}</option>)}</select></label>
              <div className="release-version-info"><strong>{selected?.model_id} · {selected?.version}</strong><span>{selected?.base_model || "未登记基座模型"}</span><small>版本 ID：{selected?.id}</small></div>

              <div className="release-config-heading">
                <div><strong>运行时配置</strong><small>模板仅用于快速填充，最终发布值由参数表单或 YAML 决定</small></div>
                <div className="release-template-actions">
                  <button type="button" onClick={() => applyTemplate(DEFAULT_RUNTIME)}>稳定起点</button>
                  <button type="button" onClick={() => applyTemplate({ ...DEFAULT_RUNTIME, maxNumSeqs: 16, maxNumBatchedTokens: 8192 })}>高并发示例</button>
                </div>
              </div>
              <div className="release-config-mode" role="tablist" aria-label="发布配置编辑方式">
                <button aria-selected={configMode === "form"} className={configMode === "form" ? "active" : ""} onClick={() => setConfigMode("form")} role="tab" type="button"><SlidersHorizontal size={13} /> 参数配置</button>
                <button aria-selected={configMode === "yaml"} className={configMode === "yaml" ? "active" : ""} onClick={() => { setConfigMode("yaml"); if (!yamlDraft) setYamlDraft(generatedYAML); }} role="tab" type="button"><Code2 size={13} /> YAML 配置</button>
              </div>

              {configMode === "form" ? <div className="release-runtime-grid">
                <label>并行方式<select value={runtimeForm.parallelism} onChange={(event) => updateRuntime("parallelism", event.target.value as RuntimeForm["parallelism"])}><option value="tp2">TP=2 / PP=1</option><option value="pp2">TP=1 / PP=2</option></select></label>
                <label>最大并发序列<select value={runtimeForm.maxNumSeqs} onChange={(event) => updateRuntime("maxNumSeqs", Number(event.target.value) as RuntimeForm["maxNumSeqs"])}>{[8, 12, 16, 24, 32].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label>批处理 Token 预算<select value={runtimeForm.maxNumBatchedTokens} onChange={(event) => updateRuntime("maxNumBatchedTokens", Number(event.target.value) as RuntimeForm["maxNumBatchedTokens"])}>{[2048, 4096, 8192].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label>调度策略<select value={runtimeForm.schedulingPolicy} onChange={(event) => updateRuntime("schedulingPolicy", event.target.value as RuntimeForm["schedulingPolicy"])}><option value="fcfs">FCFS</option><option value="priority">Priority</option></select></label>
                <label>GPU 显存比例<select value={runtimeForm.gpuMemoryUtilization} onChange={(event) => updateRuntime("gpuMemoryUtilization", Number(event.target.value) as RuntimeForm["gpuMemoryUtilization"])}>{[0.85, 0.9, 0.92].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label>最大模型长度<select value={runtimeForm.maxModelLen} onChange={(event) => updateRuntime("maxModelLen", Number(event.target.value) as RuntimeForm["maxModelLen"])}><option value={3072}>3072</option><option value={4096}>4096</option></select></label>
                <label>KV Cache 类型<select value={runtimeForm.kvCacheDType} onChange={(event) => updateRuntime("kvCacheDType", event.target.value as RuntimeForm["kvCacheDType"])}><option value="auto">auto</option><option value="fp8">fp8</option></select></label>
                <label className="release-runtime-toggle"><input checked={runtimeForm.prefixCaching} onChange={(event) => updateRuntime("prefixCaching", event.target.checked)} type="checkbox" />启用 Prefix Cache</label>
                <label className="release-runtime-toggle"><input checked={runtimeForm.asyncScheduling} onChange={(event) => updateRuntime("asyncScheduling", event.target.checked)} type="checkbox" />启用异步调度</label>
              </div> : <div className="release-yaml-editor">
                <textarea aria-label="推理发布 YAML" spellCheck={false} value={yamlDraft || generatedYAML} onChange={(event) => { setYamlDraft(event.target.value); setYamlError(""); setYamlDirty(true); setApproved(false); }} />
                <div><button type="button" onClick={() => { setYamlDraft(generatedYAML); setYamlDirty(false); setYamlError(""); }}>从当前参数重新生成</button><button className="primary" type="button" onClick={applyYAML}>校验并应用 YAML</button></div>
                {yamlError ? <p className="release-yaml-error">{yamlError}</p> : null}
                {yamlDirty && !yamlError ? <p className="release-yaml-pending">YAML 已修改，请先“校验并应用”再提交发布。</p> : null}
              </div>}

              <p className="release-config-note">压测证据按 Prefix Cache、max_num_seqs 和 max_num_batched_tokens 匹配；完整运行参数和 YAML 会写入发布记录与审计事件。</p>

              {candidate ? <div className="release-evidence-strip">
                <div><small>验证场景</small><strong>{candidate.scenarios}</strong></div>
                <div><small>最低成功率</small><strong>{percent(candidate.min_success_rate)}</strong></div>
                <div><small>平均 P95 TTFT</small><strong>{milliseconds(candidate.average_p95_ttft_ms)}</strong></div>
                <div><small>平均 P95 TPOT</small><strong>{milliseconds(candidate.average_p95_tpot_ms)}</strong></div>
                <div><small>平均吞吐</small><strong>{candidate.average_output_tokens_per_second.toFixed(1)} tok/s</strong></div>
              </div> : null}

              {!benchmarkModelMatches ? <div className="release-context-warning"><AlertTriangle size={15} /><span>Run {context.benchmarkRunId?.slice(0, 12)} 验收的是 {benchmarkModelID}，当前发布通道是 {releaseModelID}；不同权重的证据不能混用。</span><button type="button" onClick={() => goTo("benchmarks", { deliveryKind: "inference", modelId: releaseModelID, benchmarkRunId: null })}>验收当前模型</button></div> : !evidenceMatches ? <div className="release-context-warning"><AlertTriangle size={15} /><span>Run {context.benchmarkRunId?.slice(0, 12)} 的验收参数与当前表单不一致，不能用另一组参数的证据发布。</span>{benchmarkRun.data?.config?.vllm ? <button type="button" onClick={applyBenchmarkConfig}>应用该 Run 参数</button> : <button type="button" onClick={() => goTo("benchmarks")}>重新验收</button>}</div> : null}

              <label>发布环境<select value={env} onChange={(event) => setEnv(event.target.value)}><option value="staging">staging</option><option value="prod">prod</option></select></label>
              <label className="release-approval"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>我已核对模型版本、压测 run、参数和 YAML，确认占用双卡启动生产服务</span></label>
              <button className="release-submit" disabled={!hardReady} type="button" onClick={() => release.mutate()}><Rocket size={15} />{release.isPending ? "正在提交..." : runtimeActive ? "滚动更新生产配置" : "发布到生产运行时"}</button>
              <p className="release-note">控制面校验参数与压测证据后启动受控 vLLM workload，轮询 `/v1/models` 健康状态；失败时自动恢复上一运行时。</p>
            </div>
          )}
        </section>

        <aside className="release-gates">
          <section className="infra-panel">
            <PanelHeader title="发布门禁" action={candidate?.gate_passed ? "允许人工审批" : "存在未通过项"} />
            <Gate passed={Boolean(selected && selected.model_id === "qwen36-27b-fp8" && selected.status !== "deprecated")} title="模型与通道匹配" detail={selected ? `${selected.model_id} · ${selected.status}` : "未选择版本"} />
            <Gate passed={Boolean(candidate?.available)} title="参数证据匹配" detail={candidate?.run_id ? `${candidate.run_id.slice(0, 8)} · seqs ${candidate.max_num_seqs} · tokens ${candidate.max_num_batched_tokens}` : candidate?.error || "无匹配压测"} />
            <Gate passed={Boolean(candidate?.gate_passed)} title="成功率与输出质量" detail={candidate ? `${percent(candidate.min_success_rate)} / ${percent(candidate.min_quality_rate)}，共 ${candidate.scenarios} 个场景` : "等待证据"} />
            <Gate passed={Boolean(candidate && candidate.max_p95_ttft_ms <= candidate.slo_ttft_limit_ms && candidate.max_p95_tpot_ms <= candidate.slo_tpot_limit_ms)} title="推理 SLO 门禁" detail={candidate ? `最差 TTFT ${milliseconds(candidate.max_p95_ttft_ms)} / TPOT ${milliseconds(candidate.max_p95_tpot_ms)}` : "等待证据"} />
            <Gate passed={activeBindings.length > 0} soft title="OpenAI-Compatible 绑定" detail={activeBindings.length ? `${activeBindings.length} 个固定 endpoint` : "没有服务绑定"} />
            {!candidate?.gate_passed ? <button className="release-link" type="button" onClick={() => goTo("benchmarks")}>前往推理服务控制面 <ExternalLink size={13} /></button> : null}
          </section>

          <section className="infra-panel release-production-state">
            <PanelHeader title="生产状态" action={runtimeStatus} />
            <div><Server size={18} /><span><strong>{runtimeStatus}</strong><small>{releases.data?.runtime.endpoint || "http://127.0.0.1:8020/v1"}</small></span></div>
            <div><Rocket size={18} /><span><strong>{latest?.metadata.phase ?? latest?.status ?? "暂无"}</strong><small>{latest ? `${latest.name} · ${relativeTime(latest.started_at)}` : "最近发布"}</small></span></div>
            {runtimeActive && latest ? <div className="release-runtime-actions">
              <button type="button" disabled={stop.isPending} onClick={() => stop.mutate()}><Square size={13} />{stop.isPending ? "下线中..." : "下线服务"}</button>
            </div> : null}
          </section>

          <section className="infra-panel release-service-access">
            <PanelHeader title="服务调用" action={runtimeStatus === "ready" ? "可调用" : "等待就绪"} />
            <p>发布成功后通过 OpenAI-Compatible API 使用，不需要进入容器。</p>
            <code>{releases.data?.runtime.endpoint || "http://127.0.0.1:8020/v1"}</code>
            <div className="release-runtime-actions">
              <button type="button" onClick={() => copyText(`${releases.data?.runtime.endpoint || "http://127.0.0.1:8020/v1"}/models`)}>复制 Models 地址</button>
              <button type="button" onClick={() => copyText(modelCurl(releases.data?.runtime.endpoint, releases.data?.runtime.config?.model as string | undefined))}>复制 curl 示例</button>
            </div>
            <small>业务侧调用 `POST /v1/chat/completions`；需要 A/B、灰度或影子流量时，再绑定到“流量治理与路由”的稳定策略地址。</small>
          </section>
        </aside>
      </div>

      <section className="infra-panel release-history-panel">
        <PanelHeader title="推理发布记录" action={`${recent.length} 条`} />
        {deployments.isLoading ? <Skeleton rows={3} /> : recent.length === 0 ? <EmptyState title="暂无推理发布记录" /> : (
          <div className="release-history-table">
            <div className="release-history-row header"><span>服务</span><span>版本</span><span>运行参数</span><span>压测证据</span><span>阶段</span><span>时间</span></div>
            {recent.map((item) => <div className="release-history-row" key={item.id}><strong>{item.name}</strong><span>{item.version || "-"}</span><span>{runtimeSummary(item.metadata.runtime_request)}</span><span>{item.metadata.benchmark_run_id?.slice(0, 8) || "-"}</span><StatusBadge status={item.metadata.phase || item.status} /><span>{relativeTime(item.started_at)}</span></div>)}
          </div>
        )}
      </section>
      </>}
    </section>
  );
}

function Gate({ passed, soft = false, title, detail }: { passed: boolean; soft?: boolean; title: string; detail: string }) {
  const Icon = passed ? CheckCircle2 : soft ? Circle : AlertTriangle;
  return <div className={`release-gate ${passed ? "passed" : soft ? "soft" : "blocked"}`}><Icon size={17} /><span><strong>{title}</strong><small title={detail}>{detail}</small></span></div>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value === 1 ? 0 : 1)}%`;
}

function milliseconds(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`;
}

function runtimeRequestFromForm(form: RuntimeForm): Record<string, unknown> {
  return {
    profile: "scheduler",
    tensor_parallel_size: form.parallelism === "tp2" ? 2 : 1,
    pipeline_parallel_size: form.parallelism === "pp2" ? 2 : 1,
    max_num_seqs: form.maxNumSeqs,
    max_num_batched_tokens: form.maxNumBatchedTokens,
    scheduling_policy: form.schedulingPolicy,
    max_num_partial_prefills: 1,
    max_long_partial_prefills: 1,
    long_prefill_token_threshold: 0,
    stream_interval: 1,
    prefix_caching: form.prefixCaching,
    async_scheduling: form.asyncScheduling,
    scheduler_reserve_full_isl: true,
    disable_custom_all_reduce: true,
    gpu_memory_utilization: form.gpuMemoryUtilization,
    max_model_len: form.maxModelLen,
    kv_cache_dtype: form.kvCacheDType,
    speculative_decoding: "none",
  };
}

function runtimeFormFromBenchmark(vllm: Record<string, unknown>, current: RuntimeForm): RuntimeForm {
  const tp = Number(vllm.tensor_parallel_size ?? (current.parallelism === "tp2" ? 2 : 1));
  const pp = Number(vllm.pipeline_parallel_size ?? (current.parallelism === "pp2" ? 2 : 1));
  const scheduling = String(vllm.scheduling_policy ?? vllm.scheduler ?? current.schedulingPolicy);
  const kv = String(vllm.kv_cache_dtype ?? current.kvCacheDType);
  return {
    parallelism: pp === 2 && tp !== 2 ? "pp2" : "tp2",
    maxNumSeqs: Number(vllm.max_num_seqs ?? current.maxNumSeqs),
    maxNumBatchedTokens: Number(vllm.max_num_batched_tokens ?? current.maxNumBatchedTokens),
    schedulingPolicy: scheduling === "priority" ? "priority" : "fcfs",
    prefixCaching: vllm.prefix_caching === true,
    asyncScheduling: vllm.async_scheduling !== false,
    gpuMemoryUtilization: Number(vllm.gpu_memory_utilization ?? current.gpuMemoryUtilization),
    maxModelLen: Number(vllm.max_model_len ?? current.maxModelLen),
    kvCacheDType: kv === "fp8" ? "fp8" : "auto",
  };
}

function copyText(value: string) {
  navigator.clipboard.writeText(value).then(() => toast.success("已复制调用信息")).catch(() => toast.error("复制失败"));
}

function modelCurl(endpoint?: string, model?: string): string {
  const base = endpoint || "http://127.0.0.1:8020/v1";
  return `curl -X POST ${base}/chat/completions -H 'Content-Type: application/json' -d '{"model":"${model || "qwen36-27b-fp8"}","messages":[{"role":"user","content":"你好"}]}'`;
}

function modelIDFromEndpoint(endpoint?: string): string {
  return endpoint?.replace(/-vllm$/, "") || "";
}

function releaseSpec(modelVersionID: string, env: string, runtime: Record<string, unknown>): Record<string, unknown> {
  return {
    apiVersion: "platform.twinforge.io/v1alpha1",
    kind: "InferenceRelease",
    metadata: { name: "qwen36-production", environment: env },
    spec: {
      modelVersionId: modelVersionID || "<select-model-version>",
      runtime,
      resources: { replicas: 1, gpu: 2 },
      rollout: { strategy: "RollingUpdate", automaticRollback: true },
      healthCheck: { path: "/v1/models", timeoutSeconds: 600 },
    },
  };
}

function runtimeFormFromSpec(document: Record<string, unknown>): { runtime: RuntimeForm; modelVersionID?: string; env?: string } {
  const spec = asObject(document.spec, "spec");
  const runtime = asObject(spec.runtime, "spec.runtime");
  const tp = numberField(runtime, "tensor_parallel_size", 2);
  const pp = numberField(runtime, "pipeline_parallel_size", 1);
  if (tp * pp !== 2) throw new Error("tensor_parallel_size × pipeline_parallel_size 必须等于本机 2 张 GPU");
  const maxNumSeqs = numberField(runtime, "max_num_seqs", 8);
  const maxNumBatchedTokens = numberField(runtime, "max_num_batched_tokens", 4096);
  const gpuMemoryUtilization = numberField(runtime, "gpu_memory_utilization", 0.9);
  const maxModelLen = numberField(runtime, "max_model_len", 4096);
  if (![8, 12, 16, 24, 32].includes(maxNumSeqs)) throw new Error("max_num_seqs 必须是 8/12/16/24/32");
  if (![2048, 4096, 8192].includes(maxNumBatchedTokens)) throw new Error("max_num_batched_tokens 必须是 2048/4096/8192");
  if (![0.85, 0.9, 0.92].includes(gpuMemoryUtilization)) throw new Error("gpu_memory_utilization 必须是 0.85/0.9/0.92");
  if (![3072, 4096].includes(maxModelLen)) throw new Error("max_model_len 必须是 3072 或 4096");
  const schedulingPolicy = String(runtime.scheduling_policy ?? "fcfs");
  if (schedulingPolicy !== "fcfs" && schedulingPolicy !== "priority") throw new Error("scheduling_policy 必须是 fcfs 或 priority");
  const kvCacheDType = String(runtime.kv_cache_dtype ?? "auto");
  if (kvCacheDType !== "auto" && kvCacheDType !== "fp8") throw new Error("kv_cache_dtype 必须是 auto 或 fp8");
  const metadata = document.metadata && typeof document.metadata === "object" ? document.metadata as Record<string, unknown> : {};
  return {
    runtime: {
      parallelism: pp === 2 ? "pp2" : "tp2",
      maxNumSeqs,
      maxNumBatchedTokens,
      schedulingPolicy,
      prefixCaching: runtime.prefix_caching !== false,
      asyncScheduling: runtime.async_scheduling !== false,
      gpuMemoryUtilization: gpuMemoryUtilization as RuntimeForm["gpuMemoryUtilization"],
      maxModelLen: maxModelLen as RuntimeForm["maxModelLen"],
      kvCacheDType,
    },
    modelVersionID: typeof spec.modelVersionId === "string" && !spec.modelVersionId.startsWith("<") ? spec.modelVersionId : undefined,
    env: typeof metadata.environment === "string" ? metadata.environment : undefined,
  };
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function numberField(object: Record<string, unknown>, key: string, fallback: number): number {
  const value = object[key] ?? fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是数字`);
  return parsed;
}

function runtimeSummary(request?: Record<string, unknown>): string {
  if (!request) return "历史模板";
  return `seqs ${request.max_num_seqs ?? "-"} · tokens ${request.max_num_batched_tokens ?? "-"}`;
}

function releaseEventMessage(phase: string, fallback: string): string {
  return ({
    starting: "启动已通过门禁的 vLLM 生产 workload",
    replacing: "停止上一版本的推理 workload",
    warming: "容器已创建，等待 OpenAI-Compatible 健康检查",
    succeeded: "vLLM 生产 endpoint 已就绪",
    rolling_back: "新配置启动异常，正在恢复原运行时",
    failed: "发布失败",
  } as Record<string, string>)[phase] ?? fallback;
}
