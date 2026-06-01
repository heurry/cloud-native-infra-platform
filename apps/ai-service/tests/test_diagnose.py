"""Unit tests for the deterministic stub diagnosis.

Pure logic —— 只依赖 pydantic，不需要 FastAPI / requests / GPU，可在任意环境跑：
    cd apps/ai-service && python -m pytest tests/ -q
"""

from aiservice.diagnose import stub_diagnose
from aiservice.schemas import DiagnoseRequest


def _req(evidence):
    return DiagnoseRequest(question="为什么延迟升高？", evidence=evidence)


def test_high_error_rate_dominates():
    resp = stub_diagnose(_req({"metrics": {
        "error_rate": 0.1, "p95_latency_ms": 100, "p99_latency_ms": 120,
        "request_count": 50, "qps": 0.08,
    }}))
    assert resp.status == "completed"
    assert "错误率" in resp.root_cause
    assert resp.confidence is not None and resp.confidence >= 0.5
    assert len(resp.recommended_actions) >= 1
    assert any(e.source == "metrics" for e in resp.evidence)


def test_high_latency_when_errors_ok():
    resp = stub_diagnose(_req({"metrics": {
        "error_rate": 0.0, "p95_latency_ms": 5000, "p99_latency_ms": 8000,
        "request_count": 30, "qps": 0.05,
    }}))
    assert "延迟" in resp.root_cause or "P95" in resp.root_cause
    assert resp.confidence == 0.7


def test_active_incident_when_metrics_clean():
    resp = stub_diagnose(_req({
        "metrics": {"error_rate": 0.0, "p95_latency_ms": 100, "p99_latency_ms": 150,
                    "request_count": 10, "qps": 0.01},
        "incidents": [{"id": "i1", "title": "GPU OOM", "severity": "high", "status": "open"}],
    }))
    assert "GPU OOM" in resp.root_cause
    assert any(r.type == "incident" for r in resp.related_resources)


def test_nominal_when_all_clean():
    resp = stub_diagnose(_req({"metrics": {
        "error_rate": 0.0, "p95_latency_ms": 100, "p99_latency_ms": 150,
        "request_count": 10, "qps": 0.01,
    }}))
    assert "正常" in resp.root_cause or "未发现" in resp.root_cause


def test_related_resources_from_deployments():
    resp = stub_diagnose(_req({
        "metrics": {},
        "deployments": [{"id": "d1", "name": "qwen3-4b", "status": "running", "version": "v2"}],
    }))
    assert any(r.type == "deployment" and r.name == "qwen3-4b" for r in resp.related_resources)


def test_deterministic():
    evidence = {"metrics": {
        "error_rate": 0.05, "p95_latency_ms": 200, "p99_latency_ms": 300,
        "request_count": 40, "qps": 0.06,
    }}
    first = stub_diagnose(_req(evidence)).model_dump()
    second = stub_diagnose(_req(evidence)).model_dump()
    assert first == second
