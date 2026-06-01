from __future__ import annotations

import json
import threading
import time
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, AsyncGenerator, Dict, Generator, List
from uuid import uuid4

import requests
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from src.api.config import load_app_config, load_service_instances
from src.api.db import Database, json_dumps, json_loads, utc_now
from src.api.sse import sse_event
from src.customer_support.memory import build_memory_aware_query, compact_conversation_memory
from src.customer_support.policy import build_fallback_answer, decide_fallback
from src.customer_support.prompt import build_chat_messages
from src.customer_support.response_filter import StreamingAnswerFilter
from src.customer_support.schemas import (
    BenchmarkRunRequest,
    ChatMessageRequest,
    ChatSessionCreate,
    DocumentCreate,
    EvalRunRequest,
    KnowledgeVersionCreate,
    MessageFeedbackCreate,
)
from src.jobs.benchmark import append_event, start_serving_benchmark_job
from src.metrics.store import current_metrics, metrics_history
from src.rag.retriever import Retriever, tokenize
from src.serve.openai_client import normalize_base_url


def _model_payload(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _base_health_url(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/v1"):
        trimmed = trimmed[:-3]
    return trimmed + "/health"


def _check_openai_endpoint(endpoint: Dict[str, Any], timeout: float = 3) -> tuple[str, str]:
    status = "unreachable"
    detail = ""
    try:
        response = requests.get(_base_health_url(endpoint["base_url"]), timeout=timeout)
        if response.status_code < 500:
            return "healthy", ""
        detail = response.text[:300]
    except requests.RequestException as exc:
        detail = str(exc)
        try:
            response = requests.get(normalize_base_url(endpoint["base_url"]) + "/models", timeout=timeout)
            status = "healthy" if response.status_code < 500 else "unreachable"
        except requests.RequestException as second_exc:
            detail = f"{detail}; models check: {second_exc}"
    return status, detail


def _bootstrap_defaults() -> None:
    now = utc_now()
    db.execute(
        """
        INSERT OR IGNORE INTO knowledge_versions(version, description, status, created_at)
        VALUES (?, ?, ?, ?)
        """,
        ("default", "Default local customer support knowledge base", "active", now),
    )
    for item in load_service_instances():
        db.execute(
            """
            INSERT INTO service_instances(name, base_url, model_id, kind, gpu_id, routing_role, api_key, status, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                base_url=excluded.base_url,
                model_id=excluded.model_id,
                kind=excluded.kind,
                gpu_id=excluded.gpu_id,
                routing_role=excluded.routing_role,
                api_key=excluded.api_key,
                metadata_json=excluded.metadata_json
            """,
            (
                item.get("name"),
                item.get("base_url"),
                item.get("model_id"),
                item.get("kind", "vllm"),
                str(item.get("gpu_id", "")),
                item.get("routing_role", ""),
                item.get("api_key", "EMPTY"),
                item.get("status", "unknown"),
                json_dumps(item.get("metadata", {})),
            ),
        )


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    _bootstrap_defaults()
    yield


cfg = load_app_config()
db = Database(cfg.database_path)
retriever = Retriever(db)
_rr_lock = threading.Lock()
_rr_positions: Dict[str, int] = {}

app = FastAPI(
    title="CloudNative Infra Platform API",
    version="0.1.0",
    description="FastAPI gateway for customer support RAG, vLLM/AIBrix serving, metrics, evals, and benchmarks.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "database": str(cfg.database_path)}


def _get_endpoint(endpoint_id: str | None, route_context: Dict[str, Any] | None = None) -> Dict[str, Any]:
    name = endpoint_id or cfg.default_endpoint
    endpoint = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (name,))
    if endpoint:
        if endpoint.get("kind") == "auto_router" or endpoint.get("routing_role") == "auto_router":
            return _select_auto_endpoint(endpoint, route_context or {})
        if endpoint.get("kind") == "client_round_robin" or endpoint.get("routing_role") == "client_round_robin":
            return _select_round_robin_endpoint(endpoint)
        return endpoint
    fallback = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (cfg.fallback_endpoint,))
    if fallback:
        return fallback
    raise HTTPException(status_code=404, detail=f"No service instance configured for `{name}`")


def _get_benchmark_endpoint(endpoint_id: str) -> Dict[str, Any]:
    endpoint = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (endpoint_id,))
    if endpoint and (
        endpoint.get("kind") in {"client_round_robin", "auto_router"}
        or endpoint.get("routing_role") in {"client_round_robin", "auto_router"}
    ):
        proxied = dict(endpoint)
        proxied["base_url"] = f"http://{cfg.host}:{cfg.port}/api/proxy/{endpoint['name']}/v1"
        return proxied
    return _get_endpoint(endpoint_id)


# Mount the AI Ops chat router now that _get_endpoint is defined.  The router
# uses _get_endpoint to resolve the same vLLM endpoint as customer support.
from src.api.aiops import create_router as _create_aiops_router  # noqa: E402

app.include_router(_create_aiops_router(db=db, cfg=cfg, get_endpoint=_get_endpoint))


def _select_round_robin_endpoint(router: Dict[str, Any]) -> Dict[str, Any]:
    metadata = json_loads(router.get("metadata_json"), {})
    target_names = metadata.get("target_instances", [])
    if not isinstance(target_names, list) or not target_names:
        raise HTTPException(status_code=400, detail=f"Round-robin endpoint `{router['name']}` has no target_instances")
    placeholders = ",".join("?" for _ in target_names)
    rows = db.fetch_all(
        f"SELECT * FROM service_instances WHERE name IN ({placeholders}) ORDER BY name",
        tuple(str(item) for item in target_names),
    )
    targets_by_name = {row["name"]: row for row in rows}
    ordered_targets = [targets_by_name[name] for name in target_names if name in targets_by_name]
    if not ordered_targets:
        raise HTTPException(status_code=404, detail=f"Round-robin endpoint `{router['name']}` has no configured targets")
    with _rr_lock:
        position = _rr_positions.get(router["name"], 0)
        _rr_positions[router["name"]] = position + 1
    selected = dict(ordered_targets[position % len(ordered_targets)])
    selected["requested_endpoint_id"] = router["name"]
    selected["routing_strategy"] = "client_round_robin"
    selected["target_pod_hint"] = selected["name"]
    return selected


def _select_auto_endpoint(router: Dict[str, Any], route_context: Dict[str, Any]) -> Dict[str, Any]:
    metadata = json_loads(router.get("metadata_json"), {})
    candidate_names = metadata.get("candidate_endpoints") or ["aibrix-gateway", "direct-round-robin"]
    if not isinstance(candidate_names, list):
        candidate_names = ["aibrix-gateway", "direct-round-robin"]
    candidate_names = [str(item) for item in candidate_names if item]
    if not candidate_names:
        candidate_names = ["aibrix-gateway", "direct-round-robin"]
    rows = db.fetch_all(
        "SELECT * FROM service_instances WHERE name IN ({})".format(",".join("?" for _ in candidate_names)),
        tuple(str(item) for item in candidate_names),
    )
    candidates = {row["name"]: row for row in rows if _endpoint_available(row)}

    aibrix = candidates.get("aibrix-gateway")
    if aibrix:
        strategy, reason = _choose_aibrix_strategy(route_context, metadata)
        selected = dict(aibrix)
        selected["requested_endpoint_id"] = router["name"]
        selected["selected_endpoint_id"] = aibrix["name"]
        selected["routing_strategy"] = strategy
        selected["route_reason"] = reason
        selected["target_pod_hint"] = "aibrix-gateway"
        return selected

    rr = candidates.get("direct-round-robin")
    if rr:
        selected = _select_round_robin_endpoint(rr)
        selected["requested_endpoint_id"] = router["name"]
        selected["selected_endpoint_id"] = selected["name"]
        selected["route_reason"] = "aibrix_unavailable_use_client_round_robin"
        return selected

    for name in candidate_names:
        endpoint = candidates.get(str(name))
        if endpoint:
            selected = dict(endpoint)
            selected["requested_endpoint_id"] = router["name"]
            selected["selected_endpoint_id"] = endpoint["name"]
            selected["route_reason"] = "first_available_candidate"
            return selected

    fallback = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (cfg.fallback_endpoint,))
    if fallback:
        selected = dict(fallback)
        selected["requested_endpoint_id"] = router["name"]
        selected["selected_endpoint_id"] = fallback["name"]
        selected["route_reason"] = "fallback_endpoint"
        return selected
    raise HTTPException(status_code=503, detail=f"Auto router `{router['name']}` has no available endpoints")


def _endpoint_available(endpoint: Dict[str, Any]) -> bool:
    return str(endpoint.get("status") or "unknown").lower() not in {"missing", "unreachable"}


def _choose_aibrix_strategy(route_context: Dict[str, Any], metadata: Dict[str, Any]) -> tuple[str, str]:
    strategies = metadata.get("routing_strategies") or ["least-request"]
    if not isinstance(strategies, list):
        strategies = [str(strategies)]
    allowed = {str(item) for item in strategies}

    question = str(route_context.get("content") or "")
    docs = route_context.get("documents") or []
    max_tokens = int(route_context.get("max_tokens") or cfg.default_max_tokens)
    query_tokens = len(tokenize(question))
    top_score = max((float(doc.get("score") or 0.0) for doc in docs if isinstance(doc, dict)), default=0.0)
    stats = _recent_endpoint_stats("aibrix-gateway")

    high_latency_ms = float(metadata.get("high_latency_ms", 3000))
    high_error_rate = float(metadata.get("high_error_rate", 0.02))
    long_prompt_tokens = int(metadata.get("long_prompt_tokens", 160))
    long_generation_tokens = int(metadata.get("long_generation_tokens", 256))
    high_retrieval_score = float(metadata.get("high_retrieval_score", 0.35))

    if stats["request_count"] >= 8 and (stats["error_rate"] >= high_error_rate or (stats["p95_latency_ms"] or 0) >= high_latency_ms):
        return _first_allowed("least-latency", allowed, strategies), "recent_latency_or_error_pressure"
    if query_tokens >= long_prompt_tokens or max_tokens >= long_generation_tokens:
        return _first_allowed("least-kv-cache", allowed, strategies), "long_prompt_or_generation"
    if len(docs) >= 2 and top_score >= high_retrieval_score:
        return _first_allowed("prefix-cache", allowed, strategies), "rag_shared_prefix_candidate"
    return _first_allowed("least-request", allowed, strategies), "default_balanced_load"


def _first_allowed(preferred: str, allowed: set[str], ordered: List[Any]) -> str:
    if preferred in allowed:
        return preferred
    return str(ordered[0]) if ordered else "least-request"


def _recent_endpoint_stats(endpoint_id: str) -> Dict[str, Any]:
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="milliseconds")
    rows = db.fetch_all(
        """
        SELECT total_ms, status
        FROM request_traces
        WHERE endpoint_id=? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 200
        """,
        (endpoint_id, cutoff),
    )
    latencies = sorted(float(row["total_ms"]) for row in rows if row.get("total_ms") is not None)
    errors = [row for row in rows if row.get("status") != "ok"]
    p95 = None
    if latencies:
        p95 = latencies[min(int(len(latencies) * 0.95), len(latencies) - 1)]
    return {
        "request_count": len(rows),
        "error_rate": len(errors) / len(rows) if rows else 0.0,
        "p95_latency_ms": p95,
    }


def _extract_stream_content(event: Dict[str, Any]) -> str:
    choices = event.get("choices")
    if not choices or not isinstance(choices, list):
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def _response_header(headers: requests.structures.CaseInsensitiveDict[str], candidates: List[str]) -> str:
    for item in candidates:
        value = headers.get(item)
        if value:
            return value
    return ""


def _upstream_request_headers(endpoint: Dict[str, Any], request_id: str) -> Dict[str, str]:
    headers = {
        "Authorization": f"Bearer {endpoint.get('api_key') or 'EMPTY'}",
        "Content-Type": "application/json",
        "x-request-id": request_id,
        "model": endpoint["model_id"],
    }
    if endpoint.get("kind") == "aibrix" or endpoint.get("routing_role") == "gateway":
        metadata = json_loads(endpoint.get("metadata_json"), {})
        routing_strategies = metadata.get("routing_strategies", [])
        routing_strategy = str(endpoint.get("routing_strategy") or "least-request")
        if isinstance(routing_strategies, list) and routing_strategies:
            routing_strategy = str(endpoint.get("routing_strategy") or routing_strategies[0])
        elif isinstance(routing_strategies, str) and routing_strategies:
            routing_strategy = str(endpoint.get("routing_strategy") or routing_strategies)
        headers["routing-strategy"] = routing_strategy
    return headers


def _insert_message(session_id: str, role: str, content: str, metadata: Dict[str, Any] | None = None) -> str:
    message_id = uuid4().hex
    db.execute(
        """
        INSERT INTO messages(message_id, session_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (message_id, session_id, role, content, json_dumps(metadata or {}), utc_now()),
    )
    db.execute("UPDATE conversations SET updated_at=? WHERE session_id=?", (utc_now(), session_id))
    return message_id


def _fetch_conversation_memory(session_id: str, limit: int = 8) -> List[Dict[str, str]]:
    rows = db.fetch_all(
        """
        SELECT role, content
        FROM messages
        WHERE session_id=?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (session_id, limit),
    )
    rows.reverse()
    return compact_conversation_memory(rows, max_messages=limit)


def _insert_trace(payload: Dict[str, Any]) -> None:
    db.execute(
        """
        INSERT OR REPLACE INTO request_traces(
            request_id, session_id, retrieval_ms, queue_or_gateway_ms, ttft_ms, generation_ms,
            total_ms, input_tokens, output_tokens, target_pod, model_id, fallback_reason,
            citation_doc_ids, endpoint_id, status, error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.get("request_id"),
            payload.get("session_id"),
            payload.get("retrieval_ms"),
            payload.get("queue_or_gateway_ms"),
            payload.get("ttft_ms"),
            payload.get("generation_ms"),
            payload.get("total_ms"),
            payload.get("input_tokens"),
            payload.get("output_tokens"),
            payload.get("target_pod"),
            payload.get("model_id"),
            payload.get("fallback_reason"),
            json_dumps(payload.get("citation_doc_ids", [])),
            payload.get("endpoint_id"),
            payload.get("status", "ok"),
            payload.get("error"),
            utc_now(),
        ),
    )


@app.post("/api/chat/sessions")
def create_chat_session(payload: ChatSessionCreate) -> Dict[str, Any]:
    session_id = uuid4().hex
    now = utc_now()
    db.execute(
        """
        INSERT INTO conversations(session_id, title, user_role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (session_id, payload.title or "New customer support chat", payload.user_role, now, now),
    )
    return {"session_id": session_id, "title": payload.title or "New customer support chat", "created_at": now}


@app.get("/api/chat/sessions")
def list_chat_sessions(limit: int = Query(50, ge=1, le=200)) -> Dict[str, Any]:
    rows = db.fetch_all(
        """
        SELECT session_id, title, user_role, created_at, updated_at
        FROM conversations
        ORDER BY updated_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return {"sessions": rows}


@app.get("/api/chat/sessions/{session_id}")
def get_chat_session(session_id: str) -> Dict[str, Any]:
    session = db.fetch_one("SELECT * FROM conversations WHERE session_id=?", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = db.fetch_all(
        "SELECT message_id, role, content, metadata_json, created_at FROM messages WHERE session_id=? ORDER BY created_at",
        (session_id,),
    )
    for message in messages:
        message["metadata"] = json_loads(message.pop("metadata_json"), {})
    return {"session": session, "messages": messages}


@app.post("/api/chat/messages/{message_id}/feedback")
def create_message_feedback(message_id: str, payload: MessageFeedbackCreate) -> Dict[str, Any]:
    message = db.fetch_one("SELECT * FROM messages WHERE message_id=?", (message_id,))
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    metadata = json_loads(message.get("metadata_json"), {})
    feedback_id = uuid4().hex
    db.execute(
        """
        INSERT INTO message_feedback(feedback_id, message_id, session_id, request_id, rating, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            feedback_id,
            message_id,
            message["session_id"],
            metadata.get("request_id"),
            payload.rating,
            payload.note,
            utc_now(),
        ),
    )
    return {"feedback_id": feedback_id, "message_id": message_id, "rating": payload.rating}


@app.post("/api/chat/sessions/{session_id}/messages:stream")
def stream_chat_message(session_id: str, payload: ChatMessageRequest) -> StreamingResponse:
    session = db.fetch_one("SELECT session_id, user_role FROM conversations WHERE session_id=?", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    async def generate() -> AsyncGenerator[str, None]:
        request_id = uuid4().hex
        total_start = time.perf_counter()
        conversation_memory = _fetch_conversation_memory(session_id)
        retrieval_query = build_memory_aware_query(payload.content, conversation_memory)
        _insert_message(session_id, "user", payload.content)

        retrieval_start = time.perf_counter()
        docs = retriever.search(
            retrieval_query,
            top_k=cfg.rag_top_k,
        )
        retrieval_ms = (time.perf_counter() - retrieval_start) * 1000
        citation_doc_ids = [doc["doc_id"] for doc in docs]
        yield sse_event(
            "retrieval",
            {
                "request_id": request_id,
                "query": retrieval_query,
                "memory_turns": len(conversation_memory),
                "documents": [
                    {
                        "doc_id": doc["doc_id"],
                        "title": doc["title"],
                        "category": doc["category"],
                        "version": doc["version"],
                        "score": doc.get("score", 0),
                    }
                    for doc in docs
                ],
                "retrieval_ms": retrieval_ms,
            },
        )

        endpoint: Dict[str, Any] | None = None
        answer_parts: List[str] = []
        target_pod = ""
        error = None
        ttft_ms = None
        answer_filter = StreamingAnswerFilter()

        fallback_reason = decide_fallback(
            payload.content,
            docs,
            conversation_memory,
        )

        if fallback_reason:
            answer = build_fallback_answer(payload.content, docs, fallback_reason)
            answer_parts.append(answer)
            yield sse_event("fallback", {"request_id": request_id, "reason": fallback_reason})
            yield sse_event("token", {"request_id": request_id, "text": answer})
        else:
            try:
                endpoint = _get_endpoint(
                    payload.endpoint_id,
                    {
                        "content": payload.content,
                        "documents": docs,
                        "max_tokens": payload.max_tokens or cfg.default_max_tokens,
                    },
                )
                target_pod = endpoint.get("target_pod_hint") or endpoint["name"]
                yield sse_event(
                    "route",
                    {
                        "request_id": request_id,
                        "endpoint_id": endpoint.get("requested_endpoint_id", endpoint["name"]),
                        "selected_endpoint_id": endpoint.get("selected_endpoint_id", endpoint["name"]),
                        "routing_strategy": endpoint.get("routing_strategy", ""),
                        "route_reason": endpoint.get("route_reason", ""),
                        "target_hint": target_pod,
                    },
                )
                messages = build_chat_messages(
                    user_question=payload.content,
                    retrieved_documents=docs,
                    max_context_chars=cfg.max_context_chars,
                    conversation_history=conversation_memory,
                )
                url = normalize_base_url(endpoint["base_url"]) + "/chat/completions"
                headers = _upstream_request_headers(endpoint, request_id)
                stream_start = time.perf_counter()
                with requests.post(
                    url,
                    headers=headers,
                    json={
                        "model": endpoint["model_id"],
                        "messages": messages,
                        "max_tokens": payload.max_tokens or cfg.default_max_tokens,
                        "temperature": cfg.temperature if payload.temperature is None else payload.temperature,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                        "chat_template_kwargs": {"enable_thinking": False},
                    },
                    stream=True,
                    timeout=cfg.request_timeout_seconds,
                ) as response:
                    target_pod = _response_header(
                        response.headers,
                        ["target-pod", "x-target-pod", "x-aibrix-target-pod", "x-envoy-upstream-host"],
                    )
                    if not target_pod:
                        target_pod = endpoint.get("target_pod_hint") or endpoint["name"]
                    response.raise_for_status()
                    for line in response.iter_lines(decode_unicode=True):
                        if not line or not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if raw == "[DONE]":
                            break
                        event = json.loads(raw)
                        text = _extract_stream_content(event)
                        if not text:
                            continue
                        for output in answer_filter.feed(text):
                            if ttft_ms is None:
                                ttft_ms = (time.perf_counter() - stream_start) * 1000
                            answer_parts.append(output)
                            yield sse_event("token", {"request_id": request_id, "text": output})
                    for output in answer_filter.finish():
                        if ttft_ms is None:
                            ttft_ms = (time.perf_counter() - stream_start) * 1000
                        answer_parts.append(output)
                        yield sse_event("token", {"request_id": request_id, "text": output})
            except Exception as exc:  # noqa: BLE001 - stream should degrade gracefully for demos.
                error = str(exc)
                fallback_reason = "model_endpoint_error"
                answer = build_fallback_answer(payload.content, docs, fallback_reason)
                answer_parts.append(answer)
                yield sse_event("fallback", {"request_id": request_id, "reason": fallback_reason, "error": error})
                yield sse_event("token", {"request_id": request_id, "text": answer})

        answer_text = "".join(answer_parts).strip()
        total_ms = (time.perf_counter() - total_start) * 1000
        generation_ms = max(total_ms - retrieval_ms, 0)
        output_tokens = len(tokenize(answer_text))
        _insert_message(
            session_id,
            "assistant",
            answer_text,
            {
                "request_id": request_id,
                "citation_doc_ids": citation_doc_ids,
                "target_pod": target_pod,
                "fallback_reason": fallback_reason,
                "memory_turns": len(conversation_memory),
                "retrieval_query": retrieval_query,
            },
        )
        trace = {
            "request_id": request_id,
            "session_id": session_id,
            "retrieval_ms": retrieval_ms,
            "queue_or_gateway_ms": None,
            "ttft_ms": ttft_ms,
            "generation_ms": generation_ms,
            "total_ms": total_ms,
            "input_tokens": len(tokenize(payload.content)),
            "output_tokens": output_tokens,
            "target_pod": target_pod,
            "model_id": endpoint["model_id"] if endpoint else "",
            "selected_endpoint_id": endpoint.get("selected_endpoint_id", endpoint["name"]) if endpoint else "",
            "routing_strategy": endpoint.get("routing_strategy", "") if endpoint else "",
            "route_reason": endpoint.get("route_reason", "") if endpoint else "",
            "fallback_reason": fallback_reason,
            "citation_doc_ids": citation_doc_ids,
            "endpoint_id": endpoint.get("requested_endpoint_id", endpoint["name"]) if endpoint else "",
            "status": "error" if error else "ok",
            "error": error,
        }
        _insert_trace(trace)
        yield sse_event("citation", {"request_id": request_id, "doc_ids": citation_doc_ids})
        yield sse_event("metrics", trace)
        yield sse_event("done", {"request_id": request_id})

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/knowledge/versions")
def create_knowledge_version(payload: KnowledgeVersionCreate) -> Dict[str, Any]:
    db.execute(
        """
        INSERT INTO knowledge_versions(version, description, status, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET description=excluded.description, status=excluded.status
        """,
        (payload.version, payload.description, payload.status, utc_now()),
    )
    return {"version": payload.version, "status": payload.status}


@app.get("/api/knowledge/versions")
def list_knowledge_versions() -> Dict[str, Any]:
    return {
        "versions": db.fetch_all("SELECT * FROM knowledge_versions ORDER BY created_at DESC")
    }


@app.post("/api/knowledge/documents")
def create_document(payload: DocumentCreate) -> Dict[str, Any]:
    db.execute(
        """
        INSERT INTO documents(doc_id, title, content, category, effective_from, version, source_uri, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
            title=excluded.title,
            content=excluded.content,
            category=excluded.category,
            effective_from=excluded.effective_from,
            version=excluded.version,
            source_uri=excluded.source_uri
        """,
        (
            payload.doc_id,
            payload.title,
            payload.content,
            payload.category,
            payload.effective_from,
            payload.version,
            payload.source_uri,
            utc_now(),
        ),
    )
    return {"doc_id": payload.doc_id, "status": "upserted"}


@app.get("/api/knowledge/documents")
def list_documents(limit: int = Query(100, ge=1, le=500)) -> Dict[str, Any]:
    rows = db.fetch_all(
        """
        SELECT doc_id, title, category, effective_from, version, source_uri, created_at
        FROM documents
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return {"documents": rows}


@app.post("/api/knowledge/rebuild-index")
def rebuild_index() -> Dict[str, Any]:
    count = db.fetch_one("SELECT COUNT(*) AS n FROM documents") or {"n": 0}
    return {
        "status": "rebuilt",
        "index_type": "sqlite_lexical_v1",
        "document_count": count["n"],
        "note": "This V1 index uses lexical scoring and can be replaced by FAISS/embedding without changing the API.",
    }


@app.get("/api/knowledge/search")
def knowledge_search(
    q: str = Query(..., min_length=1),
    top_k: int = Query(4, ge=1, le=20),
    category_prefix: Annotated[List[str] | None, Query()] = None,
) -> Dict[str, Any]:
    return {
        "query": q,
        "documents": retriever.search(q, top_k=top_k, category_prefixes=category_prefix),
    }


@app.get("/api/models")
def list_models() -> Dict[str, Any]:
    rows = db.fetch_all("SELECT name, model_id, kind, status FROM service_instances ORDER BY name")
    model_ids = sorted({row["model_id"] for row in rows})
    return {"models": [{"model_id": item} for item in model_ids], "service_instances": rows}


@app.post("/api/proxy/{endpoint_id}/v1/chat/completions")
async def proxy_chat_completions(endpoint_id: str, request: Request):
    payload = await request.json()
    endpoint = _get_endpoint(
        endpoint_id,
        {
            "content": " ".join(str(message.get("content", "")) for message in payload.get("messages", []) if isinstance(message, dict)),
            "documents": [],
            "max_tokens": payload.get("max_tokens", cfg.default_max_tokens),
        },
    )
    upstream_url = normalize_base_url(endpoint["base_url"]) + "/chat/completions"
    headers = _upstream_request_headers(endpoint, request.headers.get("x-request-id", uuid4().hex))
    headers["Authorization"] = request.headers.get("authorization", headers["Authorization"])
    headers["model"] = str(payload.get("model") or endpoint["model_id"])
    target_pod = endpoint.get("target_pod_hint") or endpoint["name"]
    if payload.get("stream", False):
        def generate() -> Generator[bytes, None, None]:
            with requests.post(
                upstream_url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=cfg.request_timeout_seconds,
            ) as response:
                response.raise_for_status()
                for chunk in response.iter_content(chunk_size=None):
                    if chunk:
                        yield chunk

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"x-target-pod": target_pod, "x-routing-endpoint": endpoint_id},
        )

    response = requests.post(
        upstream_url,
        headers=headers,
        json=payload,
        timeout=cfg.request_timeout_seconds,
    )
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/json"),
        headers={"x-target-pod": target_pod, "x-routing-endpoint": endpoint_id},
    )


@app.get("/api/service-instances")
def list_service_instances() -> Dict[str, Any]:
    rows = db.fetch_all("SELECT * FROM service_instances ORDER BY name")
    for row in rows:
        row["metadata"] = json_loads(row.pop("metadata_json"), {})
    return {"instances": rows}


@app.post("/api/service-instances/{instance_id}/healthcheck")
def service_instance_healthcheck(instance_id: str) -> Dict[str, Any]:
    endpoint = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (instance_id,))
    if not endpoint:
        raise HTTPException(status_code=404, detail="Service instance not found")
    if endpoint.get("kind") == "auto_router" or endpoint.get("routing_role") == "auto_router":
        metadata = json_loads(endpoint.get("metadata_json"), {})
        target_names = [str(item) for item in metadata.get("candidate_endpoints", []) if item]
        target_results = []
        for name in target_names:
            target = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (name,))
            if not target:
                target_results.append({"name": name, "status": "missing", "detail": "not configured"})
                continue
            target_status, target_detail = service_instance_healthcheck(name)["status"], ""
            target_results.append({"name": name, "status": target_status, "detail": target_detail})
        healthy_count = sum(1 for item in target_results if item["status"] in {"healthy", "degraded"})
        status = "healthy" if healthy_count > 0 else "unreachable"
        detail = json_dumps({"targets": target_results})
    elif endpoint.get("kind") == "client_round_robin" or endpoint.get("routing_role") == "client_round_robin":
        metadata = json_loads(endpoint.get("metadata_json"), {})
        target_names = [str(item) for item in metadata.get("target_instances", []) if item]
        target_results = []
        for name in target_names:
            target = db.fetch_one("SELECT * FROM service_instances WHERE name=?", (name,))
            if not target:
                target_results.append({"name": name, "status": "missing", "detail": "not configured"})
                continue
            target_status, target_detail = _check_openai_endpoint(target, timeout=2)
            target_results.append({"name": name, "status": target_status, "detail": target_detail})
            db.execute(
                "UPDATE service_instances SET status=?, last_checked_at=? WHERE name=?",
                (target_status, utc_now(), name),
            )
        healthy_count = sum(1 for item in target_results if item["status"] == "healthy")
        if healthy_count == len(target_results) and target_results:
            status = "healthy"
        elif healthy_count > 0:
            status = "degraded"
        else:
            status = "unreachable"
        detail = json_dumps({"targets": target_results})
    else:
        status, detail = _check_openai_endpoint(endpoint)
    db.execute(
        "UPDATE service_instances SET status=?, last_checked_at=? WHERE name=?",
        (status, utc_now(), instance_id),
    )
    return {"name": instance_id, "status": status, "detail": detail}


@app.post("/api/evals/customer-support")
def run_customer_support_eval(payload: EvalRunRequest) -> Dict[str, Any]:
    run_id = uuid4().hex
    hits_at_1 = 0
    hits_at_3 = 0
    hits_at_5 = 0
    total = 0
    for sample in payload.qa_samples:
        question = str(sample.get("question", ""))
        gold_doc_ids = {str(item) for item in sample.get("doc_ids", [])}
        if not question or not gold_doc_ids:
            continue
        total += 1
        docs = retriever.search(question, top_k=max(5, payload.top_k))
        doc_ids = [doc["doc_id"] for doc in docs]
        hits_at_1 += int(bool(gold_doc_ids.intersection(doc_ids[:1])))
        hits_at_3 += int(bool(gold_doc_ids.intersection(doc_ids[:3])))
        hits_at_5 += int(bool(gold_doc_ids.intersection(doc_ids[:5])))
    metrics = {
        "num_samples": total,
        "retrieval_recall_at_1": hits_at_1 / total if total else None,
        "retrieval_recall_at_3": hits_at_3 / total if total else None,
        "retrieval_recall_at_5": hits_at_5 / total if total else None,
    }
    now = utc_now()
    db.execute(
        "INSERT INTO eval_runs(run_id, status, metrics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (run_id, "completed", json_dumps(metrics), now, now),
    )
    return {"run_id": run_id, "status": "completed", "metrics": metrics}


@app.get("/api/evals/{run_id}")
def get_eval_run(run_id: str) -> Dict[str, Any]:
    run = db.fetch_one("SELECT * FROM eval_runs WHERE run_id=?", (run_id,))
    if not run:
        raise HTTPException(status_code=404, detail="Eval run not found")
    run["metrics"] = json_loads(run.pop("metrics_json"), {})
    return run


@app.post("/api/benchmarks/serving")
def create_serving_benchmark(payload: BenchmarkRunRequest, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    endpoint = _get_benchmark_endpoint(payload.endpoint_id)
    run_id = uuid4().hex
    now = utc_now()
    db.execute(
        """
        INSERT INTO benchmark_runs(run_id, status, endpoint_id, workload, routing_strategy, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            "queued",
            payload.endpoint_id,
            payload.workload,
            payload.routing_strategy,
            json_dumps(_model_payload(payload)),
            now,
            now,
        ),
    )
    append_event(db, run_id, "queued", {"endpoint_id": payload.endpoint_id, "workload": payload.workload})
    background_tasks.add_task(
        start_serving_benchmark_job,
        db=db,
        run_id=run_id,
        endpoint=endpoint,
        request=_model_payload(payload),
    )
    return {"run_id": run_id, "status": "queued"}


@app.get("/api/benchmarks/{run_id}")
def get_benchmark_run(run_id: str) -> Dict[str, Any]:
    run = db.fetch_one("SELECT * FROM benchmark_runs WHERE run_id=?", (run_id,))
    if not run:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    run["config"] = json_loads(run.pop("config_json"), {})
    run["summary"] = json_loads(run.pop("summary_json"), {})
    return run


@app.get("/api/benchmarks/{run_id}/events")
def get_benchmark_events(run_id: str) -> Dict[str, Any]:
    rows = db.fetch_all(
        """
        SELECT event_type, payload_json, created_at
        FROM benchmark_samples
        WHERE run_id=?
        ORDER BY sample_id ASC
        """,
        (run_id,),
    )
    for row in rows:
        row["payload"] = json_loads(row.pop("payload_json"), {})
    return {"run_id": run_id, "events": rows}


@app.get("/api/metrics/current")
def get_current_metrics() -> Dict[str, Any]:
    metrics = current_metrics(db)
    db.execute(
        "INSERT INTO metrics_samples(source, metrics_json, created_at) VALUES (?, ?, ?)",
        ("api", json_dumps(metrics), utc_now()),
    )
    return metrics


@app.get("/api/metrics/history")
def get_metrics_history(limit: int = Query(200, ge=1, le=2000)) -> Dict[str, Any]:
    return {"samples": metrics_history(db, limit=limit)}


@app.get("/api/metrics/requests")
def get_metric_requests(session_id: str | None = None, limit: int = Query(100, ge=1, le=500)) -> Dict[str, Any]:
    if session_id:
        rows = db.fetch_all(
            "SELECT * FROM request_traces WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
            (session_id, limit),
        )
    else:
        rows = db.fetch_all("SELECT * FROM request_traces ORDER BY created_at DESC LIMIT ?", (limit,))
    for row in rows:
        row["citation_doc_ids"] = json_loads(row.get("citation_doc_ids"), [])
    return {"requests": rows}


@app.get("/api/metrics/stream")
def stream_metrics() -> StreamingResponse:
    def generate() -> Generator[str, None, None]:
        while True:
            metrics = current_metrics(db)
            yield sse_event("metrics", metrics)
            time.sleep(2)

    return StreamingResponse(generate(), media_type="text/event-stream")
