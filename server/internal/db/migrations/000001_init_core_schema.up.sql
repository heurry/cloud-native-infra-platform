-- V1 初始 schema（对齐 云原生平台/05-database-design.md，PostgreSQL 目标库）
-- 由 Flyway V1__init_core_schema.sql 逐字迁移而来（golang-migrate / pgx5）。
-- MVP 不强制外键约束，但字段命名与目标模型一致；JSONB 存放可变 metadata。

-- ============================================================
-- Identity / Audit
-- ============================================================
CREATE TABLE users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username     VARCHAR(128) NOT NULL UNIQUE,
    display_name VARCHAR(128),
    role         VARCHAR(64) NOT NULL DEFAULT 'viewer',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id      VARCHAR(128),
    actor_role    VARCHAR(64),
    action        VARCHAR(128) NOT NULL,
    resource_type VARCHAR(64),
    resource_id   VARCHAR(128),
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_events (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_events (actor_id, created_at DESC);

-- ============================================================
-- Platform Metadata
-- ============================================================
CREATE TABLE applications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_key     VARCHAR(128) NOT NULL UNIQUE,
    name        VARCHAR(128) NOT NULL,
    owner       VARCHAR(128),
    env         VARCHAR(32) NOT NULL DEFAULT 'dev',
    description TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_services (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id       UUID,
    service_key  VARCHAR(128) NOT NULL,
    name         VARCHAR(128) NOT NULL,
    namespace    VARCHAR(128),
    service_type VARCHAR(64),
    status       VARCHAR(32) NOT NULL DEFAULT 'unknown',
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_dependencies (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_service_id UUID NOT NULL,
    target_service_id UUID NOT NULL,
    dependency_type   VARCHAR(64),
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Kubernetes
-- ============================================================
CREATE TABLE clusters (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_key VARCHAR(128) NOT NULL UNIQUE,
    name        VARCHAR(128) NOT NULL,
    provider    VARCHAR(64),
    region      VARCHAR(64),
    status      VARCHAR(32) NOT NULL DEFAULT 'active',
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE namespaces (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id UUID,
    name       VARCHAR(128) NOT NULL,
    status     VARCHAR(32) NOT NULL DEFAULT 'active',
    labels     JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE k8s_resources (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id  UUID,
    namespace   VARCHAR(128),
    kind        VARCHAR(64) NOT NULL,
    name        VARCHAR(256) NOT NULL,
    status      VARCHAR(64),
    ready       VARCHAR(32),
    restarts    INTEGER NOT NULL DEFAULT 0,
    node_name   VARCHAR(128),
    pod_ip      INET,
    labels      JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw         JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_k8s_res_identity ON k8s_resources (cluster_id, namespace, kind, name);
CREATE INDEX idx_k8s_res_status ON k8s_resources (kind, status, observed_at DESC);

CREATE TABLE k8s_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id    UUID,
    namespace     VARCHAR(128),
    resource_kind VARCHAR(64),
    resource_name VARCHAR(256),
    reason        VARCHAR(128),
    message       TEXT,
    type          VARCHAR(32),
    event_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_k8s_events_time ON k8s_events (event_time DESC);

-- ============================================================
-- Model Serving
-- ============================================================
CREATE TABLE models (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id      VARCHAR(128) NOT NULL UNIQUE,
    display_name  VARCHAR(128),
    base_model    VARCHAR(256),
    artifact_uri  TEXT,
    tokenizer_uri TEXT,
    status        VARCHAR(32) NOT NULL DEFAULT 'ready',
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_adapters (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id     UUID,
    adapter_id   VARCHAR(128) NOT NULL,
    adapter_type VARCHAR(64),
    artifact_uri TEXT,
    status       VARCHAR(32) NOT NULL DEFAULT 'ready',
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) NOT NULL UNIQUE,
    base_url        TEXT NOT NULL,
    model_id        VARCHAR(128),
    kind            VARCHAR(64) NOT NULL DEFAULT 'vllm',
    gpu_id          VARCHAR(64),
    routing_role    VARCHAR(64),
    api_key         VARCHAR(256),
    status          VARCHAR(32) NOT NULL DEFAULT 'unknown',
    last_checked_at TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routing_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_key          VARCHAR(128) NOT NULL,
    service_instance_id UUID,
    strategy            VARCHAR(64),
    weight              INTEGER NOT NULL DEFAULT 1,
    conditions          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Config / Deployments
-- ============================================================
CREATE TABLE config_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id         UUID,
    env            VARCHAR(32) NOT NULL DEFAULT 'dev',
    namespace      VARCHAR(128),
    config_key     VARCHAR(256) NOT NULL,
    config_type    VARCHAR(64) NOT NULL DEFAULT 'yaml',
    active_version INTEGER NOT NULL DEFAULT 1,
    status         VARCHAR(32) NOT NULL DEFAULT 'active',
    created_by     VARCHAR(128),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_config_identity UNIQUE (app_id, env, namespace, config_key)
);

CREATE TABLE config_versions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_item_id UUID NOT NULL,
    version        INTEGER NOT NULL,
    content        TEXT,
    change_reason  TEXT,
    operator       VARCHAR(128),
    status         VARCHAR(32) NOT NULL DEFAULT 'draft',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_config_versions_item ON config_versions (config_item_id, version DESC);

CREATE TABLE deployments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id     UUID,
    deployment_key VARCHAR(128),
    version        VARCHAR(128),
    env            VARCHAR(32),
    status         VARCHAR(32) NOT NULL DEFAULT 'running',
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- Observability
-- ============================================================
CREATE TABLE request_traces (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id         VARCHAR(128) NOT NULL,
    session_id         VARCHAR(128),
    endpoint_id        VARCHAR(128),
    target_pod         VARCHAR(256),
    model_id           VARCHAR(128),
    retrieval_ms       NUMERIC,
    queue_or_gateway_ms NUMERIC,
    ttft_ms            NUMERIC,
    generation_ms      NUMERIC,
    total_ms           NUMERIC,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    status             VARCHAR(32) NOT NULL DEFAULT 'ok',
    error              TEXT,
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_traces_time ON request_traces (created_at DESC);
CREATE INDEX idx_traces_endpoint ON request_traces (endpoint_id, created_at DESC);
CREATE INDEX idx_traces_pod ON request_traces (target_pod, created_at DESC);
CREATE INDEX idx_traces_status ON request_traces (status, created_at DESC);

CREATE TABLE metrics_samples (
    id         BIGSERIAL PRIMARY KEY,
    source     VARCHAR(128),
    metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_metrics_samples_time ON metrics_samples (created_at DESC);

CREATE TABLE incidents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title               VARCHAR(256) NOT NULL,
    severity            VARCHAR(32) NOT NULL DEFAULT 'info',
    status              VARCHAR(32) NOT NULL DEFAULT 'open',
    related_service_id  UUID,
    summary             TEXT,
    diagnosis_id        UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at         TIMESTAMPTZ
);

CREATE TABLE incident_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL,
    event_type  VARCHAR(64),
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Knowledge / RAG
-- ============================================================
CREATE TABLE knowledge_versions (
    version     VARCHAR(128) PRIMARY KEY,
    description TEXT,
    status      VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_documents (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id     VARCHAR(128) NOT NULL UNIQUE,
    title      VARCHAR(256),
    content    TEXT,
    category   VARCHAR(128),
    version    VARCHAR(128),
    source_uri TEXT,
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   UUID NOT NULL,
    chunk_index   INTEGER NOT NULL,
    content       TEXT,
    embedding_ref TEXT,
    token_count   INTEGER,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Benchmarks / Evaluation
-- ============================================================
CREATE TABLE benchmark_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           VARCHAR(128) NOT NULL UNIQUE,
    endpoint_id      VARCHAR(128),
    workload         VARCHAR(128),
    routing_strategy VARCHAR(64),
    status           VARCHAR(32) NOT NULL DEFAULT 'queued',
    config           JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary          JSONB NOT NULL DEFAULT '{}'::jsonb,
    report_path      TEXT,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE benchmark_samples (
    id         BIGSERIAL PRIMARY KEY,
    run_id     VARCHAR(128) NOT NULL,
    event_type VARCHAR(64),
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_benchmark_samples_run ON benchmark_samples (run_id, id);

CREATE TABLE eval_runs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     VARCHAR(128) NOT NULL UNIQUE,
    model_id   VARCHAR(128),
    dataset    VARCHAR(128),
    status     VARCHAR(32) NOT NULL DEFAULT 'running',
    metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
