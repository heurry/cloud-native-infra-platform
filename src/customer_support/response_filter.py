from __future__ import annotations

import re
from typing import List


THINKING_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"<think\b|"
    r"(?:thinking|reasoning|analysis)\s+process\s*:|"
    r"(?:思考|推理|分析)(?:过程)?\s*[:：]"
    r")",
    re.IGNORECASE,
)
THINKING_PREFIXES = (
    "<think",
    "thinking process:",
    "reasoning process:",
    "analysis process:",
    "思考:",
    "思考：",
    "思考过程:",
    "思考过程：",
    "推理:",
    "推理：",
    "推理过程:",
    "推理过程：",
    "分析:",
    "分析：",
    "分析过程:",
    "分析过程：",
)
ANSWER_MARKER_RE = re.compile(
    r"(?:"
    r"final\s+(?:answer|response)\s*[:：]|"
    r"answer\s*[:：]|"
    r"(?:最终|正式)?(?:答案|答复|回复)\s*[:：]|"
    r"客服(?:答案|答复|回复)\s*[:：]"
    r")",
    re.IGNORECASE,
)
THINK_TAG_BLOCK_RE = re.compile(r"<think\b[^>]*>.*?</think>\s*", re.IGNORECASE | re.DOTALL)
UNCLOSED_THINK_TAG_RE = re.compile(r"^\s*<think\b[^>]*>.*", re.IGNORECASE | re.DOTALL)
LEADING_THINKING_BLOCK_RE = re.compile(
    r"^\s*(?:thinking|reasoning|analysis)\s+process\s*:\s*.*?"
    r"(?=(?:final\s+(?:answer|response)|answer)\s*[:：])",
    re.IGNORECASE | re.DOTALL,
)
LEADING_CN_THINKING_BLOCK_RE = re.compile(
    r"^\s*(?:思考|推理|分析)(?:过程)?\s*[:：]\s*.*?"
    r"(?=(?:最终|正式)?(?:答案|答复|回复)\s*[:：])",
    re.IGNORECASE | re.DOTALL,
)
CUSTOMER_CITATION_RE = re.compile(
    r"\s*(?:"
    r"\[\s*\d+\s*\]|"
    r"【\s*\d+\s*】|"
    r"[（(]\s*\d+\s*[）)]|"
    r"\[\s*[A-Za-z][A-Za-z0-9_-]*-v\d+\s*\]"
    r")"
)
LEADING_SOURCE_PHRASE_RE = re.compile(
    r"^\s*(?:根据|依据|参考|按照)?\s*(?:上述|以上|提供的)?\s*"
    r"(?:知识库(?:片段)?|文档|资料|材料|信息|客服规则|政策)"
    r"(?:\s*(?:\[\s*\d+\s*\]|【\s*\d+\s*】|[（(]\s*\d+\s*[）)]))*"
    r"\s*[，,。:：、]?\s*"
)
PREFIX_BUFFER_CHARS = 24


def strip_customer_citations(text: str, *, trim: bool = True, remove_source_phrase: bool = True) -> str:
    """Remove internal citation markers from text shown inside the customer chat bubble."""
    cleaned = LEADING_SOURCE_PHRASE_RE.sub("", text) if remove_source_phrase else text
    cleaned = CUSTOMER_CITATION_RE.sub("", cleaned)
    if remove_source_phrase:
        cleaned = LEADING_SOURCE_PHRASE_RE.sub("", cleaned)
    cleaned = re.sub(r"\s+([，。！？；：,.!?;:])", r"\1", cleaned)
    cleaned = re.sub(r"([（(])\s+", r"\1", cleaned)
    cleaned = re.sub(r"\s+([）)])", r"\1", cleaned)
    return cleaned.strip() if trim else cleaned


def strip_thinking_text(text: str) -> str:
    """Remove common reasoning preambles from chat-model output."""
    cleaned = THINK_TAG_BLOCK_RE.sub("", text)
    cleaned = LEADING_THINKING_BLOCK_RE.sub("", cleaned)
    cleaned = LEADING_CN_THINKING_BLOCK_RE.sub("", cleaned)
    if UNCLOSED_THINK_TAG_RE.match(cleaned):
        return ""

    if THINKING_PREFIX_RE.match(cleaned):
        marker = ANSWER_MARKER_RE.search(cleaned)
        if marker:
            cleaned = cleaned[marker.end() :]
        else:
            return ""

    marker_at_start = ANSWER_MARKER_RE.match(cleaned.strip())
    if marker_at_start:
        stripped = cleaned.strip()
        cleaned = stripped[marker_at_start.end() :]
    return strip_customer_citations(cleaned)


class StreamingAnswerFilter:
    """Suppress reasoning text while preserving streaming for normal answers."""

    def __init__(self) -> None:
        self._mode = "undecided"
        self._buffer = ""

    def feed(self, text: str) -> List[str]:
        if not text:
            return []

        if self._mode == "passthrough":
            output = strip_customer_citations(text, trim=False, remove_source_phrase=False)
            return [output] if output else []

        self._buffer += text
        visible = self._buffer.lstrip()

        if self._mode == "undecided":
            if THINKING_PREFIX_RE.match(visible):
                self._mode = "buffering"
                return []
            # Keep only genuinely ambiguous prefixes buffered so split chunks like
            # "Thinking" + " Process:" can still be recognized before emission.
            if _could_be_thinking_prefix(visible):
                return []
            self._mode = "prefix_buffering"
            return self._flush_prefix_if_ready()

        if self._mode == "prefix_buffering":
            return self._flush_prefix_if_ready()

        marker = ANSWER_MARKER_RE.search(self._buffer)
        if marker:
            output = strip_thinking_text(self._buffer)
            self._buffer = ""
            self._mode = "passthrough"
            return [output] if output else []
        return []

    def finish(self) -> List[str]:
        if not self._buffer:
            return []
        output = strip_thinking_text(self._buffer)
        self._buffer = ""
        self._mode = "passthrough"
        return [output] if output else []

    def _flush_prefix_if_ready(self) -> List[str]:
        if len(self._buffer) < PREFIX_BUFFER_CHARS and not re.search(r"[，。！？；：,;:!?\n]", self._buffer):
            return []
        output = strip_customer_citations(self._buffer, trim=False)
        self._buffer = ""
        self._mode = "passthrough"
        return [output] if output else []


def _could_be_thinking_prefix(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text.strip().lower())
    if not normalized:
        return True
    return any(prefix.startswith(normalized) for prefix in THINKING_PREFIXES)
