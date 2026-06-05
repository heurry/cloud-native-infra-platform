// E2：反馈回流数据集面板——概览计数 + 由 👍 回答派生的检索样本（问题 → gold 文档）。
import { ThumbsUp, ThumbsDown } from "lucide-react";

import { StatusBadge } from "../common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import type { FeedbackReflow } from "../../lib/useFeedbackReflow";

export function ReflowDatasetPanel({ reflow }: { reflow: FeedbackReflow }) {
  const { dataset } = reflow;
  if (dataset.isLoading) return <Skeleton rows={4} />;
  if (dataset.isError) return <ErrorState error={dataset.error} onRetry={dataset.refetch} />;

  const summary = dataset.data?.summary;
  const samples = dataset.data?.samples ?? [];

  return (
    <div className="reflow-dataset">
      <div className="reflow-summary">
        <div className="reflow-stat">
          <span>反馈总数</span>
          <strong>{summary?.total_feedback ?? 0}</strong>
        </div>
        <div className="reflow-stat tone-up">
          <span><ThumbsUp size={13} /> 有帮助</span>
          <strong>{summary?.up ?? 0}</strong>
        </div>
        <div className="reflow-stat tone-down">
          <span><ThumbsDown size={13} /> 无帮助</span>
          <strong>{summary?.down ?? 0}</strong>
        </div>
        <div className="reflow-stat tone-usable">
          <span>可用 gold 样本</span>
          <strong>{summary?.usable_samples ?? 0}</strong>
        </div>
      </div>

      {samples.length === 0 ? (
        <EmptyState
          title="暂无反馈样本"
          description="去「智能客服」对回答点 👍/👎，被赞且有引用的回答会自动回流成评测样本"
        />
      ) : (
        <table className="infra-table reflow-table">
          <thead>
            <tr>{["问题", "Gold 文档", "评价", "时间"].map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {samples.map((s) => (
              <tr key={s.message_id}>
                <td className="reflow-q">{s.question || <span className="cell-subtle">（无前置问题）</span>}</td>
                <td>{s.gold_doc_ids.length ? s.gold_doc_ids.join(", ") : <span className="cell-subtle">—</span>}</td>
                <td><StatusBadge status={s.rating === "up" ? "enabled" : "warning"} /></td>
                <td className="cell-subtle">{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
