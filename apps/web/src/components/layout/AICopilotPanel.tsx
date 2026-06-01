import { AlertTriangle, CheckCircle, RefreshCw, Search, Send, Sparkles, X } from "lucide-react";

import { cn } from "../../lib/utils";
import { PLATFORM_MODEL_ID } from "../../data/mockPlatformData";
import { type Page } from "../../types/navigation";

type CopilotAction = {
  label: string;
  page?: Page;
  tone?: "primary" | "secondary";
  cta?: string;
  description?: string;
};

type CopilotContent = {
  tone: "warning" | "info" | "success" | "danger";
  alertTitle: string;
  alertText: string;
  // unified pattern: 当前问题 → 影响对象 → 推荐动作
  currentIssue: string;
  affectedObjects: string[];
  recommendedActions: CopilotAction[];
  summaryLabel: string;
  summary: string;
  evidence: Array<[string, string]>;
  placeholder: string;
  detectedAt?: string;
  relatedAlerts?: string;
  severityLabel?: string;
};

const copilotContent: Record<Page, CopilotContent> = {
  dashboard: {
    tone: "warning",
    alertTitle: "检测到 2 个严重问题",
    alertText: "订单服务 P95 延迟升高，推荐服务可用性下降。",
    currentIssue: "Serving 延迟与 GPU 压力同时升高",
    affectedObjects: ["AI Gateway", "vLLM 副本", "redis-config"],
    recommendedActions: [
      { label: "订单服务性能优化", page: "observability", tone: "primary", cta: "性能优化", description: "订单服务 P95 延迟 320ms，建议检查数据库连接池和慢查询。" },
      { label: "推荐服务可用性恢复", page: "aiOps", tone: "secondary", cta: "可用性", description: "推荐服务可用性 96.20%，建议检查 Pod 资源和依赖服务。" },
      { label: "扩缩容建议", page: "kubernetes", tone: "secondary", cta: "弹性伸缩", description: "检测到业务高峰，建议扩容 3 个服务实例。" }
    ],
    summaryLabel: "平台诊断",
    summary: "下一次生产发布前，优先检查 AI Gateway 路由、vLLM 副本均衡和最新 redis-config 漂移。",
    evidence: [["健康分", "96"], ["TTFT P95", "42 ms"], ["打开的 Incident", "3"]],
    placeholder: "询问平台风险..."
  },
  services: {
    tone: "warning",
    alertTitle: "发现路由倾斜",
    alertText: "流量正在偏向一个 vLLM 目标 Pod。",
    currentIssue: "路由倾斜：流量集中在单个 Pod",
    affectedObjects: ["aibrix-gateway", "vllm-replica-1"],
    recommendedActions: [
      { label: "诊断路由", page: "aiOps", tone: "primary" },
      { label: "复核 Canary", page: "pipelines", tone: "secondary" }
    ],
    summaryLabel: "服务治理",
    summary: "提高 Canary 流量前，先检查 least-request 路由、fallback 策略和副本健康。",
    evidence: [["策略", "least-request"], ["目标 Pod", "vllm-replica-1"], ["P95", "145 ms"]],
    placeholder: "询问服务路由..."
  },
  kubernetes: {
    tone: "warning",
    alertTitle: "GPU 调度压力",
    alertText: "一个模型副本接近 GPU 显存饱和。",
    currentIssue: "GPU 调度压力：1 个 Pod Pending",
    affectedObjects: [PLATFORM_MODEL_ID, "gpu-node-b", "default namespace"],
    recommendedActions: [
      { label: "扩容 GPU 节点", page: "kubernetes", tone: "primary" },
      { label: "调整 HPA", page: "kubernetes", tone: "secondary" }
    ],
    summaryLabel: "集群诊断",
    summary: "检查模型服务命名空间的 GPU 节点分配、等待中的工作负载、重启事件和 HPA 状态。",
    evidence: [["GPU 利用率", "90%"], ["重启", "3"], ["命名空间", "default"]],
    placeholder: "询问 Pod 或 GPU 事件..."
  },
  observability: {
    tone: "info",
    alertTitle: "Trace 关联可用",
    alertText: "Metrics、请求 Trace 和目标 Pod 分布可以关联分析。",
    currentIssue: "Trace 与 Metrics 已关联，可进入 RCA",
    affectedObjects: ["aibrix-gateway", PLATFORM_MODEL_ID],
    recommendedActions: [
      { label: "打开 AI Ops", page: "aiOps", tone: "primary" }
    ],
    summaryLabel: "可观测性摘要",
    summary: "先看 P95/TTFT 趋势，再检查最近慢请求目标和 upstream 运行时指标。",
    evidence: [["P95", "145 ms"], ["错误率", "0.23%"], ["Trace 窗口", "15m"]],
    placeholder: "询问指标趋势..."
  },
  aiOps: {
    tone: "info",
    alertTitle: "诊断流程进行中",
    alertText: "证据收集和动作计划已可复核。",
    currentIssue: "INC-0427：延迟回退，RCA 置信度 78%",
    affectedObjects: [PLATFORM_MODEL_ID, "redis-cache", "vllm-1"],
    recommendedActions: [
      { label: "复核动作", page: "aiOps", tone: "primary" },
      { label: "查看证据", page: "observability", tone: "secondary" }
    ],
    summaryLabel: "当前诊断步骤",
    summary: "先验证指标证据并检查配置变更，再审批低风险路由再均衡或扩容建议。",
    evidence: [["阶段", "Evidence"], ["置信度", "0.78"], ["动作", "3"]],
    placeholder: "询问 Root Cause..."
  },
  knowledge: {
    tone: "info",
    alertTitle: "Runbook 覆盖需要复核",
    alertText: "部分 Incident 类别缺少新鲜检索证据。",
    currentIssue: "知识库覆盖偏低：部分 Incident 类别无 Runbook",
    affectedObjects: ["Incident Runbook", "Benchmark 报告"],
    recommendedActions: [
      { label: "打开知识库", page: "knowledge", tone: "primary" }
    ],
    summaryLabel: "知识库状态",
    summary: "刷新配置历史、Benchmark 报告和 Kubernetes Runbook，让 AI Ops 可以引用更强证据。",
    evidence: [["索引", "ready"], ["Top-K", "5"], ["新鲜度", "2h"]],
    placeholder: "询问证据覆盖..."
  },
  benchmarks: {
    tone: "warning",
    alertTitle: "Benchmark 门禁待处理",
    alertText: "Canary Serving 版本仍需回归对比。",
    currentIssue: "Canary 版本未通过 Benchmark 门禁",
    affectedObjects: ["canary", "baseline v2026.05"],
    recommendedActions: [
      { label: "运行 Benchmark", page: "benchmarks", tone: "primary" },
      { label: "复核流水线", page: "pipelines", tone: "secondary" }
    ],
    summaryLabel: "发布门禁",
    summary: "生产发布前运行 baseline 与 canary 场景对比，重点关注 concurrency 16 和 32。",
    evidence: [["Baseline", "v2026.05"], ["Canary", "canary"], ["Gate", "pending"]],
    placeholder: "询问回归风险..."
  },
  config: {
    tone: "warning",
    alertTitle: "检测到 1 个配置风险",
    alertText: "redis-config v4 中 maxmemory-policy 策略可能导致缓存抖动与延迟上升。",
    currentIssue: "redis-config 缓存策略风险",
    affectedObjects: ["redis-cache (2 副本)"],
    recommendedActions: [
      { label: "优化配置并发布新版本", page: "config", tone: "primary", cta: "应用建议", description: "建议将策略从 allkeys-lru 调整为 volatile-lru，降低缓存延迟风险。" },
      { label: "生成变更单", page: "pipelines", tone: "secondary", cta: "查看变更单", description: "已为您生成变更单 CHG-20260531-001。" },
      { label: "回滚方案", page: "config", tone: "secondary", cta: "准备回滚", description: "出现异常可一键回滚到 v3 版本。" }
    ],
    summaryLabel: "配置风险",
    summary: "审批下一次部署前，复核 Diff、受影响服务与回滚预览。",
    evidence: [["配置", "redis-config"], ["版本", "v4"], ["影响", "redis-cache"]],
    placeholder: "询问 Copilot...",
    detectedAt: "5 分钟前",
    relatedAlerts: "2 条",
    severityLabel: "严重"
  },
  pipelines: {
    tone: "warning",
    alertTitle: "SLO 门禁需要验证",
    alertText: "Canary 部署应等待 Benchmark 与可观测性检查。",
    currentIssue: "SLO 门禁未完成，Canary 发布暂停",
    affectedObjects: ["release-canary", "benchmark gate"],
    recommendedActions: [
      { label: "打开流水线", page: "pipelines", tone: "primary" },
      { label: "运行 Benchmark", page: "benchmarks", tone: "secondary" }
    ],
    summaryLabel: "Pipeline 风险",
    summary: "推进生产前必须具备模型版本、配置版本、SLO 检查与 Benchmark 门禁证据。",
    evidence: [["Canary", "running"], ["SLO gate", "pending"], ["回滚", "ready"]],
    placeholder: "询问发布门禁..."
  },
  models: {
    tone: "info",
    alertTitle: "建议复核模型绑定",
    alertText: "需要验证 Serving runtime 与回滚目标。",
    currentIssue: "模型 Runtime 绑定与回滚目标待复核",
    affectedObjects: [PLATFORM_MODEL_ID, "vLLM runtime"],
    recommendedActions: [
      { label: "打开模型", page: "models", tone: "primary" }
    ],
    summaryLabel: "模型治理",
    summary: "检查模型版本谱系、运行时兼容性、SLO profile 和 Benchmark gate 状态。",
    evidence: [["模型", PLATFORM_MODEL_ID], ["Runtime", "vLLM"], ["回滚", "ready"]],
    placeholder: "询问模型发布..."
  },
  demoApps: {
    tone: "success",
    alertTitle: "Demo 工作负载可用",
    alertText: "业务 Demo 可验证路由、RAG 和 streaming。",
    currentIssue: "Demo 工作负载已就绪，可作为验证 Pod",
    affectedObjects: ["customer-support", "knowledge-base"],
    recommendedActions: [
      { label: "运行 Demo", page: "demoApps", tone: "primary" },
      { label: "运行 Benchmark", page: "benchmarks", tone: "secondary" }
    ],
    summaryLabel: "Demo 用法",
    summary: "平台级变更后将 Demo 应用作为验证工作负载，而不是主工作流。",
    evidence: [["RAG", "enabled"], ["SSE", "ready"], ["工作负载", "1"]],
    placeholder: "询问 Demo 验证..."
  },
  settings: {
    tone: "info",
    alertTitle: "平台设置为只读",
    alertText: "环境与集成设置在支持写操作前需要审计。",
    currentIssue: "平台设置为只读，写操作未启用",
    affectedObjects: ["prod env", "us-east-1"],
    recommendedActions: [
      { label: "复核审计策略", page: "config", tone: "primary" }
    ],
    summaryLabel: "设置建议",
    summary: "生产设置保持显式：API 目标、命名空间范围、认证模式和审计策略。",
    evidence: [["Env", "prod"], ["Region", "us-east-1"], ["审计", "enabled"]],
    placeholder: "询问平台设置..."
  }
};

const toneToBadgeTone: Record<CopilotContent["tone"], string> = {
  warning: "warning",
  info: "info",
  success: "success",
  danger: "danger"
};

export function AICopilotPanel({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const content = copilotContent[page];
  const riskTone = content.tone === "info" || content.tone === "success" ? "info" : "warning";
  const severity = content.severityLabel ?? (content.tone === "danger" ? "严重" : content.tone === "warning" ? "中等" : "提示");
  const primaryEvidence = content.evidence.slice(0, 3);
  const showIssueCard = page !== "dashboard";
  const recommendationTitle = page === "dashboard" ? "智能建议" : "推荐动作";

  return (
    <aside className="infra-copilot sample-copilot">
      <div className="infra-copilot-header">
        <strong>AI Copilot</strong>
        <div className="infra-copilot-header-actions">
          <span className="copilot-online-dot" />
          <Search size={16} />
          <button className="sample-copilot-icon-button" type="button" title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className={cn("sample-copilot-alert", riskTone)}>
        <AlertTriangle size={18} />
        <div>
          <strong>{content.alertTitle}</strong>
          <span>{content.alertText}</span>
          <button onClick={() => content.recommendedActions[0]?.page && setPage(content.recommendedActions[0].page)} type="button">
            查看详情
          </button>
        </div>
      </div>

      {showIssueCard && (
        <section className="sample-copilot-card">
          <header>当前问题</header>
          <strong>{content.currentIssue}</strong>
          <div className="sample-copilot-pills">
            {content.affectedObjects.map((obj) => (
              <span className={cn(toneToBadgeTone[content.tone])} key={obj}>{obj}</span>
            ))}
          </div>
          <dl>
            <div><dt>影响对象</dt><dd>{content.affectedObjects.join(" · ")}</dd></div>
            <div><dt>严重性</dt><dd>{severity}</dd></div>
            <div><dt>检测时间</dt><dd>{content.detectedAt ?? "5 分钟前"}</dd></div>
            <div><dt>相关告警</dt><dd>{content.relatedAlerts ?? `${primaryEvidence.length} 条`}</dd></div>
          </dl>
        </section>
      )}

      <section className="sample-copilot-card">
        <header>{recommendationTitle}</header>
        <div className="sample-action-list">
          {content.recommendedActions.map((action) => (
            <div className="sample-action-row" key={action.label}>
              <CheckCircle size={16} />
              <div>
                <strong>{action.label}</strong>
                <span>{action.description ?? content.summary}</span>
              </div>
              <button onClick={() => action.page && setPage(action.page)} type="button">
                {action.cta ?? "应用建议"}
              </button>
            </div>
          ))}
        </div>
        {page === "dashboard" && (
          <button className="sample-copilot-all" onClick={() => setPage("aiOps")} type="button">
            查看所有建议
          </button>
        )}
      </section>

      <section className="sample-copilot-card">
        <header>快捷操作</header>
        <div className="sample-quick-actions">
          <button onClick={() => setPage("aiOps")} type="button"><Sparkles size={14} /> 打开 AI Ops</button>
          <button onClick={() => setPage("observability")} type="button"><RefreshCw size={14} /> 查看 Trace</button>
          <button onClick={() => setPage("kubernetes")} type="button"><Sparkles size={14} /> 打开 Kubernetes</button>
          <button onClick={() => setPage("benchmarks")} type="button"><RefreshCw size={14} /> 运行验证</button>
        </div>
      </section>

      <label className="copilot-input">
        <input placeholder={content.placeholder} />
        <Send size={15} />
      </label>

      <div className="dashboard-copilot-foot">
        <span>最后更新：2026-05-31 10:30:45</span>
        <RefreshCw size={13} />
      </div>
    </aside>
  );
}

// 仪表盘 Copilot 与其它页统一为 loop 形态（当前问题 / 影响对象 / 推荐动作），对齐样例图。
