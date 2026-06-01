-- V4 AI 诊断结果表（Phase 3）。
-- 结构化诊断（Go 取证 → Python RAG+LLM 推理 → Go 落库）的持久化目标。
-- 字段对齐结构化输出：Root Cause / Evidence / Impact / Recommended Actions / Confidence / Related Resources。
CREATE TABLE diagnoses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question            TEXT NOT NULL,
    status              VARCHAR(32) NOT NULL DEFAULT 'completed',  -- completed / failed
    root_cause          TEXT,
    confidence          NUMERIC,                                   -- 0.0 ~ 1.0
    impact              TEXT,
    evidence            JSONB NOT NULL DEFAULT '[]'::jsonb,
    recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    related_resources   JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_id            VARCHAR(128),
    endpoint_id         VARCHAR(128),
    latency_ms          NUMERIC,
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_diagnoses_time ON diagnoses (created_at DESC);
