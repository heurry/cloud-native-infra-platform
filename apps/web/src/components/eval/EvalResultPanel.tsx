import { PanelHeader } from "../common/PlatformPrimitives";
import { EmptyState } from "../common/FeedbackStates";
import { cn } from "../../lib/utils";
import type { EvalRunResult } from "../../types/eval";

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}
function recallTone(v: number): "success" | "warning" | "danger" {
  if (v >= 0.8) return "success";
  if (v >= 0.5) return "warning";
  return "danger";
}

// 评测结果：聚合 recall 指标卡 + 逐样本对错明细（命中以 gold 高亮）。
export function EvalResultPanel({ result, running }: { result: EvalRunResult | null; running: boolean }) {
  return (
    <section className="infra-panel eval-result">
      <PanelHeader title="评测结果" action={result ? `run ${result.run_id.slice(0, 8)}` : running ? "评测中…" : "—"} />

      {!result ? (
        running ? (
          <EmptyState title="评测进行中…" description="正在对每条样本做检索并计算召回" />
        ) : (
          <EmptyState title="尚未运行评测" description="在左侧构建样本后点击「运行评测」" />
        )
      ) : (
        <>
          <div className="eval-metric-grid">
            <Metric label="样本数" value={String(result.metrics.num_samples)} />
            <Metric label="Recall@1" value={pct(result.metrics.retrieval_recall_at_1)} tone={recallTone(result.metrics.retrieval_recall_at_1)} />
            <Metric label="Recall@3" value={pct(result.metrics.retrieval_recall_at_3)} tone={recallTone(result.metrics.retrieval_recall_at_3)} />
            <Metric label="Recall@5" value={pct(result.metrics.retrieval_recall_at_5)} tone={recallTone(result.metrics.retrieval_recall_at_5)} />
          </div>

          {result.samples?.length ? (
            <div className="eval-case-table">
              <div className="eval-case-row header">
                <span>问题</span>
                <span>@1</span>
                <span>@3</span>
                <span>@5</span>
                <span>检索结果（gold 高亮）</span>
              </div>
              {result.samples.map((c, i) => (
                <div className="eval-case-row" key={i}>
                  <span className="eval-case-q" title={c.question}>{c.question}</span>
                  <Hit ok={c.hit_at_1} />
                  <Hit ok={c.hit_at_3} />
                  <Hit ok={c.hit_at_5} />
                  <span className="eval-case-retrieved">
                    {c.retrieved_doc_ids.length === 0 ? (
                      <em>无</em>
                    ) : (
                      c.retrieved_doc_ids.map((id, idx) => (
                        <span className={cn("eval-ret-chip", c.gold_doc_ids.includes(id) && "gold")} key={`${id}-${idx}`} title={id}>
                          {id}
                        </span>
                      ))
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="eval-builder-hint">该后端版本未返回逐样本明细，仅展示聚合指标。</p>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className={cn("eval-metric", tone)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Hit({ ok }: { ok: boolean }) {
  return <span className={cn("eval-hit", ok ? "ok" : "miss")}>{ok ? "✓" : "✗"}</span>;
}
