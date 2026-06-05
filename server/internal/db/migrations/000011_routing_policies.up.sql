-- E3：模型路由 / A-B / 影子流量。
-- routing_policies：命名路由策略——多版本加权（A/B 灰度）+ 可选影子目标（镜像流量、不回客户端）。
-- routing_samples：每次经策略路由的调用样本（主路 + 影子的状态/延迟/字节），用于 A/B 对比与回滚决策。
--
-- 000001 建过一张同名的 routing_policies 桩表（id/policy_key/strategy/weight…），但从未被任何
-- 查询接入（sqlc 生成的 RoutingPolicy 结构体是死代码）——它正是本特性当年的未完成预留。
-- 这里直接重建为 E3 真正的 schema（沿用语义最贴切的表名）。sqlc schema 列表不含本迁移，
-- 故 sqlc 仍按 000001 的旧定义生成（死结构体不变），sqlc-verify 不受影响。
DROP TABLE IF EXISTS routing_policies;

CREATE TABLE routing_policies (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    -- variants: [{label, endpoint(service_instances.name), model?, weight}]（加权随机选主路）
    variants    JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- shadow: {label, endpoint, model?} 或 NULL（镜像同一请求、丢弃响应、只采指标）
    shadow      JSONB,
    -- metadata.prev_variants 保存「全量/回滚」前的权重快照
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by  TEXT NOT NULL DEFAULT 'system',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routing_samples (
    id                 BIGSERIAL PRIMARY KEY,
    policy_name        TEXT NOT NULL,
    request_id         TEXT NOT NULL DEFAULT '',
    variant_label      TEXT NOT NULL,
    variant_endpoint   TEXT NOT NULL DEFAULT '',
    primary_status     INT NOT NULL,
    primary_latency_ms INT NOT NULL,
    primary_bytes      INT NOT NULL DEFAULT 0,
    shadow_label       TEXT NOT NULL DEFAULT '',
    shadow_endpoint    TEXT NOT NULL DEFAULT '',
    shadow_status      INT,
    shadow_latency_ms  INT,
    shadow_bytes       INT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routing_samples_policy_time
    ON routing_samples (policy_name, created_at DESC);
