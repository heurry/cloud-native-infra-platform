import { PageHeader } from "../components/common/PlatformPrimitives";
import { EvalSampleBuilder } from "../components/eval/EvalSampleBuilder";
import { EvalResultPanel } from "../components/eval/EvalResultPanel";
import { useRetrievalEval } from "../lib/useRetrievalEval";

// 检索评测页：仅组合（构建器 + 结果），逻辑全在 useRetrievalEval。
export function RetrievalEvalPage() {
  const ev = useRetrievalEval();
  return (
    <section className="infra-page eval-page">
      <PageHeader
        title="检索评测"
        subtitle="对知识库（基准测试日志）做检索召回评测：每条样本 = 问题 + 标准答案文档，计算 recall@1 / @3 / @5"
      />
      <div className="eval-layout">
        <EvalSampleBuilder ev={ev} />
        <EvalResultPanel result={ev.result} running={ev.running} />
      </div>
    </section>
  );
}
