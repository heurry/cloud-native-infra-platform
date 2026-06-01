-- 审计查询（复刻 Java AuditController / AuditService）。

-- name: ListAuditEvents :many
SELECT id, actor_id, actor_role, action, resource_type, resource_id, metadata, created_at
FROM audit_events
ORDER BY created_at DESC
LIMIT sqlc.arg(lim);

-- name: ListAuditEventsByResourceType :many
SELECT id, actor_id, actor_role, action, resource_type, resource_id, metadata, created_at
FROM audit_events
WHERE resource_type = sqlc.arg(resource_type)
ORDER BY created_at DESC
LIMIT sqlc.arg(lim);

-- name: InsertAuditEvent :exec
INSERT INTO audit_events (actor_id, actor_role, action, resource_type, resource_id, metadata)
VALUES (sqlc.arg(actor_id), sqlc.arg(actor_role), sqlc.arg(action), sqlc.arg(resource_type), sqlc.arg(resource_id), sqlc.arg(metadata)::jsonb);

-- name: UpdateServiceInstanceChecked :execrows
UPDATE service_instances SET last_checked_at = now() WHERE name = sqlc.arg(name);
