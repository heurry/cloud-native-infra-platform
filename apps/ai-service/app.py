"""FastAPI entrypoint for the CloudNative Infra Platform AI service.

Endpoints (all under /internal, reached via the Go control plane, not the browser):
  GET  /internal/health        —— 存活 + 当前模式（stub/live）
  POST /internal/diagnose      —— 结构化诊断（Go 取证 → 本服务推理 → 结构化 JSON）
  POST /internal/chat:stream   —— SSE 流式问答（Go 反向代理透传给前端 Copilot）
  POST /internal/embed         —— 文本嵌入（5B.4c：RAG 切块/查询向量，Qwen3-Embedding-0.6B）
"""

from __future__ import annotations

from typing import Dict, Iterator, List

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from aiservice import __version__
from aiservice.config import load_config
from aiservice.diagnose import run_diagnose
from aiservice.embed import embed_texts
from aiservice.llm import sse_event, stream_chat_completion
from aiservice.schemas import ChatRequest, DiagnoseRequest, DiagnoseResponse, EmbedRequest, EmbedResponse

cfg = load_config()
app = FastAPI(title="CloudNative Infra Platform AI Service", version=__version__)


@app.get("/internal/health")
def health() -> Dict[str, object]:
    return {
        "service": "cloudnative-ai-service",
        "status": "ok",
        "version": __version__,
        "stub_mode": cfg.stub_mode,
        "llm_base_url": cfg.llm_base_url,
        "model": cfg.llm_model,
    }


@app.post("/internal/diagnose", response_model=DiagnoseResponse)
def diagnose(req: DiagnoseRequest) -> DiagnoseResponse:
    return run_diagnose(req, cfg)


@app.post("/internal/chat:stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    return StreamingResponse(_chat_events(req), media_type="text/event-stream")


@app.post("/internal/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    vectors, mode = embed_texts(req.texts, req.is_query, cfg)
    return EmbedResponse(embeddings=vectors, model=cfg.embed_model, dim=cfg.embed_dim, mode=mode)


# ---- chat streaming helpers ----


def _resolve_messages(req: ChatRequest) -> List[Dict[str, object]]:
    if req.messages:
        return req.messages
    return [{"role": "user", "content": req.question or ""}]


def _force_stub() -> bool:
    return cfg.stub_mode == "on" or (cfg.stub_mode != "off" and not cfg.llm_base_url)


def _chat_events(req: ChatRequest) -> Iterator[str]:
    messages = _resolve_messages(req)
    if not _force_stub():
        yield sse_event("start", {"mode": "live"})
        try:
            for text in stream_chat_completion(
                cfg.llm_base_url, cfg.llm_model, cfg.llm_api_key, messages,
                max_tokens=req.max_tokens, temperature=req.temperature,
                timeout=cfg.request_timeout,
            ):
                yield sse_event("token", {"text": text})
            yield sse_event("done", {})
            return
        except Exception as exc:  # noqa: BLE001 - 流式要优雅降级
            if cfg.stub_mode == "off":
                yield sse_event("error", {"error": f"{type(exc).__name__}: {exc}"})
                yield sse_event("done", {})
                return
            yield sse_event("notice", {"message": f"llm fallback: {type(exc).__name__}"})
    else:
        yield sse_event("start", {"mode": "stub"})

    for chunk in _chunk_text(_stub_reply(req)):
        yield sse_event("token", {"text": chunk})
    yield sse_event("done", {})


def _stub_reply(req: ChatRequest) -> str:
    question = (req.question or "").strip()
    if not question and req.messages:
        last = req.messages[-1]
        question = str(last.get("content") or "").strip()
    question = question or "(无问题)"
    return (
        "【stub 模式】当前未连接 LLM 网关，以下为占位回答。\n"
        f"你的问题是：{question}\n"
        "请在具备 vLLM / AIBrix 网关的环境运行以获得真实推理。"
    )


def _chunk_text(text: str, size: int = 12) -> Iterator[str]:
    for i in range(0, len(text), size):
        yield text[i : i + size]
