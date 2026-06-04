-- C2：分层存储生命周期——归档清单。
-- 后台/手动归档把 PG 中过期的高频数据（metrics_samples / audit_events）序列化为 NDJSON
-- 落到 MinIO 对象层，并在此登记一条清单（对象 key + 行数 + 时间范围 + 字节），使「冷数据」可回溯。
-- 保留策略由配置中心（config_items: storage.retention）驱动——平台用自己的配置中心管自己。
CREATE TABLE archive_manifests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_table VARCHAR(64) NOT NULL,
    object_key   TEXT NOT NULL,
    row_count    INTEGER NOT NULL DEFAULT 0,
    bytes        BIGINT NOT NULL DEFAULT 0,
    min_ts       TIMESTAMPTZ,
    max_ts       TIMESTAMPTZ,
    archived_by  VARCHAR(128),
    archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_archive_manifests_table ON archive_manifests (source_table, archived_at DESC);
