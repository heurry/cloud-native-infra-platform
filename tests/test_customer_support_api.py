from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks


@pytest.fixture()
def harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    app_config = tmp_path / "customer_support_api.yaml"
    service_config = tmp_path / "service_instances.yaml"
    db_path = tmp_path / "customer_support.db"

    app_config.write_text(
        f"""
server:
  host: 127.0.0.1
  port: 18088
storage:
  sqlite_path: {db_path}
cors:
  allow_origins:
    - http://127.0.0.1:5173
rag:
  top_k: 3
  max_context_chars: 2000
chat:
  default_endpoint: auto-router
  fallback_endpoint: vllm-replica-0
  default_max_tokens: 64
  temperature: 0.0
  request_timeout_seconds: 1
""",
        encoding="utf-8",
    )
    service_config.write_text(
        """
instances:
  - name: auto-router
    kind: auto_router
    base_url: http://127.0.0.1:18088/api/proxy/auto-router/v1
    model_id: qwen3-4b-customer
    gpu_id: auto
    routing_role: auto_router
    api_key: EMPTY
    status: unknown
    metadata:
      candidate_endpoints:
        - aibrix-gateway
        - direct-round-robin
      routing_strategies:
        - least-request
        - prefix-cache
        - least-kv-cache
        - least-latency

  - name: aibrix-gateway
    kind: aibrix
    base_url: http://127.0.0.1:11/v1
    model_id: qwen3-4b-customer
    gpu_id: gateway
    routing_role: gateway
    api_key: EMPTY
    status: unknown
    metadata:
      routing_strategies:
        - least-request
        - prefix-cache
        - least-kv-cache
        - least-latency

  - name: vllm-replica-0
    kind: vllm
    base_url: http://127.0.0.1:9/v1
    model_id: qwen3-4b-customer
    gpu_id: "0"
    routing_role: replica
    api_key: EMPTY
    status: unknown
  - name: vllm-replica-1
    kind: vllm
    base_url: http://127.0.0.1:10/v1
    model_id: qwen3-4b-customer
    gpu_id: "1"
    routing_role: replica
    api_key: EMPTY
    status: unknown
  - name: direct-round-robin
    kind: client_round_robin
    base_url: http://127.0.0.1:9/v1
    model_id: qwen3-4b-customer
    gpu_id: dual
    routing_role: client_round_robin
    api_key: EMPTY
    status: unknown
    metadata:
      target_instances:
        - vllm-replica-0
        - vllm-replica-1
""",
        encoding="utf-8",
    )

    monkeypatch.setenv("CUSTOMER_SUPPORT_API_CONFIG", str(app_config))
    monkeypatch.setenv("SERVICE_INSTANCES_CONFIG", str(service_config))
    sys.modules.pop("src.api.main", None)
    api_main = importlib.import_module("src.api.main")
    api_main._bootstrap_defaults()

    yield SimpleNamespace(module=api_main)


def test_health_and_service_bootstrap(harness: SimpleNamespace) -> None:
    api_main = harness.module
    assert api_main.health()["status"] == "ok"

    payload = api_main.list_service_instances()
    instances = {item["name"]: item for item in payload["instances"]}
    assert instances["auto-router"]["routing_role"] == "auto_router"
    assert instances["vllm-replica-0"]["model_id"] == "qwen3-4b-customer"
    assert instances["direct-round-robin"]["routing_role"] == "client_round_robin"


def test_knowledge_search_and_eval(harness: SimpleNamespace) -> None:
    api_main = harness.module
    response = api_main.create_document(
        api_main.DocumentCreate(
            doc_id="refund-policy-v1",
            title="退款规则",
            content="订单支付后 7 天内，未发货商品可申请退款。",
            category="refund",
            version="default",
        )
    )
    assert response["status"] == "upserted"

    rebuilt = api_main.rebuild_index()
    assert rebuilt["document_count"] == 1

    search = api_main.knowledge_search(q="退款规则", top_k=4)
    assert search["documents"][0]["doc_id"] == "refund-policy-v1"

    eval_run = api_main.run_customer_support_eval(
        api_main.EvalRunRequest(
            qa_samples=[{"question": "退款规则是什么？", "doc_ids": ["refund-policy-v1"]}],
            top_k=3,
        )
    )
    assert eval_run["status"] == "completed"
    assert eval_run["metrics"]["retrieval_recall_at_1"] == 1.0


def test_chat_sse_fallback_and_metrics(harness: SimpleNamespace) -> None:
    import asyncio

    api_main = harness.module
    session = api_main.create_chat_session(api_main.ChatSessionCreate(title="test", user_role="customer"))

    async def collect_stream() -> str:
        response = api_main.stream_chat_message(
            session["session_id"],
            api_main.ChatMessageRequest(content="完全未知的问题"),
        )
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk)
        return "".join(chunks)

    body = asyncio.run(collect_stream())

    assert "event: retrieval" in body
    assert "event: fallback" in body
    assert "event: metrics" in body
    assert "event: done" in body

    metrics = api_main.get_current_metrics()
    assert metrics["request_count"] >= 1
    traces = api_main.get_metric_requests(session_id=session["session_id"], limit=100)
    assert traces["requests"][0]["fallback_reason"] == "no_retrieval_hit"

    stored = api_main.get_chat_session(session["session_id"])
    assistant_message = [item for item in stored["messages"] if item["role"] == "assistant"][0]
    feedback = api_main.create_message_feedback(
        assistant_message["message_id"],
        api_main.MessageFeedbackCreate(rating="should_handoff", note="missing evidence"),
    )
    assert feedback["rating"] == "should_handoff"


def test_chat_sse_greeting_uses_customer_friendly_reply(harness: SimpleNamespace) -> None:
    import asyncio

    api_main = harness.module
    session = api_main.create_chat_session(api_main.ChatSessionCreate(title="greeting", user_role="customer"))

    async def collect_stream() -> str:
        response = api_main.stream_chat_message(
            session["session_id"],
            api_main.ChatMessageRequest(content="你好"),
        )
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk)
        return "".join(chunks)

    body = asyncio.run(collect_stream())

    assert "您好，请问有什么可以帮您？" in body
    assert "当前知识库没有找到足够证据" not in body
    traces = api_main.get_metric_requests(session_id=session["session_id"], limit=100)
    assert traces["requests"][0]["fallback_reason"] == "greeting"


def test_benchmark_can_queue_when_endpoint_configured(harness: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    api_main = harness.module
    response = api_main.create_serving_benchmark(
        api_main.BenchmarkRunRequest(
            endpoint_id="vllm-replica-0",
            workload="faq_short",
            routing_strategy="direct",
            concurrency_levels=[1],
            requests_per_level=1,
            max_tokens=8,
        ),
        BackgroundTasks(),
    )
    assert response["status"] == "queued"

    run = api_main.get_benchmark_run(response["run_id"])
    assert run["run_id"] == response["run_id"]


def test_client_round_robin_endpoint_selects_targets(harness: SimpleNamespace) -> None:
    api_main = harness.module
    first = api_main._get_endpoint("direct-round-robin")
    second = api_main._get_endpoint("direct-round-robin")
    benchmark_endpoint = api_main._get_benchmark_endpoint("direct-round-robin")

    assert first["requested_endpoint_id"] == "direct-round-robin"
    assert second["requested_endpoint_id"] == "direct-round-robin"
    assert [first["name"], second["name"]] == ["vllm-replica-0", "vllm-replica-1"]
    assert benchmark_endpoint["base_url"].endswith("/api/proxy/direct-round-robin/v1")


def test_auto_router_prefers_aibrix_and_selects_strategy(harness: SimpleNamespace) -> None:
    api_main = harness.module
    endpoint = api_main._get_endpoint(
        "auto-router",
        {
            "content": "退款规则是什么？",
            "documents": [{"doc_id": "refund-policy-v1", "score": 0.8}, {"doc_id": "invoice-policy-v1", "score": 0.1}],
            "max_tokens": 64,
        },
    )
    headers = api_main._upstream_request_headers(endpoint, "req-1")

    assert endpoint["name"] == "aibrix-gateway"
    assert endpoint["requested_endpoint_id"] == "auto-router"
    assert endpoint["selected_endpoint_id"] == "aibrix-gateway"
    assert endpoint["routing_strategy"] == "prefix-cache"
    assert headers["routing-strategy"] == "prefix-cache"

    benchmark_endpoint = api_main._get_benchmark_endpoint("auto-router")
    assert benchmark_endpoint["base_url"].endswith("/api/proxy/auto-router/v1")


def test_auto_router_falls_back_to_round_robin_when_aibrix_unreachable(harness: SimpleNamespace) -> None:
    api_main = harness.module
    api_main.db.execute("UPDATE service_instances SET status='unreachable' WHERE name='aibrix-gateway'")

    first = api_main._get_endpoint("auto-router", {"content": "hello", "documents": [], "max_tokens": 8})
    second = api_main._get_endpoint("auto-router", {"content": "hello", "documents": [], "max_tokens": 8})

    assert first["requested_endpoint_id"] == "auto-router"
    assert second["requested_endpoint_id"] == "auto-router"
    assert [first["name"], second["name"]] == ["vllm-replica-0", "vllm-replica-1"]


def test_client_round_robin_healthcheck_aggregates_targets(
    harness: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    api_main = harness.module

    def fake_check(endpoint: dict, timeout: float = 3) -> tuple[str, str]:
        if endpoint["name"] == "vllm-replica-0":
            return "healthy", ""
        return "unreachable", "connection refused"

    monkeypatch.setattr(api_main, "_check_openai_endpoint", fake_check)
    result = api_main.service_instance_healthcheck("direct-round-robin")

    assert result["status"] == "degraded"
    instances = {item["name"]: item for item in api_main.list_service_instances()["instances"]}
    assert instances["vllm-replica-0"]["status"] == "healthy"
    assert instances["vllm-replica-1"]["status"] == "unreachable"
