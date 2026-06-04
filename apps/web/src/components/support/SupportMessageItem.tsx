import { FileText, ThumbsDown, ThumbsUp } from "lucide-react";

import { MarkdownText } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import type { ChatMessageView } from "../../types/support";

// 单条消息（纯展示）：用户气泡 / 助手 Markdown + 检索引用 + 指标 + 反馈。
export function SupportMessageItem({
  message,
  onFeedback
}: {
  message: ChatMessageView;
  onFeedback: (messageId: string, rating: "up" | "down") => void;
}) {
  const isAssistant = message.role === "assistant";
  const showFoot = isAssistant && !message.streaming && (message.meta != null || message.message_id != null);

  return (
    <div className={cn("support-msg", message.role)}>
      <div className="support-bubble">
        {isAssistant ? <MarkdownText text={message.content || "…"} /> : <span>{message.content}</span>}
      </div>

      {isAssistant && message.citations?.length ? (
        <div className="support-citations">
          <span className="support-citations-label">
            <FileText size={12} /> 引用 {message.citations.length}
          </span>
          {message.citations.map((c) => (
            <span className="support-citation" key={c.doc_id} title={c.doc_id}>
              {c.title ?? c.doc_id}
              {typeof c.score === "number" ? ` · ${c.score.toFixed(2)}` : ""}
            </span>
          ))}
        </div>
      ) : null}

      {showFoot ? (
        <div className="support-msg-foot">
          <div className="support-meta">
            {message.meta?.target_pod ? <span>pod {message.meta.target_pod}</span> : null}
            {typeof message.meta?.ttft_ms === "number" ? <span>TTFT {Math.round(message.meta.ttft_ms)}ms</span> : null}
            {typeof message.meta?.total_ms === "number" ? <span>耗时 {Math.round(message.meta.total_ms)}ms</span> : null}
            {message.meta?.fallback_reason ? (
              <span className="support-fallback">兜底 · {message.meta.fallback_reason}</span>
            ) : null}
          </div>
          {message.message_id ? (
            <div className="support-feedback">
              <button
                className={cn(message.feedback === "up" && "active")}
                onClick={() => onFeedback(message.message_id!, "up")}
                title="有帮助"
                type="button"
              >
                <ThumbsUp size={13} />
              </button>
              <button
                className={cn(message.feedback === "down" && "active down")}
                onClick={() => onFeedback(message.message_id!, "down")}
                title="无帮助"
                type="button"
              >
                <ThumbsDown size={13} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
