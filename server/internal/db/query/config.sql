-- 配置中心查询（复刻 Java ConfigController）。
-- uuid 参数用 sqlc.arg(name)::uuid：既显式转换、又让 sqlc 生成具名字段（非 Column1）。

-- name: ListConfigItems :many
SELECT c.id, c.env, c.namespace, c.config_key, c.config_type,
       c.active_version, c.status, c.created_by, c.updated_at,
       COUNT(v.id)::int AS version_count
FROM config_items c
LEFT JOIN config_versions v ON v.config_item_id = c.id
GROUP BY c.id
ORDER BY c.updated_at DESC;

-- name: GetConfigActiveVersion :one
SELECT active_version FROM config_items WHERE id = sqlc.arg(id)::uuid;

-- name: GetConfigKey :one
SELECT config_key FROM config_items WHERE id = sqlc.arg(id)::uuid;

-- name: ListConfigVersions :many
SELECT version, content, change_reason, operator, status, created_at
FROM config_versions
WHERE config_item_id = sqlc.arg(config_item_id)::uuid
ORDER BY version DESC;

-- name: CreateConfigItem :one
INSERT INTO config_items (env, namespace, config_key, config_type, active_version, status, created_by)
VALUES (sqlc.arg(env), sqlc.arg(namespace), sqlc.arg(config_key), sqlc.arg(config_type), 1, 'active', sqlc.arg(created_by))
RETURNING id;

-- name: InsertConfigVersion :exec
INSERT INTO config_versions (config_item_id, version, content, change_reason, operator, status)
VALUES (sqlc.arg(config_item_id)::uuid, sqlc.arg(version), sqlc.arg(content), sqlc.arg(change_reason), sqlc.arg(operator), sqlc.arg(status));

-- name: MaxConfigVersion :one
SELECT COALESCE(MAX(version), 0)::int AS max_version
FROM config_versions WHERE config_item_id = sqlc.arg(config_item_id)::uuid;

-- name: CountConfigVersion :one
SELECT COUNT(*)::int AS n
FROM config_versions WHERE config_item_id = sqlc.arg(config_item_id)::uuid AND version = sqlc.arg(version);

-- name: ArchiveConfigVersions :exec
UPDATE config_versions SET status = 'archived' WHERE config_item_id = sqlc.arg(config_item_id)::uuid;

-- name: ActivateConfigVersion :exec
UPDATE config_versions SET status = 'active' WHERE config_item_id = sqlc.arg(config_item_id)::uuid AND version = sqlc.arg(version);

-- name: SetConfigItemActiveVersion :exec
UPDATE config_items SET active_version = sqlc.arg(active_version), updated_at = now() WHERE id = sqlc.arg(id)::uuid;
