"""OpenAI-compatible LLM access (AIBrix gateway / vLLM) + SSE helpers.

Self-contained re-implementation of the few helpers from the legacy monolith so
this service has no `src/` dependency.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator, List

import requests


def normalize_base_url(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    return trimmed if trimmed.endswith("/v1") else trimmed + "/v1"


def sse_event(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _headers(api_key: str) -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key and api_key != "EMPTY":
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def chat_completion(
    base_url: str,
    model: str,
    api_key: str,
    messages: List[Dict[str, Any]],
    *,
    max_tokens: int,
    temperature: float,
    timeout: int,
) -> str:
    """Non-streaming completion; returns the assistant message content."""
    url = normalize_base_url(base_url) + "/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    resp = requests.post(url, headers=_headers(api_key), json=payload, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    return str(data["choices"][0]["message"]["content"])


def chat_with_tools(
    base_url: str,
    model: str,
    api_key: str,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
    *,
    max_tokens: int,
    temperature: float,
    timeout: int,
) -> Dict[str, Any]:
    """E1：带 OpenAI 工具调用的非流式 completion；返回 assistant message（可能含 tool_calls）。"""
    url = normalize_base_url(base_url) + "/chat/completions"
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    resp = requests.post(url, headers=_headers(api_key), json=payload, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    return dict(data["choices"][0]["message"])


def stream_chat_completion(
    base_url: str,
    model: str,
    api_key: str,
    messages: List[Dict[str, Any]],
    *,
    max_tokens: int,
    temperature: float,
    timeout: int,
) -> Iterator[str]:
    """Yield content deltas from the upstream SSE stream (token by token)."""
    url = normalize_base_url(base_url) + "/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    }
    with requests.post(url, headers=_headers(api_key), json=payload, stream=True, timeout=timeout) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            raw = line[6:].strip()
            if raw == "[DONE]":
                break
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            choices = event.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield str(text)
