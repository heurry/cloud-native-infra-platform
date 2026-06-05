// E2：反馈回流状态机 hook —— 回流数据集 + 重排信号 + 离线评测基线，统一 toast + 失效。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { describeError } from "../components/common/FeedbackStates";
import { ragDataset, ragEvalHistory, ragSignal, runRagEval } from "./api";

export type FeedbackReflow = ReturnType<typeof useFeedbackReflow>;

export function useFeedbackReflow() {
  const qc = useQueryClient();

  const dataset = useQuery({
    queryKey: ["rag", "dataset"],
    queryFn: ragDataset,
    refetchInterval: 20000
  });

  const signal = useQuery({
    queryKey: ["rag", "signal"],
    queryFn: ragSignal,
    refetchInterval: 20000
  });

  const history = useQuery({
    queryKey: ["rag", "eval-history"],
    queryFn: () => ragEvalHistory(20),
    refetchInterval: 20000
  });

  const runEval = useMutation({
    mutationFn: runRagEval,
    onSuccess: (res) => {
      const r3 = (res.metrics.retrieval_recall_at_3 * 100).toFixed(0);
      toast.success("离线评测完成", { description: `${res.metrics.num_samples} 条样本 · recall@3 ${r3}%` });
      void qc.invalidateQueries({ queryKey: ["rag", "eval-history"] });
    },
    onError: (e) => toast.error(`评测失败：${describeError(e)}`)
  });

  return { dataset, signal, history, runEval };
}
