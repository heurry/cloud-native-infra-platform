import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "./api";
import type { EvalRunResult, KnowledgeDoc, QASample } from "../types/eval";

export type RetrievalEval = ReturnType<typeof useRetrievalEval>;

// useRetrievalEval：检索召回评测的状态机 —— 真实知识文档拉取、样本草稿/列表、运行评测。
// 视图层只消费返回值（结构分层）。gold 文档来自真实 /api/knowledge/documents。
export function useRetrievalEval() {
  const [topK, setTopK] = useState(3);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [draftGoldIds, setDraftGoldIds] = useState<string[]>([]);
  const [samples, setSamples] = useState<QASample[]>([]);
  const [result, setResult] = useState<EvalRunResult | null>(null);
  const [running, setRunning] = useState(false);

  const docsQuery = useQuery({
    queryKey: ["knowledge-documents", "eval"],
    queryFn: () => api<{ documents: KnowledgeDoc[] }>("/api/knowledge/documents?limit=100")
  });
  const docs = docsQuery.data?.documents ?? [];

  const docTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of docs) map.set(d.doc_id, d.title || d.doc_id);
    return map;
  }, [docs]);

  function toggleGold(docId: string) {
    setDraftGoldIds((prev) => (prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]));
  }

  function addSample() {
    const question = draftQuestion.trim();
    if (!question || draftGoldIds.length === 0) return;
    setSamples((prev) => [...prev, { question, doc_ids: [...draftGoldIds] }]);
    setDraftQuestion("");
    setDraftGoldIds([]);
  }

  function removeSample(index: number) {
    setSamples((prev) => prev.filter((_, i) => i !== index));
  }

  function clearSamples() {
    setSamples([]);
  }

  async function run() {
    if (running || samples.length === 0) return;
    setRunning(true);
    try {
      const res = await api<EvalRunResult>("/api/evals/customer-support", {
        method: "POST",
        body: JSON.stringify({ qa_samples: samples, top_k: topK }),
        timeoutMs: 120_000 // 每条样本要 embed + 检索，给足超时
      });
      setResult(res);
      toast.success("评测完成", {
        description: `${res.metrics.num_samples} 条 · recall@3 ${(res.metrics.retrieval_recall_at_3 * 100).toFixed(0)}%`
      });
    } catch (error) {
      toast.error("评测失败", { description: error instanceof Error ? error.message : "请求失败" });
    } finally {
      setRunning(false);
    }
  }

  return {
    docsQuery,
    docs,
    docTitle,
    topK,
    setTopK,
    draftQuestion,
    setDraftQuestion,
    draftGoldIds,
    toggleGold,
    samples,
    addSample,
    removeSample,
    clearSamples,
    result,
    running,
    run
  };
}
