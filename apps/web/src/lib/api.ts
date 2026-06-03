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
        "x-request-id": requestId
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
