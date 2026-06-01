"""CloudNative Infra Platform AI service behind the Go control plane.

Phase 3 boundary (云原生平台/11-go迁移计划.md):
  Go 取证 → POST /internal/diagnose → 本服务 RAG+LLM 推理出结构化 JSON → Go 落库+审计。

Self-contained: no imports from the legacy `src/` monolith, so it builds/deploys alone.
"""

__version__ = "0.1.0"
