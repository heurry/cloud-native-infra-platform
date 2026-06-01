"""Wire contract shared with the Go control plane (internal/aiclient).

Field names/types must stay in sync with aiclient.DiagnoseRequest/DiagnoseResult.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DiagnoseOptions(BaseModel):
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


class DiagnoseRequest(BaseModel):
    question: str
    evidence: Dict[str, Any] = Field(default_factory=dict)
    options: Optional[DiagnoseOptions] = None


class EvidenceItem(BaseModel):
    label: str
    detail: str
    source: str = "metrics"  # metrics | incidents | deployments | kubernetes | config


class RecommendedAction(BaseModel):
    action: str
    risk: str = "low"  # low | medium | high
    impact: str = ""


class RelatedResource(BaseModel):
    type: str  # deployment | incident | config | service
    id: Optional[str] = None
    name: Optional[str] = None


class DiagnoseResponse(BaseModel):
    status: str = "completed"  # completed | failed
    root_cause: str = ""
    confidence: Optional[float] = None
    impact: str = ""
    evidence: List[EvidenceItem] = Field(default_factory=list)
    recommended_actions: List[RecommendedAction] = Field(default_factory=list)
    related_resources: List[RelatedResource] = Field(default_factory=list)
    model_id: str = ""
    endpoint_id: str = ""
    latency_ms: Optional[float] = None
    mode: str = "stub"  # stub | live —— 排查无 GPU 时为何是假响应
    error: Optional[str] = None


class ChatRequest(BaseModel):
    question: Optional[str] = None
    messages: Optional[List[Dict[str, Any]]] = None
    max_tokens: int = 1024
    temperature: float = 0.2
