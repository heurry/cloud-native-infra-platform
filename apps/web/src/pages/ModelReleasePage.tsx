import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Circle, ExternalLink, RefreshCw, Rocket, RotateCcw, Server, Square } from "lucide-react";

import { describeError, EmptyState, ErrorState, Skeleton } from "../components/common/FeedbackStates";
import { PageHeader, PanelHeader, StatusBadge } from "../components/common/PlatformPrimitives";
import { api, listModelRegistry } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useGoToPage } from "../lib/useGoToPage";
import { useDeliveryContext } from "../lib/useDeliveryContext";
import type { Deployment } from "../types/ops";
import type { ServiceInstance } from "../types/platform";

type ReleaseCandidate = {
  profile: "balanced" | "high_throughput";
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
  runtime: { status?: string; profile?: string; endpoint?: string; config?: Record<string, unknown>; error?: string };
  progress: {
    active_stage: string;
    weight_percent?: number;
    stages: Array<{ key: string; label: string; state: "pending" | "active" | "complete"; detail?: string }>;
  };
};

export function ModelReleasePage() {
  const qc = useQueryClient();
  const goTo = useGoToPage();
  const { context, update } = useDeliveryContext();
  const [versionID, setVersionID] = useState("");
  const [profile, setProfile] = useState<ReleaseCandidate["profile"]>("balanced");
  const [env, setEnv] = useState("prod");
  const [approved, setApproved] = useState(false);

  const registry = useQuery({ queryKey: ["model-registry"], queryFn: listModelRegistry, refetchInterval: 10000 });
  const releases = useQuery({ queryKey: ["inference", "releases"], queryFn: () => api<ReleaseState>("/api/inference/releases"), refetchInterval: 5000 });
  const deployments = useQuery({ queryKey: ["deployments"], queryFn: () => api<{ deployments: Deployment[] }>("/api/deployments"), refetchInterval: 5000 });
  const instances = useQuery({ queryKey: ["service-instances"], queryFn: () => api<{ instances: ServiceInstance[] }>("/api/service-instances"), refetchInterval: 10000 });

  const releaseModelID = releases.data?.model_id || "qwen36-27b-fp8";
  const versions = useMemo(() => (registry.data?.versions ?? []).filter((item) => item.model_id === releaseModelID), [registry.data, releaseModelID]);
  useEffect(() => {
    if (context.modelVersionId && versions.some((item) => item.id === context.modelVersionId)) {
      if (versionID !== context.modelVersionId) setVersionID(context.modelVersionId);
      return;
    }
    if (!versionID && versions[0]) setVersionID(versions.find((item) => item.status === "serving")?.id ?? versions[0].id);
  }, [context.modelVersionId, versionID, versions]);
  useEffect(() => {
    const matching = releases.data?.candidates.find((item) => item.run_id && item.run_id === context.benchmarkRunId);
    if (matching && matching.profile !== profile) setProfile(matching.profile);
  }, [context.benchmarkRunId, profile, releases.data?.candidates]);
  const selected = versions.find((item) => item.id === versionID);
  const candidate = releases.data?.candidates.find((item) => item.profile === profile);
  const recent = useMemo(() => (deployments.data?.deployments ?? []).filter((item) => item.metadata.mode === "inference_runtime").slice(0, 8), [deployments.data]);
  const latest = recent[0];
  const runtimeStatus = releases.data?.runtime.status ?? "unknown";
  const runtimeActive = runtimeStatus === "ready" || runtimeStatus === "starting";
  const activeBindings = selected ? (registry.data?.bindings[selected.model_id] ?? []) : [];

  const release = useMutation({
    mutationFn: (override?: { profile: ReleaseCandidate["profile"]; modelVersionID: string }) => api<{ id: string; status: string }>("/api/inference/releases", {
      method: "POST",
      body: JSON.stringify({ model_version_id: override?.modelVersionID ?? versionID, profile: override?.profile ?? profile, env, operator: "frontend" }),
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

  const latestProfile = latest?.metadata.release_profile;
  const latestVersionID = latest?.metadata.model_version_id;
  const evidenceMatches = !context.benchmarkRunId || candidate?.run_id === context.benchmarkRunId;
  const hardReady = Boolean(selected && selected.status !== "deprecated" && candidate?.gate_passed && evidenceMatches && approved && !release.isPending);

  return (
    <section className="infra-page release-page">
      <PageHeader
        title="模型发布上线"
        subtitle={`将通过推理验收的 ${releaseModelID} 配置发布到单机双卡生产运行时，并保留版本、证据和回滚记录`}
        actions={<><button className="console-refresh" type="button" onClick={() => goTo("pipelines")}>服务发布流水线</button><button className="console-refresh" type="button" onClick={() => { registry.refetch(); releases.refetch(); deployments.refetch(); instances.refetch(); }}><RefreshCw size={14} /> 刷新</button></>}
      />

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

              <div className="release-profile-heading"><strong>运行时档位</strong><small>只能发布存在参数完全匹配压测证据的固定档位</small></div>
              <div className="release-profile-switch" role="radiogroup" aria-label="运行时档位">
                {(releases.data?.candidates ?? []).map((item) => (
                  <button key={item.profile} type="button" role="radio" aria-checked={profile === item.profile} className={profile === item.profile ? "active" : ""} onClick={() => {
                    setProfile(item.profile);
                    setApproved(false);
                    update({ deliveryKind: "inference", benchmarkRunId: item.run_id || null });
                  }}>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    <b>{item.max_num_seqs} / {item.max_num_batched_tokens}</b>
                  </button>
                ))}
              </div>

              {candidate ? <div className="release-evidence-strip">
                <div><small>验证场景</small><strong>{candidate.scenarios}</strong></div>
                <div><small>最低成功率</small><strong>{percent(candidate.min_success_rate)}</strong></div>
                <div><small>平均 P95 TTFT</small><strong>{milliseconds(candidate.average_p95_ttft_ms)}</strong></div>
                <div><small>平均 P95 TPOT</small><strong>{milliseconds(candidate.average_p95_tpot_ms)}</strong></div>
                <div><small>平均吞吐</small><strong>{candidate.average_output_tokens_per_second.toFixed(1)} tok/s</strong></div>
              </div> : null}

              {!evidenceMatches ? <div className="release-context-warning"><AlertTriangle size={15} /><span>当前交付上下文指定 Run {context.benchmarkRunId?.slice(0, 12)}，但所选档位的发布证据是 {candidate?.run_id?.slice(0, 12) || "无"}。请选择匹配档位，或返回推理工作台重新验收。</span></div> : null}

              <label>发布环境<select value={env} onChange={(event) => setEnv(event.target.value)}><option value="staging">staging</option><option value="prod">prod</option></select></label>
              <label className="release-approval"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>我已核对模型版本、压测 run 和运行时档位，确认占用双卡启动生产服务</span></label>
              <button className="release-submit" disabled={!hardReady} type="button" onClick={() => release.mutate(undefined)}><Rocket size={15} />{release.isPending ? "正在提交..." : runtimeActive ? "滚动切换生产档位" : "发布到生产运行时"}</button>
              <p className="release-note">发布由控制面启动固定白名单 vLLM workload，轮询 `/v1/models` 健康状态后才标记成功；单机双卡切换档位会短暂重启服务。</p>
            </div>
          )}
        </section>

        <aside className="release-gates">
          <section className="infra-panel">
            <PanelHeader title="发布门禁" action={candidate?.gate_passed ? "允许人工审批" : "存在未通过项"} />
            <Gate passed={Boolean(selected && selected.model_id === "qwen36-27b-fp8" && selected.status !== "deprecated")} title="模型与通道匹配" detail={selected ? `${selected.model_id} · ${selected.status}` : "未选择版本"} />
            <Gate passed={Boolean(candidate?.available)} title="参数证据匹配" detail={candidate?.run_id ? `${candidate.run_id.slice(0, 8)} · ${candidate.max_num_seqs}/${candidate.max_num_batched_tokens}` : candidate?.error || "无匹配压测"} />
            <Gate passed={Boolean(candidate?.gate_passed)} title="成功率与输出质量" detail={candidate ? `${percent(candidate.min_success_rate)} / ${percent(candidate.min_quality_rate)}，共 ${candidate.scenarios} 个场景` : "等待证据"} />
            <Gate passed={Boolean(candidate && candidate.max_p95_ttft_ms <= candidate.slo_ttft_limit_ms && candidate.max_p95_tpot_ms <= candidate.slo_tpot_limit_ms)} title="推理 SLO 门禁" detail={candidate ? `最差 TTFT ${milliseconds(candidate.max_p95_ttft_ms)} / TPOT ${milliseconds(candidate.max_p95_tpot_ms)}` : "等待证据"} />
            <Gate passed={activeBindings.length > 0} soft title="OpenAI-Compatible 绑定" detail={activeBindings.length ? `${activeBindings.length} 个固定 endpoint` : "没有服务绑定"} />
            {!candidate?.gate_passed ? <button className="release-link" type="button" onClick={() => goTo("benchmarks")}>前往推理优化工作台 <ExternalLink size={13} /></button> : null}
          </section>

          <section className="infra-panel release-production-state">
            <PanelHeader title="生产状态" action={runtimeStatus} />
            <div><Server size={18} /><span><strong>{runtimeStatus}</strong><small>{releases.data?.runtime.endpoint || "http://127.0.0.1:8020/v1"}</small></span></div>
            <div><Rocket size={18} /><span><strong>{latest?.metadata.phase ?? latest?.status ?? "暂无"}</strong><small>{latest ? `${latest.name} · ${relativeTime(latest.started_at)}` : "最近发布"}</small></span></div>
            {runtimeActive && latest ? <div className="release-runtime-actions">
              {latestProfile === "high_throughput" && latestVersionID ? <button type="button" disabled={release.isPending} onClick={() => release.mutate({ profile: "balanced", modelVersionID: latestVersionID })}><RotateCcw size={14} /> 回滚到均衡档</button> : null}
              <button type="button" disabled={stop.isPending} onClick={() => stop.mutate()}><Square size={13} />{stop.isPending ? "下线中..." : "下线服务"}</button>
            </div> : null}
          </section>
        </aside>
      </div>

      <section className="infra-panel release-history-panel">
        <PanelHeader title="推理发布记录" action={`${recent.length} 条`} />
        {deployments.isLoading ? <Skeleton rows={3} /> : recent.length === 0 ? <EmptyState title="暂无推理发布记录" /> : (
          <div className="release-history-table">
            <div className="release-history-row header"><span>服务</span><span>版本</span><span>档位</span><span>压测证据</span><span>阶段</span><span>时间</span></div>
            {recent.map((item) => <div className="release-history-row" key={item.id}><strong>{item.name}</strong><span>{item.version || "-"}</span><span>{profileLabel(item.metadata.release_profile)}</span><span>{item.metadata.benchmark_run_id?.slice(0, 8) || "-"}</span><StatusBadge status={item.metadata.phase || item.status} /><span>{relativeTime(item.started_at)}</span></div>)}
          </div>
        )}
      </section>
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

function profileLabel(profile?: string): string {
  return profile === "high_throughput" ? "高并发档" : profile === "balanced" ? "均衡档" : "-";
}

function releaseEventMessage(phase: string, fallback: string): string {
  return ({
    starting: "启动已通过门禁的 vLLM 生产 workload",
    replacing: "停止上一档位的推理 workload",
    warming: "容器已创建，等待 OpenAI-Compatible 健康检查",
    succeeded: "vLLM 生产 endpoint 已就绪",
    rolling_back: "新档位启动异常，正在恢复原运行时",
    failed: "发布失败",
  } as Record<string, string>)[phase] ?? fallback;
}
