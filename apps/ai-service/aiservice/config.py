"""Env-driven runtime config (stdlib only, importable without 3rd-party deps)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(key: str, default: str) -> str:
    value = os.environ.get(key)
    return value if value not in (None, "") else default


@dataclass(frozen=True)
class Config:
    llm_base_url: str       # OpenAI 兼容上游（默认 AIBrix gateway）
    llm_model: str
    llm_api_key: str
    request_timeout: int    # 调 LLM 的超时秒数
    stub_mode: str          # auto（试 live 失败回退 stub）| on（强制 stub）| off（强制 live）
    default_max_tokens: int
    default_temperature: float
    host: str
    port: int


def load_config() -> Config:
    return Config(
        llm_base_url=_env("AI_LLM_BASE_URL", "http://127.0.0.1:8010/v1"),
        llm_model=_env("AI_LLM_MODEL", "qwen3-4b-customer"),
        llm_api_key=_env("AI_LLM_API_KEY", "EMPTY"),
        request_timeout=int(_env("AI_LLM_TIMEOUT_SECONDS", "60")),
        stub_mode=_env("AI_STUB_MODE", "auto").lower(),
        default_max_tokens=int(_env("AI_DEFAULT_MAX_TOKENS", "1024")),
        default_temperature=float(_env("AI_DEFAULT_TEMPERATURE", "0.2")),
        host=_env("AI_SERVICE_HOST", "0.0.0.0"),
        port=int(_env("AI_SERVICE_PORT", "8200")),
    )
