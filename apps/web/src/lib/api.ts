// 统一 API 客户端
//
// 设计目标（企业级横切能力 §8.1）：
// - baseURL 走环境变量 VITE_API_BASE，支持 dev/staging/prod 多环境
// - 每个请求注入 x-request-id（trace id），便于和后端日志/审计串联
// - 统一超时（AbortController），避免请求悬挂
// - 类型化错误 ApiError（带 status / requestId / body），上层可按状态码分支
// - 401 统一交给可注册的处理钩子（后续接入登录态）

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
