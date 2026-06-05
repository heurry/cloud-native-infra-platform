// E2：反馈重排信号面板——被引文档的赞/踩净分（在线重排的输入信号）。
import { StatusBadge } from "../common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import type { FeedbackReflow } from "../../lib/useFeedbackReflow";

export function RerankSignalPanel({ reflow }: { reflow: FeedbackReflow }) {
  const { signal } = reflow;
  if (signal.isLoading) return <Skeleton rows={3} />;
  if (signal.isError) return <ErrorState error={signal.error} onRetry={signal.refetch} />;

  const docs = signal.data?.docs ?? [];
  const enabled = signal.data?.rerank_enabled ?? false;
  const maxAbs = Math.max(1, ...docs.map((d) => Math.abs(d.net)));

  return (
    <div className="rerank-signal">
      <div className="rerank-head">
        <StatusBadge status={enabled ? "enabled" : "read-only"} />
        <span className="cell-subtle">
          {enabled
            ? "在线重排已开启：chat 检索按净分微调候选排序"
            : "信号已就绪（RAG_RERANK_FEEDBACK=false：仅采集，不影响线上检索）"}
        </span>
      </div>

      {docs.length === 0 ? (
        <EmptyState title="暂无重排信号" description="被引用文档收到 👍/👎 后，这里聚合每篇文档的净分" />
      ) : (
        <div className="rerank-rows">
          {docs.map((d) => (
            <div className="rerank-row" key={d.doc_id}>
              <div className="rerank-doc">
                <strong>{d.title || d.doc_id}</strong>
                <span className="cell-subtle">{d.doc_id}</span>
              </div>
              <div className="rerank-bar-wrap">
                <div className="rerank-bar">
                  <i
                    className={d.net >= 0 ? "pos" : "neg"}
                    style={{ width: `${(Math.abs(d.net) / maxAbs) * 100}%` }}
                  />
                </div>
                <span className={`rerank-net ${d.net >= 0 ? "pos" : "neg"}`}>{d.net > 0 ? `+${d.net}` : d.net}</span>
              </div>
              <span className="rerank-votes cell-subtle">👍 {d.up} · 👎 {d.down}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
