// 智能客服（RAG 会话）数据形状。后端：/api/chat/*（会话/消息/反馈 → PostgreSQL）。
import type { ChatCitation } from "../lib/api";

export type { ChatCitation };

export type ChatSession = {
  session_id: string;
  title: string;
  user_role?: string;
  kind?: string;
  created_at: string;
  updated_at: string;
};

// GET /api/chat/sessions/{id} 返回的持久化消息。
export type ServerChatMessage = {
  message_id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
};

export type ChatMessageMeta = {
  request_id?: string;
  target_pod?: string;
  fallback_reason?: string;
  ttft_ms?: number | null;
  total_ms?: number | null;
  retrieval_ms?: number | null;
};

// 视图层消息：合并了流式态（streaming）与本地反馈态（feedback）。
export type ChatMessageView = {
  message_id?: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  meta?: ChatMessageMeta;
  streaming?: boolean;
  feedback?: "up" | "down";
};
