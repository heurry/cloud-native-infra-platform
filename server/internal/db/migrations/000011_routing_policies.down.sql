DROP TABLE IF EXISTS routing_samples;
DROP TABLE IF EXISTS routing_policies;

-- 还原 000001 的桩表，保证 down 后 schema 与 up 前一致。
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
