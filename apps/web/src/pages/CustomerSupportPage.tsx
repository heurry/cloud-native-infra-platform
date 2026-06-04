import { useEffect, useRef, type FormEvent } from "react";
import { Headset, Loader2, MessageSquarePlus, Send, Sparkles } from "lucide-react";

import { PageHeader } from "../components/common/PlatformPrimitives";
import { Skeleton } from "../components/common/FeedbackStates";
import { SupportSessionList } from "../components/support/SupportSessionList";
import { SupportMessageItem } from "../components/support/SupportMessageItem";
import { useSupportChat } from "../lib/useSupportChat";
import { cn } from "../lib/utils";

// 起手问题：语料 = 基准测试日志，引导用户问 serving / 压测相关，不是伪造数据。
const SUGGESTIONS = [
  "最近的压测里 P95 延迟和错误率表现如何？",
  "哪些基准场景失败率偏高，可能的原因是什么？",
  "如何依据基准日志判断是否需要扩容？"
];

export function CustomerSupportPage() {
  const chat = useSupportChat();
  const threadRef = useRef<HTMLDivElement | null>(null);

  // 新 token / 新消息滚到底部（视图关注点，留在页面）。
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.streaming]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void chat.send(chat.input);
  }

  const showIntro = !chat.loadingConvo && chat.messages.length === 0;

  return (
    <section className="infra-page support-page">
      <PageHeader
        title="智能客服"
        subtitle="基于知识库（基准测试日志）的 RAG 流式问答 —— 会话、消息与反馈均落库 PostgreSQL"
        actions={
          <button className="console-refresh primary" type="button" onClick={() => void chat.newSession()}>
            <MessageSquarePlus size={14} /> 新建会话
          </button>
        }
      />

      <div className="support-layout">
        <SupportSessionList
          sessions={chat.sessions}
          selectedId={chat.selectedId}
          isLoading={chat.sessionsQuery.isLoading}
          isError={chat.sessionsQuery.isError}
          error={chat.sessionsQuery.error}
          onRetry={chat.sessionsQuery.refetch}
          onSelect={chat.selectSession}
        />

        <section className="infra-panel support-conversation">
          <div className="support-convo-head">
            <div className="support-convo-title">
              <span className="support-convo-icon"><Headset size={16} /></span>
              <div>
                <strong>{chat.selectedSession?.title || "新会话"}</strong>
                <small>检索 → 提示 → 流式生成 · Go 原生 RAG 管线</small>
              </div>
            </div>
            <span className={cn("support-convo-status", chat.streaming && "live")}>
              {chat.streaming ? (
                <>
                  <Loader2 className="support-spin" size={13} /> 生成中
                </>
              ) : (
                "RAG 就绪"
              )}
            </span>
          </div>

          <div className="support-thread" ref={threadRef}>
            {chat.loadingConvo ? (
              <Skeleton rows={5} />
            ) : showIntro ? (
              <div className="support-intro">
                <Sparkles size={20} />
                <strong>客服助手</strong>
                <p>问题会经检索增强后由模型网关流式作答，引用来自知识库（基准测试日志）。</p>
                <div className="support-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => void chat.send(s)} type="button">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chat.messages.map((message, index) => (
                <SupportMessageItem
                  key={message.message_id ?? `live-${index}`}
                  message={message}
                  onFeedback={chat.sendFeedback}
                />
              ))
            )}
          </div>

          <form className="support-input" onSubmit={onSubmit}>
            <input
              disabled={chat.streaming}
              onChange={(event) => chat.setInput(event.target.value)}
              placeholder={chat.streaming ? "回答生成中…" : "向客服助手提问（基于基准测试知识库）…"}
              value={chat.input}
            />
            <button disabled={chat.streaming || !chat.input.trim()} title="发送" type="submit">
              <Send size={15} />
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}
