import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, streamChatSession, type ChatCitation } from "./api";
import type { ChatMessageView, ChatSession, ServerChatMessage } from "../types/support";

// useSupportChat：客服 RAG 对话的状态机 —— 会话列表/选择、历史加载、流式问答、反馈。
// 视图层（页面/组件）只消费返回值，不持有任何拉取/流式逻辑（结构分层）。
export function useSupportChat() {
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingConvo, setLoadingConvo] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  // request_id -> 带标题的检索引用：刷新历史消息时复用（落库 metadata 只有 doc_ids）。
  const citationCacheRef = useRef<Map<string, ChatCitation[]>>(new Map());
  // 会话在发送途中新建时，跳过一次「切换会话→重载」effect，避免打断正在进行的流。
  const skipLoadRef = useRef<string>("");

  const sessionsQuery = useQuery({
    queryKey: ["chat-sessions"],
    queryFn: () => api<{ sessions: ChatSession[] }>("/api/chat/sessions?limit=50")
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const selectedSession = sessions.find((s) => s.session_id === selectedId);

  // 首次有会话且未选中时，自动选中最近的一条。
  useEffect(() => {
    if (!selectedId && sessions.length > 0) setSelectedId(sessions[0].session_id);
  }, [sessions, selectedId]);

  // 切换会话：中断进行中的流并拉取该会话历史。
  useEffect(() => {
    if (skipLoadRef.current && skipLoadRef.current === selectedId) {
      skipLoadRef.current = "";
      return;
    }
    abortRef.current?.abort();
    setStreaming(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void loadConversation(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // 卸载时中断。
  useEffect(() => () => abortRef.current?.abort(), []);

  function mapServerMessage(m: ServerChatMessage): ChatMessageView {
    const role: ChatMessageView["role"] = m.role === "assistant" ? "assistant" : "user";
    if (role === "user") return { message_id: m.message_id, role, content: m.content };
    const md = (m.metadata ?? {}) as Record<string, unknown>;
    const requestId = typeof md.request_id === "string" ? md.request_id : undefined;
    const cached = requestId ? citationCacheRef.current.get(requestId) : undefined;
    const docIds = Array.isArray(md.citation_doc_ids)
      ? (md.citation_doc_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const citations = cached ?? docIds.map((id) => ({ doc_id: id }));
    const fallback = typeof md.fallback_reason === "string" && md.fallback_reason ? md.fallback_reason : undefined;
    return {
      message_id: m.message_id,
      role,
      content: m.content,
      citations: citations.length ? citations : undefined,
      meta: {
        request_id: requestId,
        target_pod: typeof md.target_pod === "string" ? md.target_pod : undefined,
        fallback_reason: fallback
      }
    };
  }

  async function loadConversation(id: string) {
    setLoadingConvo(true);
    try {
      const data = await api<{ session: ChatSession; messages: ServerChatMessage[] }>(
        `/api/chat/sessions/${encodeURIComponent(id)}`
      );
      setMessages(data.messages.map(mapServerMessage));
    } catch (error) {
      toast.error("加载会话失败", { description: error instanceof Error ? error.message : "请求失败" });
    } finally {
      setLoadingConvo(false);
    }
  }

  async function createSession(title: string): Promise<string | null> {
    try {
      const res = await api<{ session_id: string }>("/api/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ title })
      });
      await sessionsQuery.refetch();
      return res.session_id;
    } catch (error) {
      toast.error("新建会话失败", { description: error instanceof Error ? error.message : "请求失败" });
      return null;
    }
  }

  async function newSession() {
    const id = await createSession("");
    if (id) {
      skipLoadRef.current = id; // 已是空会话，跳过冗余重载
      setMessages([]);
      setSelectedId(id);
    }
  }

  function patchAssistant(fn: (m: ChatMessageView) => ChatMessageView) {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant") {
          next[i] = fn(next[i]);
          break;
        }
      }
      return next;
    });
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming) return;

    let sid = selectedId;
    if (!sid) {
      const created = await createSession(content.slice(0, 40));
      if (!created) return;
      sid = created;
      skipLoadRef.current = created; // 别让切换 effect 打断接下来的流
      setSelectedId(created);
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");

    setMessages((prev) => [...prev, { role: "user", content }, { role: "assistant", content: "", streaming: true }]);
    setStreaming(true);

    let liveRequestId: string | undefined;
    let liveCitations: ChatCitation[] = [];

    streamChatSession(
      sid,
      content,
      {
        onRetrieval: (docs, info) => {
          liveRequestId = info.requestId;
          liveCitations = docs;
          patchAssistant((m) => ({
            ...m,
            citations: docs.length ? docs : m.citations,
            meta: { ...m.meta, request_id: info.requestId, retrieval_ms: info.retrievalMs }
          }));
        },
        onToken: (t) => patchAssistant((m) => ({ ...m, content: m.content + t })),
        onFallback: (reason) => patchAssistant((m) => ({ ...m, meta: { ...m.meta, fallback_reason: reason } })),
        onMetrics: (mx) =>
          patchAssistant((m) => ({
            ...m,
            meta: {
              ...m.meta,
              request_id: mx.request_id ?? m.meta?.request_id,
              ttft_ms: mx.ttft_ms,
              total_ms: mx.total_ms,
              retrieval_ms: mx.retrieval_ms ?? m.meta?.retrieval_ms,
              target_pod: mx.target_pod || m.meta?.target_pod,
              fallback_reason: mx.fallback_reason || m.meta?.fallback_reason
            }
          })),
        onError: (msg) =>
          patchAssistant((m) => ({ ...m, content: m.content ? `${m.content}\n\n⚠️ ${msg}` : `⚠️ ${msg}` })),
        onDone: () => {
          setStreaming(false);
          patchAssistant((m) => ({
            ...m,
            streaming: false,
            content: m.content || "（未收到回复，请确认 AI 服务 / 模型网关是否可用）"
          }));
          // 缓存本轮带标题的引用，供刷新后的历史消息复用。
          if (liveRequestId && liveCitations.length) citationCacheRef.current.set(liveRequestId, liveCitations);
          // 重载以获得 message_id（启用反馈）并刷新会话列表排序/标题。
          if (!controller.signal.aborted) {
            void loadConversation(sid);
            void sessionsQuery.refetch();
          }
        }
      },
      { signal: controller.signal, maxTokens: 1024, temperature: 0.2 }
    );
  }

  async function sendFeedback(messageId: string, rating: "up" | "down") {
    try {
      await api(`/api/chat/messages/${encodeURIComponent(messageId)}/feedback`, {
        method: "POST",
        body: JSON.stringify({ rating })
      });
      setMessages((prev) => prev.map((m) => (m.message_id === messageId ? { ...m, feedback: rating } : m)));
      toast.success(rating === "up" ? "已记录「有帮助」" : "已记录「无帮助」");
    } catch (error) {
      toast.error("反馈提交失败", { description: error instanceof Error ? error.message : "请求失败" });
    }
  }

  return {
    sessionsQuery,
    sessions,
    selectedSession,
    selectedId,
    selectSession: setSelectedId,
    messages,
    input,
    setInput,
    streaming,
    loadingConvo,
    send,
    newSession,
    sendFeedback
  };
}
