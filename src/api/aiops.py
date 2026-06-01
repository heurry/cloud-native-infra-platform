"""AI Ops chat endpoints — operates on benchmark reports + system snapshots.

Distinct from the customer-support chat because:
  * No RAG (the LLM analyzes the supplied benchmark JSON + snapshot directly)
  * Separate session kind so AI Ops history stays isolated
  * System prompt is operations-analyst, not customer support
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional
from uuid import uuid4

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.api.sse import sse_event
from src.serve.openai_client import normalize_base_url


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_DIRS = [
    PROJECT_ROOT / "runs" / "serve",
    PROJECT_ROOT / "runs" / "benchmark",
]
SNAPSHOT_DIR = PROJECT_ROOT / "runs" / "benchmark" / "snapshots"

# Used by build_aiops_messages — caps each section so the prompt stays within
# the model's context budget. qwen3-4b-customer has max_model_len=4096 tokens.
# For Chinese + JSON content, ~2 chars ≈ 1 token. Budget:
#   system prompt   ~250 chars  → ~150 tokens
#   report excerpt  ~1500 chars → ~750 tokens
#   snapshot summ.  ~1200 chars → ~600 tokens
#   user + history  ~500 tokens
#   ----
#   input total            ~2000 tokens
#   leaves ~2000 tokens for generation, matching default max_tokens.
MAX_REPORT_CHARS = 1500
MAX_SNAPSHOT_CHARS = 1200
MAX_LOG_TAIL_CHARS = 700
MAX_HISTORY_TURNS = 3


class AIOpsSessionCreate(BaseModel):
    title: Optional[str] = None
    benchmark_id: Optional[str] = None


class AIOpsMessageRequest(BaseModel):
    content: str
    benchmark_id: Optional[str] = None
    # qwen3-4b context is 4096 tokens. Budget:
    #   system prompt + report + snapshot summary ≈ 1500 tokens (capped below)
    #   history (3 turns) + user message              ≈ 500-1000 tokens
    #   ⇒ 1500-2500 tokens left for generation
    # 2500 gives a long analysis without overrunning context in practice.
    max_tokens: int = Field(default=2500, ge=16, le=4096)
    temperature: float = Field(default=0.2, ge=0.0, le=1.5)


def create_router(*, db, cfg, get_endpoint) -> APIRouter:
    """Build router with closures over shared dependencies.

    Args:
        db: shared Database instance from src.api.main
        cfg: AppConfig
        get_endpoint: callable that resolves a chat endpoint (reuses
            the existing endpoint-resolution logic from main.py)
    """

    router = APIRouter(prefix="/api/aiops", tags=["aiops"])

    # --------------- benchmarks ----------------------------------------

    @router.get("/benchmarks")
    def list_benchmarks() -> Dict[str, Any]:
        items = _scan_benchmarks()
        return {"benchmarks": items}

    @router.get("/benchmarks/{benchmark_id}")
    def get_benchmark(benchmark_id: str) -> Dict[str, Any]:
        report = _load_benchmark_report(benchmark_id)
        if report is None:
            raise HTTPException(status_code=404, detail=f"Benchmark {benchmark_id} not found")
        snapshot = _load_snapshot(benchmark_id)
        return {
            "benchmark_id": benchmark_id,
            "report": report,
            "snapshot": snapshot,
            "has_snapshot": snapshot is not None,
        }

    @router.post("/benchmarks/{benchmark_id}/snapshot")
    def trigger_snapshot(benchmark_id: str) -> Dict[str, Any]:
        """Manually capture a system snapshot for an existing benchmark."""
        from src.serve.system_snapshot import SnapshotConfig, capture_snapshot

        report = _load_benchmark_report(benchmark_id)
        if report is None:
            raise HTTPException(status_code=404, detail=f"Benchmark {benchmark_id} not found")
        cfg_snap = SnapshotConfig(
            benchmark_id=benchmark_id,
            output_dir=SNAPSHOT_DIR,
            benchmark_report_path=Path(report.get("__source_path", "")) if report.get("__source_path") else None,
        )
        snapshot = capture_snapshot(cfg_snap)
        return {"benchmark_id": benchmark_id, "snapshot": snapshot}

    # --------------- sessions ------------------------------------------

    @router.post("/sessions")
    def create_session(payload: AIOpsSessionCreate) -> Dict[str, Any]:
        session_id = uuid4().hex
        title = payload.title or _default_session_title(payload.benchmark_id)
        now = utc_now_iso()
        db.execute(
            """
            INSERT INTO conversations(session_id, title, user_role, kind, benchmark_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session_id, title, "operator", "aiops", payload.benchmark_id, now, now),
        )
        return {
            "session_id": session_id,
            "title": title,
            "benchmark_id": payload.benchmark_id,
            "created_at": now,
        }

    @router.get("/sessions")
    def list_sessions(limit: int = 50) -> Dict[str, Any]:
        rows = db.fetch_all(
            "SELECT session_id, title, benchmark_id, created_at, updated_at FROM conversations WHERE kind=? ORDER BY updated_at DESC LIMIT ?",
            ("aiops", limit),
        )
        return {"sessions": rows}

    @router.get("/sessions/{session_id}")
    def get_session(session_id: str) -> Dict[str, Any]:
        session = db.fetch_one(
            "SELECT session_id, title, benchmark_id, created_at, updated_at FROM conversations WHERE session_id=? AND kind=?",
            (session_id, "aiops"),
        )
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        messages = db.fetch_all(
            "SELECT message_id, role, content, metadata_json, created_at FROM messages WHERE session_id=? ORDER BY created_at ASC",
            (session_id,),
        )
        return {"session": session, "messages": messages}

    # --------------- streaming chat ------------------------------------

    @router.post("/sessions/{session_id}/messages:stream")
    def stream_chat(session_id: str, payload: AIOpsMessageRequest) -> StreamingResponse:
        session = db.fetch_one(
            "SELECT session_id, benchmark_id FROM conversations WHERE session_id=? AND kind=?",
            (session_id, "aiops"),
        )
        if not session:
            raise HTTPException(status_code=404, detail="AI Ops session not found")

        # Resolve benchmark_id: request override → session attachment → none.
        benchmark_id = payload.benchmark_id or session.get("benchmark_id")
        if benchmark_id and benchmark_id != session.get("benchmark_id"):
            db.execute(
                "UPDATE conversations SET benchmark_id=?, updated_at=? WHERE session_id=?",
                (benchmark_id, utc_now_iso(), session_id),
            )

        async def generate() -> AsyncGenerator[str, None]:
            request_id = uuid4().hex
            total_start = time.perf_counter()

            # Insert user message synchronously so it's persisted before we stream.
            _insert_message(db, session_id, "user", payload.content)
            yield sse_event("user_message", {"request_id": request_id, "content": payload.content, "benchmark_id": benchmark_id})

            # Build the context.
            report = _load_benchmark_report(benchmark_id) if benchmark_id else None
            snapshot = _load_snapshot(benchmark_id) if benchmark_id else None
            yield sse_event(
                "context",
                {
                    "request_id": request_id,
                    "benchmark_id": benchmark_id,
                    "has_report": report is not None,
                    "has_snapshot": snapshot is not None,
                },
            )

            history = _fetch_history(db, session_id, limit=MAX_HISTORY_TURNS)
            messages = build_aiops_messages(
                user_question=payload.content,
                report=report,
                snapshot=snapshot,
                history=history,
            )

            # Resolve endpoint (default chat endpoint).
            try:
                endpoint = get_endpoint(None, None)
            except Exception as exc:  # noqa: BLE001
                yield sse_event("error", {"request_id": request_id, "error": f"endpoint resolve failed: {exc}"})
                yield sse_event("done", {"request_id": request_id})
                return

            answer_parts: List[str] = []
            ttft_ms: Optional[float] = None
            error: Optional[str] = None

            url = normalize_base_url(endpoint["base_url"]) + "/chat/completions"
            headers = {
                "Content-Type": "application/json",
                "x-request-id": request_id,
                "x-aiops-session": session_id,
            }
            api_key = endpoint.get("api_key")
            if api_key and api_key != "EMPTY":
                headers["Authorization"] = f"Bearer {api_key}"

            payload_json = {
                "model": endpoint["model_id"],
                "messages": messages,
                "max_tokens": payload.max_tokens,
                "temperature": payload.temperature,
                "stream": True,
                "stream_options": {"include_usage": True},
                "chat_template_kwargs": {"enable_thinking": False},
            }

            stream_start = time.perf_counter()
            try:
                with requests.post(url, headers=headers, json=payload_json, stream=True, timeout=cfg.request_timeout_seconds) as response:
                    response.raise_for_status()
                    for line in response.iter_lines(decode_unicode=True):
                        if not line or not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            event = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        text = _extract_stream_content(event)
                        if not text:
                            continue
                        if ttft_ms is None:
                            ttft_ms = (time.perf_counter() - stream_start) * 1000
                            yield sse_event("ttft", {"request_id": request_id, "ttft_ms": ttft_ms})
                        answer_parts.append(text)
                        yield sse_event("token", {"request_id": request_id, "text": text})
            except Exception as exc:  # noqa: BLE001
                error = f"{type(exc).__name__}: {exc}"
                yield sse_event("error", {"request_id": request_id, "error": error})

            answer_text = "".join(answer_parts).strip()
            total_ms = (time.perf_counter() - total_start) * 1000
            metadata = {
                "request_id": request_id,
                "benchmark_id": benchmark_id,
                "has_report": report is not None,
                "has_snapshot": snapshot is not None,
                "ttft_ms": ttft_ms,
                "total_ms": total_ms,
                "endpoint_id": endpoint.get("name"),
                "model_id": endpoint.get("model_id"),
                "error": error,
            }
            _insert_message(db, session_id, "assistant", answer_text, metadata)
            db.execute(
                "UPDATE conversations SET updated_at=? WHERE session_id=?",
                (utc_now_iso(), session_id),
            )
            yield sse_event("metrics", metadata)
            yield sse_event("done", {"request_id": request_id})

        return StreamingResponse(generate(), media_type="text/event-stream")

    return router


# ---------- helpers ----------------------------------------------------------


def utc_now_iso() -> str:
    from datetime import timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _default_session_title(benchmark_id: Optional[str]) -> str:
    if benchmark_id:
        return f"AI Ops · {benchmark_id}"
    return f"AI Ops 会话 {datetime.now().strftime('%m-%d %H:%M')}"


def _scan_benchmarks() -> List[Dict[str, Any]]:
    """Return metadata for all benchmark report JSONs available on disk."""
    items: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    snapshots_present = {p.stem for p in SNAPSHOT_DIR.glob("*.json")} if SNAPSHOT_DIR.exists() else set()

    for base in BENCHMARK_DIRS:
        if not base.exists():
            continue
        for path in sorted(base.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            benchmark_id = path.stem
            if benchmark_id in seen_ids:
                continue
            seen_ids.add(benchmark_id)
            meta = _benchmark_metadata(path)
            meta["benchmark_id"] = benchmark_id
            meta["source_path"] = str(path.relative_to(PROJECT_ROOT))
            meta["has_snapshot"] = benchmark_id in snapshots_present
            try:
                meta["modified_at"] = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
            except OSError:
                meta["modified_at"] = None
            items.append(meta)
    return items


def _benchmark_metadata(path: Path) -> Dict[str, Any]:
    """Best-effort: read a few interesting fields without loading whole file."""
    try:
        with path.open("r", encoding="utf-8") as f:
            text = f.read(64_000)  # only first 64k for metadata
    except OSError:
        return {"endpoint_label": None, "model": None, "concurrency_levels": []}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # File too big — try a slow full load
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"endpoint_label": None, "model": None, "concurrency_levels": []}
    return {
        "endpoint_label": data.get("endpoint_label"),
        "model": data.get("model"),
        "routing_strategy": data.get("routing_strategy"),
        "prompt_profile": data.get("prompt_profile"),
        "concurrency_levels": data.get("concurrency_levels"),
        "requests_per_level": data.get("requests_per_level"),
        "scenario_count": len(data.get("scenarios", [])) if isinstance(data.get("scenarios"), list) else None,
    }


def _load_benchmark_report(benchmark_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not benchmark_id:
        return None
    for base in BENCHMARK_DIRS:
        candidate = base / f"{benchmark_id}.json"
        if candidate.exists():
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    data["__source_path"] = str(candidate.relative_to(PROJECT_ROOT))
                return data
            except Exception:
                return None
    return None


def _load_snapshot(benchmark_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not benchmark_id:
        return None
    candidate = SNAPSHOT_DIR / f"{benchmark_id}.json"
    if not candidate.exists():
        return None
    try:
        return json.loads(candidate.read_text(encoding="utf-8"))
    except Exception:
        return None


def _fetch_history(db, session_id: str, limit: int = MAX_HISTORY_TURNS) -> List[Dict[str, str]]:
    rows = db.fetch_all(
        "SELECT role, content FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
        (session_id, limit * 2),
    )
    return list(reversed([{"role": r["role"], "content": r["content"]} for r in rows]))


def _insert_message(db, session_id: str, role: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> str:
    from src.api.db import json_dumps
    message_id = uuid4().hex
    db.execute(
        """
        INSERT INTO messages(message_id, session_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (message_id, session_id, role, content, json_dumps(metadata or {}), utc_now_iso()),
    )
    return message_id


def _extract_stream_content(event: Dict[str, Any]) -> str:
    choices = event.get("choices")
    if not choices:
        return ""
    delta = choices[0].get("delta") or {}
    if "content" in delta and delta["content"]:
        return str(delta["content"])
    if "text" in choices[0] and choices[0]["text"]:
        return str(choices[0]["text"])
    return ""


# ---------- prompt construction ---------------------------------------------


SYSTEM_PROMPT_ZH = """你是一名云原生 AI 推理基础设施的运维分析师。\
基于用户提供的 benchmark 报告和系统状态快照,定位性能瓶颈、识别风险、给出可执行的修复建议。

工作准则:
1. 引用具体数据(P95/TTFT/decode tokens/s/GPU 利用率/KV cache 占用/队列长度等)说明结论
2. 把症状、根因、修复动作分开列出,推荐动作要标明风险等级和预计影响
3. 当数据不足以判断时明确说出"需要补充什么数据",而不是编造
4. 使用简体中文回答,术语首次出现可用英文标注
"""


def build_aiops_messages(
    user_question: str,
    report: Optional[Dict[str, Any]],
    snapshot: Optional[Dict[str, Any]],
    history: List[Dict[str, str]],
) -> List[Dict[str, str]]:
    """Assemble the chat message array for vLLM.

    qwen3 only accepts a SINGLE system message at position 0; multiple system
    messages cause `System message must be at the beginning.` 400 errors.
    So we concatenate the analyst persona + benchmark + snapshot into one block.
    """
    system_blocks: List[str] = [SYSTEM_PROMPT_ZH.strip()]

    if report:
        report_summary = _summarize_report(report)
        system_blocks.append(f"== Benchmark 报告 ==\n{report_summary}")

    if snapshot:
        from src.serve.system_snapshot import summarize_snapshot
        snap_text = summarize_snapshot(snapshot, max_chars_per_section=MAX_LOG_TAIL_CHARS)
        if len(snap_text) > MAX_SNAPSHOT_CHARS:
            snap_text = snap_text[:MAX_SNAPSHOT_CHARS] + "\n...[snapshot truncated]"
        system_blocks.append(f"== Benchmark 结束时的系统快照 ==\n{snap_text}")

    parts: List[Dict[str, str]] = [{"role": "system", "content": "\n\n".join(system_blocks)}]

    # Prior conversation history (excluding the brand-new user message).
    for msg in history:
        if msg.get("role") == "user" and msg.get("content") == user_question:
            # already covered by the new user turn
            continue
        if msg.get("role") in ("user", "assistant") and msg.get("content"):
            parts.append({"role": msg["role"], "content": msg["content"]})

    parts.append({"role": "user", "content": user_question})
    return parts


def _summarize_report(report: Dict[str, Any]) -> str:
    """Compact benchmark report to fit in the system prompt."""
    keep = {
        "endpoint_label": report.get("endpoint_label"),
        "model": report.get("model"),
        "routing_strategy": report.get("routing_strategy"),
        "prompt_profile": report.get("prompt_profile"),
        "concurrency_levels": report.get("concurrency_levels"),
        "requests_per_level": report.get("requests_per_level"),
        "max_tokens": report.get("max_tokens"),
        "scenarios_summary": [],
    }
    for sc in report.get("scenarios", []) or []:
        summary = sc.get("summary") or {}
        scenario_summary = {
            "concurrency": sc.get("concurrency"),
            "wall_seconds": sc.get("wall_seconds"),
            "summary": {k: summary.get(k) for k in (
                "qps",
                "mean_ttft_seconds",
                "p95_latency_seconds",
                "p99_latency_seconds",
                "mean_e2e_latency_seconds",
                "mean_decode_tokens_per_second",
                "error_rate",
                "errors",
                "target_pod_counts",
            ) if k in summary},
        }
        keep["scenarios_summary"].append(scenario_summary)

    text = json.dumps(keep, ensure_ascii=False, indent=2)
    if len(text) > MAX_REPORT_CHARS:
        text = text[:MAX_REPORT_CHARS] + "\n...[report truncated]"
    return text
