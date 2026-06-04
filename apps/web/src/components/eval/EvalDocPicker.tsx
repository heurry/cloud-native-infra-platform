import { useState } from "react";
import { Check, FileText, Search } from "lucide-react";

import { EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import { cn } from "../../lib/utils";
import type { KnowledgeDoc } from "../../types/eval";

// 标准答案（gold）文档多选：来自真实知识库文档，本地负责筛选 UI 态。
export function EvalDocPicker({
  docs,
  loading,
  error,
  onRetry,
  selectedIds,
  onToggle
}: {
  docs: KnowledgeDoc[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedIds: string[];
  onToggle: (docId: string) => void;
}) {
  const [filter, setFilter] = useState("");

  if (loading) return <Skeleton rows={4} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (docs.length === 0) {
    return <EmptyState title="知识库为空" description="请先在「知识库 / RAG」灌入文档并重建索引" />;
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? docs.filter(
        (d) =>
          (d.title ?? "").toLowerCase().includes(q) ||
          d.doc_id.toLowerCase().includes(q) ||
          (d.category ?? "").toLowerCase().includes(q)
      )
    : docs;

  return (
    <div className="eval-doc-picker">
      <label className="eval-doc-search">
        <Search size={13} />
        <input onChange={(e) => setFilter(e.target.value)} placeholder="筛选文档（标题 / 分类 / doc_id）" value={filter} />
      </label>
      <div className="eval-doc-list">
        {shown.length === 0 ? (
          <p className="eval-doc-empty">无匹配文档</p>
        ) : (
          shown.map((d) => {
            const active = selectedIds.includes(d.doc_id);
            return (
              <button
                className={cn("eval-doc-item", active && "active")}
                key={d.doc_id}
                onClick={() => onToggle(d.doc_id)}
                type="button"
              >
                <span className={cn("eval-doc-check", active && "on")}>{active ? <Check size={12} /> : null}</span>
                <FileText size={14} />
                <span className="eval-doc-text">
                  <strong>{d.title || d.doc_id}</strong>
                  <small>{[d.category, d.doc_id].filter(Boolean).join(" · ")}</small>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
