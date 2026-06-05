// E3：A/B 对比面板——主路各候选 vs 影子的样本量 / p95 延迟 / 错误率（来自 routing_samples 聚合）。
import { useQuery } from "@tanstack/react-query";

import { routingPolicyStats } from "../../lib/api";
import { EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import type { VariantStat } from "../../types/routing";

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// 一组指标条：以组内最大值为标尺，便于横向比较 p95 / 样本量。
function MetricBars({ rows, maxP95, tone }: { rows: VariantStat[]; maxP95: number; tone: "primary" | "shadow" }) {
  return (
    <div className="routing-cmp-rows">
      {rows.map((r) => (
        <div className="routing-cmp-row" key={`${tone}-${r.label}`}>
          <div className="routing-cmp-head">
            <strong>{r.label}</strong>
            <span className="cell-subtle">{r.endpoint || "—"}</span>
          </div>
          <div className="routing-cmp-metrics">
            <span title="样本量">{r.count} 次</span>
            <span title="平均延迟">avg {r.avg_ms}ms</span>
            <span className={r.error_rate > 0 ? "routing-warn" : undefined} title="错误率">err {pct(r.error_rate)}</span>
          </div>
          <div className={`routing-cmp-bar ${tone}`}>
            <i style={{ width: `${maxP95 > 0 ? Math.max(4, (r.p95_ms / maxP95) * 100) : 0}%` }} />
            <em>p95 {r.p95_ms}ms</em>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ABComparison({ policyName }: { policyName: string }) {
  const stats = useQuery({
    queryKey: ["routing", "stats", policyName],
    queryFn: () => routingPolicyStats(policyName, 3600),
    refetchInterval: 15000
  });

  if (stats.isLoading) return <Skeleton rows={3} />;
  if (stats.isError) return <ErrorState error={stats.error} onRetry={stats.refetch} />;

  const variants = stats.data?.variants ?? [];
  const shadow = stats.data?.shadow ?? [];
  if (variants.length === 0 && shadow.length === 0) {
    return <EmptyState title="暂无路由样本" description="经 /api/routing/{policy}/v1/chat/completions 路由一些请求后，这里出现 A/B 对比" />;
  }
  const maxP95 = Math.max(1, ...variants.map((v) => v.p95_ms), ...shadow.map((v) => v.p95_ms));

  return (
    <div className="routing-cmp">
      <div className="routing-cmp-col">
        <span className="routing-cmp-title">主路候选（最近 1h）</span>
        <MetricBars rows={variants} maxP95={maxP95} tone="primary" />
      </div>
      {shadow.length > 0 && (
        <div className="routing-cmp-col">
          <span className="routing-cmp-title">影子目标（镜像对照）</span>
          <MetricBars rows={shadow} maxP95={maxP95} tone="shadow" />
        </div>
      )}
    </div>
  );
}
