from __future__ import annotations

from typing import Dict, Iterable, List


CUSTOMER_SUPPORT_SYSTEM_PROMPT = """你是企业客服问答助手。必须基于提供的知识库片段回答。
如果知识库证据不足、问题涉及账号/订单隐私操作、赔付争议或法律风险，请说明需要转人工。
回答要自然、简洁、可执行，面向真实客户，不要像内部评测报告。
不要在客户回答中输出文档编号、doc_id、[1]、【1】、"根据文档"、"根据知识库" 等引用标记；引用信息由系统在侧边栏单独展示。
不要输出思考过程、推理步骤、分析计划或英文标题。
如果用户只是寒暄问候，请直接友好回应并询问需要什么帮助，不要说知识库证据不足。
如果用户是对上一轮的简短补充，请结合最近对话理解，不要把补充内容孤立解释成其他业务问题。
如果知识库片段与最近对话意图不匹配，不要强行套用相似词命中的知识库内容。
如果用户使用中文提问，必须全程使用简体中文回答；不要夹杂英文，除非英文是商品名或接口名。"""

def build_context_block(documents: Iterable[Dict[str, str]], max_chars: int = 6000) -> str:
    chunks: List[str] = []
    used = 0
    for idx, doc in enumerate(documents, start=1):
        text = (
            f"[{idx}] doc_id={doc.get('doc_id', '')} category={doc.get('category', '')} "
            f"version={doc.get('version', '')}\n"
            f"title: {doc.get('title', '')}\n"
            f"content: {doc.get('content', '')}"
        )
        if used + len(text) > max_chars:
            break
        chunks.append(text)
        used += len(text)
    return "\n\n".join(chunks)


def build_history_block(history: Iterable[Dict[str, str]], max_chars: int = 1600) -> str:
    chunks: List[str] = []
    used = 0
    for item in history:
        role = "用户" if item.get("role") == "user" else "客服助手"
        content = str(item.get("content", "")).strip()
        if not content:
            continue
        text = f"{role}: {content}"
        if used + len(text) > max_chars:
            break
        chunks.append(text)
        used += len(text)
    return "\n".join(chunks)


def build_chat_messages(
    *,
    user_question: str,
    retrieved_documents: List[Dict[str, str]],
    max_context_chars: int,
    conversation_history: List[Dict[str, str]] | None = None,
) -> List[Dict[str, str]]:
    context = build_context_block(retrieved_documents, max_context_chars)
    history = build_history_block(conversation_history or [])
    user_content = (
        f"最近对话：\n{history or '无'}\n\n"
        f"知识库片段：\n{context or '未检索到相关知识。'}\n\n"
        f"当前用户问题：{user_question}"
    )
    return [
        {"role": "system", "content": CUSTOMER_SUPPORT_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
