// 统一反馈组件（企业级横切能力 §8.3）
//
// 提供 Loading 骨架屏 / Empty 空状态 / Error 错误态 / QueryBoundary。
// 目标：替代各页 "catch 后静默塞 mock" 的做法，让用户能明确区分
// "真实数据 / 加载中 / 无数据 / 出错可重试"。

import { AlertTriangle, Inbox, RefreshCw, type LucideIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { ApiError } from "../../lib/api";

/** 骨架屏：用于首次加载占位，避免内容跳动。 */
export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={`infra-skeleton ${className ?? ""}`} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="infra-skeleton-row" style={{ width: `${100 - i * 8}%` }} />
      ))}
    </div>
  );
}

/** 空状态：无数据时的引导。 */
export function EmptyState({
  title = "暂无数据",
  description,
  icon: Icon = Inbox,
  action
}: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="infra-feedback-state empty" role="status">
      <Icon size={28} className="infra-feedback-icon" />
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/** 错误态：显式展示错误并提供重试，区别于静默兜底。 */
export function ErrorState({
  error,
  onRetry,
  title = "加载失败"
}: {
  error?: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const message = describeError(error);
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="infra-feedback-state error" role="alert">
      <AlertTriangle size={28} className="infra-feedback-icon" />
      <strong>{title}</strong>
      {message && <p>{message}</p>}
      {requestId && <small className="infra-feedback-trace">request-id: {requestId}</small>}
      {onRetry && (
        <button className="ghost-button" type="button" onClick={onRetry}>
          <RefreshCw size={13} /> 重试
        </button>
      )}
    </div>
  );
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return error.message; // 网络/超时
    return `${error.message}（HTTP ${error.status}）`;
  }
  if (error instanceof Error) return error.message;
  return "未知错误";
}

/**
 * QueryBoundary：统一处理 react-query 的 isLoading/isError/empty 三态。
 * 用法：
 *   <QueryBoundary query={q} isEmpty={(d) => d.items.length === 0}>
 *     {(data) => <Table data={data} />}
 *   </QueryBoundary>
 */
export function QueryBoundary<T>({
  query,
  children,
  isEmpty,
  skeletonRows,
  emptyProps
}: {
  query: { data?: T; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void };
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  skeletonRows?: number;
  emptyProps?: Parameters<typeof EmptyState>[0];
}) {
  if (query.isLoading) return <Skeleton rows={skeletonRows} />;
  if (query.isError || query.data === undefined) {
    return <ErrorState error={query.error} onRetry={query.refetch} />;
  }
  if (isEmpty?.(query.data)) return <EmptyState {...emptyProps} />;
  return <>{children(query.data)}</>;
}

/** 页面级错误边界：避免单页渲染异常导致整站白屏。 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean; error?: unknown }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // 后续可接入前端遥测（Sentry 类，§8.5）。
    console.error("[ErrorBoundary]", error, info);
  }

  handleReset = () => this.setState({ hasError: false, error: undefined });

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="infra-page">
            <ErrorState title="页面出错了" error={this.state.error} onRetry={this.handleReset} />
          </div>
        )
      );
    }
    return this.props.children;
  }
}
