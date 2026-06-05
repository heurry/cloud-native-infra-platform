// E2：离线评测基线面板——对回流数据集跑 recall@k，展示最新指标 + 历史趋势（接 B2）。
import { PlayCircle } from "lucide-react";

import { Sparkline } from "../common/PlatformPrimitives";
import { EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import type { FeedbackReflow } from "../../lib/useFeedbackReflow";

function pct(v: number | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}

export function EvalBaselinePanel({ reflow }: { reflow: FeedbackReflow }) {
  const { history, runEval, dataset } = reflow;
  const usable = dataset.data?.summary.usable_samples ?? 0;
  const runs = history.data?.runs ?? [];
  const latest = runs[0]?.metrics;
  // 历史趋势（旧→新）：recall@3 折线。
  const trend = [...runs].reverse().map((r) => r.metrics.retrieval_recall_at_3 ?? 0);

  return (
    <div className="eval-baseline">
      <div className="eval-baseline-head">
        <div className="eval-recall-cards">
          <div className="eval-recall"><span>recall@1</span><strong>{pct(latest?.retrieval_recall_at_1)}</strong></div>
          <div className="eval-recall"><span>recall@3</span><strong>{pct(latest?.retrieval_recall_at_3)}</strong></div>
          <div className="eval-recall"><span>recall@5</span><strong>{pct(latest?.retrieval_recall_at_5)}</strong></div>
          <div className="eval-recall"><span>样本</span><strong>{latest?.num_samples ?? "—"}</strong></div>
        </div>
        <button
          className="console-refresh primary"
          type="button"
          disabled={runEval.isPending || usable === 0}
          title={usable === 0 ? "需要先回流可用 gold 样本（👍 回答）" : "对回流数据集跑离线评测"}
          onClick={() => runEval.mutate()}
        >
          <PlayCircle size={14} /> {runEval.isPending ? "评测中…" : "运行评测"}
        </button>
      </div>

      {history.isLoading ? (
        <Skeleton rows={2} />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={history.refetch} />
      ) : runs.length === 0 ? (
        <EmptyState title="暂无评测基线" description="点「运行评测」对回流数据集计算 recall@k 并记录基线" />
      ) : (
        <div className="eval-history">
          <div className="eval-trend">
            <span className="cell-subtle">recall@3 趋势（{runs.length} 次）</span>
            {trend.length > 1 && <Sparkline values={trend} tone="success" width={160} height={36} />}
          </div>
          <table className="infra-table">
            <thead>
              <tr>{["时间", "样本", "recall@1", "recall@3", "recall@5"].map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id}>
                  <td className="cell-subtle">{new Date(r.created_at).toLocaleString()}</td>
                  <td>{r.metrics.num_samples}</td>
                  <td>{pct(r.metrics.retrieval_recall_at_1)}</td>
                  <td>{pct(r.metrics.retrieval_recall_at_3)}</td>
                  <td>{pct(r.metrics.retrieval_recall_at_5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
