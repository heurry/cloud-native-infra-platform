import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw, Search, Send, Sparkles, X } from "lucide-react";

import { streamAIChat, type ChatMessage } from "../../lib/api";
import { MarkdownText } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import { pageLabels, type Page } from "../../types/navigation";

type ChatTurn = { role: "user" | "assistant"; content: string };

// 每页给几条"起手问题"——这是提问引导，不是伪造的遥测数据。点击即作为问题发送。
const SUGGESTED: Partial<Record<Page, string[]>> = {
  dashboard: ["平台当前最该优先关注的风险是什么？", "健康分和活跃告警怎么解读？", "P95 延迟升高一般怎么排查？"],
  services: ["怎么判断路由是否倾斜到单个副本？", "least-request 和 round-robin 怎么选？", "某个 vLLM 副本不健康该怎么处理？"],
  kubernetes: ["Pod 一直 Pending 通常是什么原因？", "如何排查 GPU 显存不足？", "HPA 没有按预期扩容怎么定位？"],
  observability: ["TTFT 和 P95 有什么区别？", "错误率升高从哪几步定位？", "怎么把指标和慢请求关联分析？"],
  knowledge: ["RAG 检索召回率低怎么优化？", "向量索引什么时候需要重建？", "如何评估知识库覆盖度？"],
  benchmarks: ["并发压测应该重点看哪些指标？", "SLO 门禁阈值怎么设？", "baseline 和 canary 怎么对比？"],
  config: ["发布配置前应该检查什么？", "回滚配置的最佳实践是什么？", "怎么降低缓存抖动风险？"],
  pipelines: ["Canary 发布门禁应该包含哪些检查？", "灰度回滚的判断标准是什么？", "如何设计渐进式发布？"],
  models: ["模型版本回滚要注意什么？", "如何验证 runtime 兼容性？", "上线新模型前的检查清单？"]
};

const FALLBACK_SUGGESTIONS = ["这个平台能帮我做什么？", "当前页面该重点关注什么？"];

// 页面级导航快捷入口（真实路由跳转，非伪造数据）。
const QUICK_ACTIONS: Array<{ label: string; page: Page; icon: typeof Sparkles }> = [
  { label: "AI Ops", page: "aiOps", icon: Sparkles },
  { label: "可观测性", page: "observability", icon: RefreshCw },
  { label: "Kubernetes", page: "kubernetes", icon: Sparkles },
  { label: "压测验证", page: "benchmarks", icon: RefreshCw }
];

function systemPrompt(page: Page): string {
  return (
    "你是云原生基础设施管理平台的 AI Copilot，服务对象是研发 / 运维 / SRE / 平台运营。" +
    `当前用户位于「${pageLabels[page]}」页面。请用简体中文、结合云原生与模型 Serving（vLLM / AIBrix / Kubernetes / RAG）场景，简洁、分点地回答平台运维相关问题。`
  );
}

export function AICopilotPanel({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // 新 token / 新消息时滚到底部。
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, streaming, notice]);

  // 卸载（切到 AI Ops / 设置页）时中断进行中的流。
  useEffect(() => () => abortRef.current?.abort(), []);

  const suggestions = SUGGESTED[page] ?? FALLBACK_SUGGESTIONS;
  const empty = turns.length === 0;

  function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || streaming) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setNotice(null);
    setErrored(false);
    setInput("");

    // 先把用户消息和一个空的助手占位写进会话。
    const history: ChatTurn[] = [...turns, { role: "user", content: trimmed }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setStreaming(true);

    const payload: ChatMessage[] = [
      { role: "system", content: systemPrompt(page) },
      ...history.map((t) => ({ role: t.role, content: t.content }))
    ];

    const appendToAssistant = (text: string) =>
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
        return next;
      });

    streamAIChat(
      payload,
      {
        onStart: (m) => setMode(m || null),
        onToken: (text) => appendToAssistant(text),
        onNotice: (message) => {
          // auto 模式下 live 尝试失败会先发 start{live} 再 notice 回退——如实把状态标回 stub。
          if (message) setNotice(message);
          setMode("stub");
        },
        onError: (message) => {
          setErrored(true);
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              // 已有部分 token 则追加错误说明，否则整条用错误占位。
              const suffix = last.content ? `\n\n⚠️ ${message}` : `⚠️ ${message}`;
              next[next.length - 1] = { ...last, content: last.content + suffix };
            }
            return next;
          });
        },
        onDone: () => {
          setStreaming(false);
          // 流结束后若助手消息仍为空，给出明确提示而不是空气泡。
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && !last.content) {
              next[next.length - 1] = { ...last, content: "（未收到回复，请确认 AI 服务 / 模型网关是否可用）" };
            }
            return next;
          });
        }
      },
      { signal: controller.signal, maxTokens: 768, temperature: 0.2 }
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send(input);
  }

  function reset() {
    abortRef.current?.abort();
    setTurns([]);
    setStreaming(false);
    setNotice(null);
    setErrored(false);
    setMode(null);
  }

  const dotState = errored ? "degraded" : undefined;

  return (
    <aside className="infra-copilot copilot-chat">
      <div className="infra-copilot-header">
        <strong>AI Copilot</strong>
        <div className="infra-copilot-header-actions">
          <span className={cn("copilot-online-dot", dotState)} />
          {mode === "stub" && <span className="copilot-mode-badge">stub</span>}
          <Search size={16} />
          <button className="copilot-icon-button" onClick={reset} title="清空对话" type="button">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="copilot-chat-thread" ref={threadRef}>
        {empty ? (
          <div className="copilot-chat-intro">
            <Sparkles size={18} />
            <strong>{pageLabels[page]} · 智能助手</strong>
            <p>基于平台 Serving / Kubernetes / RAG 场景为你答疑。问题会经 Go 单一入口流式调用 AI 服务。</p>
            <div className="copilot-suggestions">
              {suggestions.map((s) => (
                <button key={s} onClick={() => send(s)} type="button">{s}</button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div className={cn("copilot-msg", turn.role)} key={i}>
              {turn.role === "assistant" ? (
                <MarkdownText text={turn.content || "…"} />
              ) : (
                <span>{turn.content}</span>
              )}
            </div>
          ))
        )}
        {notice && <div className="copilot-chat-notice">{notice}</div>}
      </div>

      <div className="copilot-quick-actions">
        {QUICK_ACTIONS.map(({ label, page: target, icon: Icon }) => (
          <button key={label} onClick={() => setPage(target)} type="button">
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <form className="copilot-input" onSubmit={onSubmit}>
        <input
          disabled={streaming}
          onChange={(event) => setInput(event.target.value)}
          placeholder={streaming ? "回答生成中…" : `在「${pageLabels[page]}」向 Copilot 提问…`}
          value={input}
        />
        <button disabled={streaming || !input.trim()} title="发送" type="submit">
          <Send size={15} />
        </button>
      </form>

      <div className="dashboard-copilot-foot">
        <span>{streaming ? "生成中…" : mode === "live" ? "已连接模型网关" : mode === "stub" ? "stub 模式（未连接 LLM）" : "经 Go 单一入口 · /api/ai/chat"}</span>
        {streaming ? <RefreshCw className="copilot-spin" size={13} /> : <RefreshCw size={13} />}
      </div>
    </aside>
  );
}
