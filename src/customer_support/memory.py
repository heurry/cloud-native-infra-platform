from __future__ import annotations

import re
from typing import Dict, List

from src.rag.retriever import tokenize


FOLLOWUP_HINTS = (
    "这个",
    "那个",
    "上述",
    "上面",
    "刚才",
    "继续",
    "还有",
    "也要",
    "换成",
    "改成",
    "呢",
)
STANDALONE_QUESTION_HINTS = (
    "什么",
    "怎么",
    "如何",
    "为什么",
    "是否",
    "能不能",
    "可以",
    "规则",
    "流程",
)
MAX_MEMORY_MESSAGES = 8
MAX_MEMORY_CHARS = 1600


def compact_conversation_memory(
    messages: List[Dict[str, str]],
    *,
    max_messages: int = MAX_MEMORY_MESSAGES,
    max_chars: int = MAX_MEMORY_CHARS,
) -> List[Dict[str, str]]:
    """Return recent chat turns small enough to inject into retrieval and prompts."""
    compacted: List[Dict[str, str]] = []
    used = 0
    for message in messages[-max_messages:]:
        role = str(message.get("role", "")).strip()
        content = re.sub(r"\s+", " ", str(message.get("content", "")).strip())
        if role not in {"user", "assistant"} or not content:
            continue
        if used + len(content) > max_chars:
            break
        compacted.append({"role": role, "content": content})
        used += len(content)
    return compacted


def is_contextual_followup(question: str, history: List[Dict[str, str]]) -> bool:
    """Heuristic for short turns that likely depend on previous dialogue context."""
    current = question.strip()
    if not current or not history:
        return False
    normalized = current.lower().replace(" ", "")
    if any(hint in normalized for hint in FOLLOWUP_HINTS):
        return True
    if any(hint in normalized for hint in STANDALONE_QUESTION_HINTS) or "？" in current or "?" in current:
        return False
    if len(current) <= 16:
        return True
    return len(tokenize(current)) <= 4 and len(current) <= 24


def build_memory_aware_query(question: str, history: List[Dict[str, str]]) -> str:
    """Build a retrieval query that carries recent context for short follow-up turns."""
    current = question.strip()
    if not is_contextual_followup(current, history):
        return current

    recent_user_turns = [item["content"] for item in history if item.get("role") == "user"][-2:]
    parts = []
    if recent_user_turns:
        parts.append("上一轮用户需求：" + "；".join(recent_user_turns))
    parts.append("当前用户补充：" + current)
    return "\n".join(parts)
