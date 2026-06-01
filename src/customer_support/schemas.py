from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ChatSessionCreate(BaseModel):
    title: Optional[str] = None
    user_role: str = "customer"


class ChatMessageRequest(BaseModel):
    content: str = Field(..., min_length=1)
    endpoint_id: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    user_role: str = "customer"


class MessageFeedbackCreate(BaseModel):
    rating: str = Field(..., min_length=1)
    note: Optional[str] = None


class KnowledgeVersionCreate(BaseModel):
    version: str = Field(..., min_length=1)
    description: str = ""
    status: str = "active"


class DocumentCreate(BaseModel):
    doc_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    category: str = "general"
    effective_from: Optional[str] = None
    version: str = "default"
    source_uri: Optional[str] = None


class EvalRunRequest(BaseModel):
    qa_samples: List[Dict[str, Any]] = Field(default_factory=list)
    top_k: int = 3


class BenchmarkRunRequest(BaseModel):
    endpoint_id: str = "aibrix-gateway"
    workload: str = "faq_short"
    routing_strategy: str = "least-request"
    concurrency_levels: List[int] = Field(default_factory=lambda: [1, 2, 4, 8, 16])
    requests_per_level: int = 16
    max_tokens: int = 256
