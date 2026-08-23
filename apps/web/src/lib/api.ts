// 统一 API 客户端
//
// 设计目标（企业级横切能力 §8.1）：
// - baseURL 走环境变量 VITE_API_BASE，支持 dev/staging/prod 多环境
// - 每个请求注入 x-request-id（trace id），便于和后端日志/审计串联
// - 统一超时（AbortController），避免请求悬挂
// - 类型化错误 ApiError（带 status / requestId / body），上层可按状态码分支
// - 401 统一交给可注册的处理钩子（后续接入登录态）

import type { K8sHPA, ScaleDeploymentInput, UpsertHpaInput } from "../types/platform";
import type { ModelRegistryList, RegisterModelInput, RegisteredModelVersion } from "../types/registry";
import type { ArchiveManifest, ArchiveRunResult, StorageTiers } from "../types/storage";
import type { CallGraph } from "../types/topology";
import type { RoutingPolicy, RoutingPolicyDetail, RoutingPolicyList, RoutingStats, SavePolicyInput } from "../types/routing";
import type { DocSignalList, FeedbackDataset, RagEvalHistory, RagEvalResult } from "../types/feedback";
import type { SubmitTrainingInput, TrainingJobsList, TrainingKubernetesDetail, TrainingLogs } from "../types/training";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string;
  readonly body: string;

  constructor(message: string, options: { status: number; requestId: string; body: string }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.requestId = options.requestId;
    this.body = options.body;
  }
}

// 401 处理钩子：登录态接入后由 auth 模块注册（如跳转登录页）。
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

// D2：JWT 令牌（认证开启时由登录写入；持久化到 localStorage，刷新不丢）。
const AUTH_TOKEN_KEY = "cip_auth_token";
let authToken: string | null = typeof localStorage !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
export function setAuthToken(token: string | null): void {
  authToken = token;
  if (typeof localStorage !== "undefined") {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}
export function getAuthToken(): string | null {
  return authToken;
}
function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function makeRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface ApiOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  /** 请求超时（毫秒），默认 30s。传入 0 关闭超时。 */
  timeoutMs?: number;
}

export async function api<T>(path: string, init?: ApiOptions): Promise<T> {
  const requestId = makeRequestId();
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  // 外部可传入自己的 signal；同时叠加超时 signal。
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;
  if (init?.signal) {
    init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId,
        ...authHeaders(),
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    if (timer) window.clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(`请求超时（${timeoutMs}ms）`, { status: 0, requestId, body: "" });
    }
    throw new ApiError(error instanceof Error ? error.message : "网络请求失败", {
      status: 0,
      requestId,
      body: ""
    });
  } finally {
    if (timer) window.clearTimeout(timer);
  }

  if (response.status === 401) {
    unauthorizedHandler?.();
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(body || response.statusText || `请求失败（${response.status}）`, {
      status: response.status,
      requestId: response.headers.get("x-request-id") || requestId,
      body
    });
  }

  // 204 / 空响应体安全返回
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ===== A2：K8s 弹性扩缩容写操作 =====
//
// 写操作受后端双重约束：feature flag（ALLOW_K8S_WRITES）+ 命名空间允许名单 + serving 组件硬禁。
// 未开启写时后端返回 403（code: k8s_writes_disabled）；命中保护命名空间返回 403（k8s_namespace_protected）。

/** 手动扩缩 Deployment 副本数；返回写入后的期望副本。 */
export async function scaleK8sDeployment(input: ScaleDeploymentInput): Promise<{ replicas: number }> {
  return api(`/api/kubernetes/deployments/${encodeURIComponent(input.name)}/scale`, {
    method: "POST",
    body: JSON.stringify({ namespace: input.namespace, replicas: input.replicas })
  });
}

/** 创建或更新 HPA（按 CPU 利用率水平伸缩 Deployment）；幂等。 */
export async function upsertK8sHpa(input: UpsertHpaInput): Promise<K8sHPA> {
  return api(`/api/kubernetes/hpa`, { method: "PUT", body: JSON.stringify(input) });
}

/** 删除 HPA；幂等（不存在视为成功）。 */
export async function deleteK8sHpa(namespace: string, name: string): Promise<void> {
  await api(`/api/kubernetes/hpa/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`, {
    method: "DELETE"
  });
}

// ===== C1：模型注册中心 =====

export function listModelRegistry(): Promise<ModelRegistryList> {
  return api<ModelRegistryList>("/api/models/registry");
}

// ===== C2：分层存储生命周期 =====
export function storageTiers(): Promise<StorageTiers> {
  return api<StorageTiers>("/api/storage/tiers");
}
export function listArchives(limit = 50): Promise<{ archives: ArchiveManifest[] }> {
  return api<{ archives: ArchiveManifest[] }>(`/api/storage/archives?limit=${limit}`);
}
export function runArchive(): Promise<{ results: ArchiveRunResult[] }> {
  return api("/api/storage/archive", { method: "POST", body: JSON.stringify({}) });
}
export function archiveDownloadURL(id: string): Promise<{ key: string; download_url?: string; note?: string }> {
  return api(`/api/storage/archives/${encodeURIComponent(id)}`);
}

// ===== C3：真实服务拓扑（trace 派生的调用图） =====
export function topologyGraph(): Promise<CallGraph> {
  return api<CallGraph>("/api/topology/graph");
}

// ===== E3：模型路由 / A-B / 影子流量 =====
export function listRoutingPolicies(): Promise<RoutingPolicyList> {
  return api<RoutingPolicyList>("/api/routing/policies");
}
export function getRoutingPolicy(name: string): Promise<RoutingPolicyDetail> {
  return api<RoutingPolicyDetail>(`/api/routing/policies/${encodeURIComponent(name)}`);
}
export function routingPolicyStats(name: string, window = 3600): Promise<RoutingStats> {
  return api<RoutingStats>(`/api/routing/policies/${encodeURIComponent(name)}/stats?window=${window}`);
}
export function createRoutingPolicy(input: SavePolicyInput): Promise<{ policy: RoutingPolicy }> {
  return api("/api/routing/policies", { method: "POST", body: JSON.stringify(input) });
}
export function updateRoutingPolicy(name: string, input: SavePolicyInput): Promise<{ policy: RoutingPolicy }> {
  return api(`/api/routing/policies/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(input) });
}
export async function deleteRoutingPolicy(name: string): Promise<void> {
  await api(`/api/routing/policies/${encodeURIComponent(name)}`, { method: "DELETE" });
}
export function promoteRoutingVariant(name: string, label: string): Promise<{ policy: RoutingPolicy }> {
  return api(`/api/routing/policies/${encodeURIComponent(name)}/promote`, { method: "POST", body: JSON.stringify({ label }) });
}
export function rollbackRoutingPolicy(name: string): Promise<{ policy: RoutingPolicy }> {
  return api(`/api/routing/policies/${encodeURIComponent(name)}/rollback`, { method: "POST", body: JSON.stringify({}) });
}

// 路由候选/影子目标的下拉来源：已注册的 serving 实例名（service_instances）。
export async function serviceInstanceNames(): Promise<string[]> {
  const res = await api<{ instances: Array<{ name: string }> }>("/api/service-instances");
  return res.instances.map((i) => i.name);
}

// ===== E2：RAG 评测体系 + 在线反馈回流 =====
export function ragDataset(): Promise<FeedbackDataset> {
  return api<FeedbackDataset>("/api/rag/dataset");
}
export function ragSignal(): Promise<DocSignalList> {
  return api<DocSignalList>("/api/rag/signal");
}
export function runRagEval(): Promise<RagEvalResult> {
  return api<RagEvalResult>("/api/rag/eval", { method: "POST", body: JSON.stringify({}), timeoutMs: 120_000 });
}
export function ragEvalHistory(limit = 20): Promise<RagEvalHistory> {
  return api<RagEvalHistory>(`/api/rag/eval/history?limit=${limit}`);
}

export function registerModelVersion(input: RegisterModelInput): Promise<{ id: string; model_id: string; version: string }> {
  return api("/api/models/registry", { method: "POST", body: JSON.stringify(input) });
}

export function updateModelStatus(id: string, status: string): Promise<RegisteredModelVersion> {
  return api(`/api/models/registry/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
}

export async function deleteModelVersion(id: string): Promise<void> {
  await api(`/api/models/registry/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function modelArtifactURL(id: string): Promise<{ download_url?: string; external?: boolean; key?: string; note?: string }> {
  return api(`/api/models/registry/${encodeURIComponent(id)}/artifact`);
}

/** 上传模型产物到 MinIO（multipart）。不能复用 api()——FormData 需浏览器自动设 multipart boundary。 */
export async function uploadModelArtifact(id: string, file: File): Promise<{ artifact_uri: string; size: number }> {
  const requestId = makeRequestId();
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/models/registry/${encodeURIComponent(id)}/artifact`, {
    method: "POST",
    body: fd,
    headers: { "x-request-id": requestId, ...authHeaders() }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(body || res.statusText || `上传失败（${res.status}）`, {
      status: res.status,
      requestId: res.headers.get("x-request-id") || requestId,
      body
    });
  }
  return (await res.json()) as { artifact_uri: string; size: number };
}

// ===== Phase F：分布式训练（Kubeflow PyTorchJob） =====
export function listTrainingJobs(): Promise<TrainingJobsList> {
  return api<TrainingJobsList>("/api/training/jobs");
}
export function submitTrainingJob(
  input: SubmitTrainingInput
): Promise<{ id: string; name: string; namespace: string; status: string; registers_as?: string }> {
  return api("/api/training/jobs", { method: "POST", body: JSON.stringify(input) });
}
export async function cancelTrainingJob(id: string): Promise<void> {
  await api(`/api/training/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function trainingJobLogs(id: string): Promise<TrainingLogs> {
  return api<TrainingLogs>(`/api/training/jobs/${encodeURIComponent(id)}/logs`);
}
export function trainingJobKubernetes(id: string): Promise<TrainingKubernetesDetail> {
  return api<TrainingKubernetesDetail>(`/api/training/jobs/${encodeURIComponent(id)}/kubernetes`, { timeoutMs: 12_000 });
}

// ===== SSE 流式对话（AI Copilot） =====
//
// /api/ai/chat:stream 是 Go 单一入口反向代理到 Python AI 服务（FlushInterval=-1 逐块 flush）。
// 上游按 `event: <name>\ndata: <json>\n\n` 推送：start{mode} / token{text} / notice{message}
// / error{error} / done{}。AI 服务不可达时 Go 返回 502 错误信封（非 SSE），这里解析后回调 onError。

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamHandlers {
  onStart?: (mode: string) => void;
  onToken: (text: string) => void;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export async function streamAIChat(
  messages: ChatMessage[],
  handlers: ChatStreamHandlers,
  options?: ChatStreamOptions
): Promise<void> {
  const requestId = makeRequestId();
  const url = `${API_BASE}/api/ai/chat:stream`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-request-id": requestId,
        ...authHeaders()
      },
      body: JSON.stringify({
        messages,
        max_tokens: options?.maxTokens ?? 1024,
        temperature: options?.temperature ?? 0.2
      })
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    handlers.onError?.(error instanceof Error ? error.message : "网络请求失败");
    handlers.onDone?.();
    return;
  }

  if (response.status === 401) unauthorizedHandler?.();

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    let message = body || response.statusText || `请求失败（${response.status}）`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
      message = parsed?.error?.message || parsed?.message || message;
    } catch {
      /* 非 JSON：保留原文 */
    }
    handlers.onError?.(message);
    handlers.onDone?.();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const { event, data } = parseSSEBlock(block);
        if (!event) continue;
        switch (event) {
          case "start":
            handlers.onStart?.(String((data as { mode?: unknown })?.mode ?? ""));
            break;
          case "token": {
            const text = (data as { text?: unknown })?.text;
            if (typeof text === "string") handlers.onToken(text);
            break;
          }
          case "notice":
            handlers.onNotice?.(String((data as { message?: unknown })?.message ?? ""));
            break;
          case "error":
            handlers.onError?.(String((data as { error?: unknown })?.error ?? "AI 服务错误"));
            break;
          case "done":
            finished = true;
            break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      handlers.onError?.(error instanceof Error ? error.message : "流式连接中断");
    }
  } finally {
    handlers.onDone?.();
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }
}

// ===== SSE 流式客服 RAG 对话（/api/chat/sessions/{id}/messages:stream） =====
//
// Go 原生 RAG 管线逐事件推送（`event: <name>\ndata: <json>\n\n`）：
// retrieval{documents,query,retrieval_ms,memory_turns,request_id} / route{...}
// / token{text} / fallback{reason,error?} / citation{doc_ids} / metrics{ttft_ms,total_ms,target_pod,...} / done{}。
// 会话不存在 / content 为空时后端返回非 SSE 错误信封，这里解析后回调 onError。

export interface ChatCitation {
  doc_id: string;
  title?: string;
  category?: string;
  version?: string;
  score?: number;
}

export interface ChatSessionMetrics {
  request_id?: string;
  retrieval_ms?: number | null;
  ttft_ms?: number | null;
  generation_ms?: number | null;
  total_ms?: number | null;
  target_pod?: string;
  fallback_reason?: string;
  status?: string;
  error?: string;
}

export interface ChatSessionStreamHandlers {
  onRetrieval?: (docs: ChatCitation[], info: { query?: string; retrievalMs?: number; memoryTurns?: number; requestId?: string }) => void;
  onRoute?: (info: { endpointId?: string; selectedEndpointId?: string; routingStrategy?: string }) => void;
  onToken: (text: string) => void;
  onFallback?: (reason: string, error?: string) => void;
  onMetrics?: (metrics: ChatSessionMetrics) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface ChatSessionStreamOptions {
  signal?: AbortSignal;
  endpointId?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function streamChatSession(
  sessionId: string,
  content: string,
  handlers: ChatSessionStreamHandlers,
  options?: ChatSessionStreamOptions
): Promise<void> {
  const requestId = makeRequestId();
  const url = `${API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages:stream`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: options?.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-request-id": requestId, ...authHeaders() },
      body: JSON.stringify({
        content,
        endpoint_id: options?.endpointId ?? "",
        max_tokens: options?.maxTokens ?? 1024,
        ...(options?.temperature != null ? { temperature: options.temperature } : {})
      })
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    handlers.onError?.(error instanceof Error ? error.message : "网络请求失败");
    handlers.onDone?.();
    return;
  }

  if (response.status === 401) unauthorizedHandler?.();

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    let message = body || response.statusText || `请求失败（${response.status}）`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
      message = parsed?.error?.message || parsed?.message || message;
    } catch {
      /* 非 JSON：保留原文 */
    }
    handlers.onError?.(message);
    handlers.onDone?.();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const { event, data } = parseSSEBlock(block);
        if (!event) continue;
        const obj = (data ?? {}) as Record<string, unknown>;
        switch (event) {
          case "retrieval":
            handlers.onRetrieval?.(Array.isArray(obj.documents) ? (obj.documents as ChatCitation[]) : [], {
              query: asStr(obj.query),
              retrievalMs: asNum(obj.retrieval_ms),
              memoryTurns: asNum(obj.memory_turns),
              requestId: asStr(obj.request_id)
            });
            break;
          case "route":
            handlers.onRoute?.({
              endpointId: asStr(obj.endpoint_id),
              selectedEndpointId: asStr(obj.selected_endpoint_id),
              routingStrategy: asStr(obj.routing_strategy)
            });
            break;
          case "token": {
            const text = obj.text;
            if (typeof text === "string") handlers.onToken(text);
            break;
          }
          case "fallback":
            handlers.onFallback?.(asStr(obj.reason) ?? "fallback", asStr(obj.error));
            break;
          case "metrics":
            handlers.onMetrics?.(obj as ChatSessionMetrics);
            break;
          case "citation":
            /* doc_ids 已随 retrieval/metrics 提供，这里忽略以保持事件兼容 */
            break;
          case "error":
            handlers.onError?.(asStr(obj.error) ?? "对话服务错误");
            break;
          case "done":
            finished = true;
            break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      handlers.onError?.(error instanceof Error ? error.message : "流式连接中断");
    }
  } finally {
    handlers.onDone?.();
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function parseSSEBlock(block: string): { event: string; data: unknown } {
  let event = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  let data: unknown;
  if (dataLines.length) {
    const joined = dataLines.join("\n");
    try {
      data = JSON.parse(joined);
    } catch {
      data = joined;
    }
  }
  return { event, data };
}
