import { ListChecks, Play, Plus, Trash2, X } from "lucide-react";

import { PanelHeader } from "../common/PlatformPrimitives";
import { EvalDocPicker } from "./EvalDocPicker";
import { cn } from "../../lib/utils";
import type { RetrievalEval } from "../../lib/useRetrievalEval";

const TOP_K_OPTIONS = [1, 3, 5];

// 评测样本构建器：问题 + gold 文档 → 样本列表 + Top-K + 运行。绑定 useRetrievalEval。
export function EvalSampleBuilder({ ev }: { ev: RetrievalEval }) {
  const canAdd = ev.draftQuestion.trim().length > 0 && ev.draftGoldIds.length > 0;

  return (
    <section className="infra-panel eval-builder">
      <PanelHeader title="评测样本" action={`${ev.samples.length} 条`} />

      <div className="eval-draft">
        <textarea
          className="eval-question-input"
          onChange={(e) => ev.setDraftQuestion(e.target.value)}
          placeholder="输入一个用户问题…"
          rows={2}
          value={ev.draftQuestion}
        />
        <div className="eval-gold-label">选择标准答案文档（gold） · 已选 {ev.draftGoldIds.length}</div>
        <EvalDocPicker
          docs={ev.docs}
          loading={ev.docsQuery.isLoading}
          error={ev.docsQuery.error}
          onRetry={ev.docsQuery.refetch}
          selectedIds={ev.draftGoldIds}
          onToggle={ev.toggleGold}
        />
        <button className="eval-add-btn" disabled={!canAdd} onClick={ev.addSample} type="button">
          <Plus size={14} /> 添加样本
        </button>
      </div>

      {ev.samples.length > 0 ? (
        <div className="eval-sample-list">
          {ev.samples.map((s, i) => (
            <div className="eval-sample-row" key={i}>
              <span className="eval-sample-idx">{i + 1}</span>
              <div className="eval-sample-body">
                <strong>{s.question}</strong>
                <div className="eval-sample-gold">
                  {s.doc_ids.map((id) => (
                    <span className="eval-gold-chip" key={id} title={id}>
                      {ev.docTitle.get(id) ?? id}
                    </span>
                  ))}
                </div>
              </div>
              <button className="eval-sample-remove" onClick={() => ev.removeSample(i)} title="移除" type="button">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="eval-builder-hint">
          <ListChecks size={14} /> 每条样本 = 一个问题 + 它应命中的知识文档；加完后点「运行评测」。
        </p>
      )}

      <div className="eval-run-bar">
        <div className="eval-topk">
          <span>Top-K</span>
          {TOP_K_OPTIONS.map((k) => (
            <button className={cn(ev.topK === k && "active")} key={k} onClick={() => ev.setTopK(k)} type="button">
              {k}
            </button>
          ))}
        </div>
        {ev.samples.length > 0 ? (
          <button className="eval-clear" onClick={ev.clearSamples} type="button">
            <Trash2 size={13} /> 清空
          </button>
        ) : null}
        <button className="eval-run-btn" disabled={ev.running || ev.samples.length === 0} onClick={() => void ev.run()} type="button">
          <Play size={14} /> {ev.running ? "评测中…" : "运行评测"}
        </button>
      </div>
    </section>
  );
}
