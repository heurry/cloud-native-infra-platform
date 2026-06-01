from __future__ import annotations

from typing import Dict, List


HANDOFF_KEYWORDS = ["投诉", "赔偿", "赔付", "起诉", "账号冻结", "修改地址", "银行卡", "身份证", "订单号"]
GREETING_KEYWORDS = {
    "你好",
    "您好",
    "hello",
    "hi",
    "嗨",
    "在吗",
    "客服在吗",
}


def decide_fallback(
    question: str,
    documents: List[Dict[str, str]],
    conversation_history: List[Dict[str, str]] | None = None,
) -> str:
    normalized = question.strip().lower().replace(" ", "")
    if normalized in GREETING_KEYWORDS:
        return "greeting"
    lowered = question.lower()
    if not documents:
        return "no_retrieval_hit"
    if any(keyword.lower() in lowered for keyword in HANDOFF_KEYWORDS):
        return "handoff_sensitive_or_account_action"
    return ""


def build_fallback_answer(
    question: str,
    documents: List[Dict[str, str]],
    reason: str,
) -> str:
    if reason == "greeting":
        return "您好，请问有什么可以帮您？"
    if reason == "handoff_sensitive_or_account_action":
        return "这个问题涉及账号、订单、赔付或敏感操作，需要人工客服核验身份和业务状态后处理。"
    if documents:
        first = documents[0]
        return f"我找到了相关资料《{first.get('title', '未命名文档')}》，但当前模型服务不可用。请稍后重试，或转人工处理。"
    return "当前知识库没有找到足够证据，建议转人工客服进一步确认。"
