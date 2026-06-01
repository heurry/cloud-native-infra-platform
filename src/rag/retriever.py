from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any, Dict, List, Sequence

from src.api.db import Database


TOKEN_PATTERN = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)
CJK_PATTERN = re.compile(r"[\u4e00-\u9fff]")


def tokenize(text: str) -> List[str]:
    tokens: List[str] = []
    for item in TOKEN_PATTERN.findall(text or ""):
        token = item.lower().strip()
        if not token:
            continue
        tokens.append(token)
        if CJK_PATTERN.search(token) and len(token) > 1:
            max_n = min(4, len(token))
            for n in range(2, max_n + 1):
                tokens.extend(token[idx : idx + n] for idx in range(0, len(token) - n + 1))
    return tokens


def score_document(query_tokens: List[str], document: Dict[str, Any]) -> float:
    if not query_tokens:
        return 0.0
    doc_tokens = tokenize(" ".join(str(document.get(key, "")) for key in ("title", "content", "category")))
    if not doc_tokens:
        return 0.0
    query_counts = Counter(query_tokens)
    doc_counts = Counter(doc_tokens)
    overlap = sum(min(query_counts[token], doc_counts[token]) for token in query_counts)
    coverage = overlap / max(len(query_tokens), 1)
    density = overlap / math.sqrt(len(doc_tokens))
    return coverage + density


class Retriever:
    def __init__(self, db: Database) -> None:
        self.db = db

    def search(
        self,
        query: str,
        top_k: int = 4,
        category_prefixes: Sequence[str] | None = None,
    ) -> List[Dict[str, Any]]:
        rows = self.db.fetch_all(
            """
            SELECT doc_id, title, content, category, effective_from, version, source_uri, created_at
            FROM documents
            ORDER BY created_at DESC
            """
        )
        query_tokens = tokenize(query)
        prefixes = tuple(prefix for prefix in (category_prefixes or []) if prefix)
        scored = []
        for row in rows:
            if prefixes and not str(row.get("category") or "").startswith(prefixes):
                continue
            score = score_document(query_tokens, row)
            if score > 0:
                item = dict(row)
                item["score"] = score
                scored.append(item)
        scored.sort(key=lambda item: item["score"], reverse=True)
        return scored[:top_k]
