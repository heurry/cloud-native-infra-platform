// E2：反馈回流 / RAG 评测页（薄组合）。把客服 👍/👎 反馈回流成评测数据集 + 重排信号，
// 并对回流数据集跑离线 recall@k 基线（接 B2）。闭合「对话反馈 → 评测/重排 → 模型/检索改进」。
import { RefreshCw } from "lucide-react";

import { ClosedLoopRibbon, PageHeader, PanelHeader } from "../components/common/PlatformPrimitives";
import { ReflowDatasetPanel } from "../components/feedback/ReflowDatasetPanel";
import { RerankSignalPanel } from "../components/feedback/RerankSignalPanel";
import { EvalBaselinePanel } from "../components/feedback/EvalBaselinePanel";
import { useFeedbackReflow } from "../lib/useFeedbackReflow";
import { useGoToPage } from "../lib/useGoToPage";

export function FeedbackReflowPage() {
  const reflow = useFeedbackReflow();
  const goTo = useGoToPage();

  return (
    <section className="infra-page feedback-page">
      <PageHeader
        title="反馈回流 / RAG 评测"
        subtitle="客服 👍/👎 反馈回流成检索评测数据集 + 重排信号，并对回流数据集跑离线 recall@k 基线"
        actions={
          <button
            className="console-refresh"
            type="button"
            onClick={() => {
              reflow.dataset.refetch();
              reflow.signal.refetch();
              reflow.history.refetch();
            }}
          >
            <RefreshCw className={reflow.dataset.isFetching ? "spinning" : undefined} size={14} /> 刷新
          </button>
        }
      />

      <ClosedLoopRibbon
        stages={[
          { id: "chat", label: "对话反馈", detail: "智能客服 👍/👎", state: "done" },
          { id: "reflow", label: "回流数据集", detail: "👍 → 问题 + gold", state: "active" },
          { id: "eval", label: "离线评测", detail: "recall@k 基线（接 B2）", state: "active" },
          { id: "improve", label: "重排 / 改进", detail: "净分信号反哺检索", state: "pending" }
        ]}
        rightAction={{ label: "去智能客服 →", onClick: () => goTo("support") }}
      />

      <section className="infra-panel">
        <PanelHeader title="离线评测基线" action="对回流数据集计算 recall@1 / @3 / @5（原始检索，规避数据泄漏）" />
        <EvalBaselinePanel reflow={reflow} />
      </section>

      <div className="feedback-grid">
        <section className="infra-panel">
          <PanelHeader title="回流数据集" action="👍 回答 → 问题 + gold 文档" />
          <ReflowDatasetPanel reflow={reflow} />
        </section>
        <section className="infra-panel">
          <PanelHeader title="重排信号" action="被引文档赞/踩净分" />
          <RerankSignalPanel reflow={reflow} />
        </section>
      </div>
    </section>
  );
}
