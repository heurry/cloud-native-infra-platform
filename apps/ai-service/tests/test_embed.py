"""Embedding stub tests (5B.4c) — deterministic, no model/network needed."""

from __future__ import annotations

import math

from aiservice.config import load_config
from aiservice.embed import embed_texts


def _stub_cfg(monkeypatch):
    monkeypatch.setenv("AI_STUB_MODE", "on")  # 强制 stub，不触网
    return load_config()


def test_stub_dim_and_mode(monkeypatch):
    cfg = _stub_cfg(monkeypatch)
    vecs, mode = embed_texts(["hello", "world"], is_query=False, cfg=cfg)
    assert mode == "stub"
    assert len(vecs) == 2
    assert all(len(v) == cfg.embed_dim == 1024 for v in vecs)


def test_stub_deterministic_and_distinct(monkeypatch):
    cfg = _stub_cfg(monkeypatch)
    a1, _ = embed_texts(["same"], is_query=False, cfg=cfg)
    a2, _ = embed_texts(["same"], is_query=False, cfg=cfg)
    b, _ = embed_texts(["different"], is_query=False, cfg=cfg)
    assert a1[0] == a2[0]      # 同输入 → 同向量
    assert a1[0] != b[0]       # 不同输入 → 不同向量


def test_stub_unit_norm(monkeypatch):
    cfg = _stub_cfg(monkeypatch)
    (v,), _ = embed_texts(["norm me"], is_query=False, cfg=cfg)
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-6


def test_empty_input(monkeypatch):
    cfg = _stub_cfg(monkeypatch)
    vecs, _ = embed_texts([], is_query=False, cfg=cfg)
    assert vecs == []
