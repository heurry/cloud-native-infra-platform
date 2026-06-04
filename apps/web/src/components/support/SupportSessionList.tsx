import { PanelHeader } from "../common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { ChatSession } from "../../types/support";

// 会话侧栏（纯展示）：状态/数据由 useSupportChat 提供。
export function SupportSessionList({
  sessions,
  selectedId,
  isLoading,
  isError,
  error,
  onRetry,
  onSelect
}: {
  sessions: ChatSession[];
  selectedId: string;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="infra-panel support-sessions">
      <PanelHeader title="会话" action={`${sessions.length} 个`} />
      <div className="support-session-list">
        {isLoading ? (
          <Skeleton rows={4} />
        ) : isError ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : sessions.length === 0 ? (
          <EmptyState title="暂无会话" description="点击「新建会话」开始一段客服对话" />
        ) : (
          sessions.map((session) => (
            <button
              className={cn("support-session-item", selectedId === session.session_id && "active")}
              key={session.session_id}
              onClick={() => onSelect(session.session_id)}
              type="button"
            >
              <span className="support-session-title">{session.title || "未命名会话"}</span>
              <small>
                {relativeTime(session.updated_at)}
                {session.user_role ? ` · ${session.user_role}` : ""}
              </small>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
