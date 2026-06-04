"""D1: OpenTelemetry tracing for the AI service (env-gated, graceful).

接入方式与控制面一致：仅当设置了 OTEL_EXPORTER_OTLP_ENDPOINT 才初始化导出，
否则完全 no-op（不影响无 collector 的本地/CI 运行）。FastAPI 自动 instrument 会延续
来自 Go 控制面的 traceparent；Requests instrument 把 span 继续传给上游 vLLM——
于是「Go → ai-service → vLLM」连成一条端到端 trace。
"""

from __future__ import annotations

import os

from fastapi import FastAPI


def setup_telemetry(app: FastAPI) -> bool:
    """配置 OTel；成功接入返回 True，未配置/依赖缺失则优雅跳过返回 False。"""
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        return False

    service = os.getenv("OTEL_SERVICE_NAME", "ai-service")
    provider = TracerProvider(resource=Resource.create({"service.name": service}))
    # OTLPSpanExporter 自行读取 OTEL_EXPORTER_OTLP_* 环境变量（HTTP 会拼 /v1/traces）。
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)  # 延续入站 traceparent + 为每个 /internal/* 建 span
    RequestsInstrumentor().instrument()      # 把 span 传播到上游 vLLM（llm.py 用 requests）
    return True
