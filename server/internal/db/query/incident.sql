-- 故障事件查询（复刻 Java IncidentController）。

-- name: ListIncidents :many
SELECT id, title, severity, status, summary, created_at, resolved_at
FROM incidents
ORDER BY created_at DESC
LIMIT 100;

-- name: ListIncidentsByStatus :many
SELECT id, title, severity, status, summary, created_at, resolved_at
FROM incidents
WHERE status = sqlc.arg(status)
ORDER BY created_at DESC
LIMIT 100;

-- name: GetIncident :one
SELECT id, title, severity, status, summary, created_at, resolved_at
FROM incidents WHERE id = sqlc.arg(id)::uuid;

-- name: ListIncidentEvents :many
SELECT event_type, payload, created_at
FROM incident_events
WHERE incident_id = sqlc.arg(incident_id)::uuid
ORDER BY created_at ASC;

-- name: CreateIncident :one
INSERT INTO incidents (title, severity, status, summary)
VALUES (sqlc.arg(title), sqlc.arg(severity), 'open', sqlc.arg(summary))
RETURNING id;

-- name: InsertIncidentEvent :exec
INSERT INTO incident_events (incident_id, event_type, payload)
VALUES (sqlc.arg(incident_id)::uuid, sqlc.arg(event_type), sqlc.arg(payload)::jsonb);

-- name: AckIncident :exec
UPDATE incidents SET status = 'acknowledged' WHERE id = sqlc.arg(id)::uuid;

-- name: ResolveIncident :exec
UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = sqlc.arg(id)::uuid;
