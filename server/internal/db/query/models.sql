-- C1：模型注册中心查询（独立 model registry）。

-- name: ListModelVersions :many
SELECT id, model_id, version, base_model, lora_adapter, parent_version, artifact_uri, tags, status, created_by, created_at, updated_at
FROM models
ORDER BY model_id ASC, created_at DESC;

-- name: GetModelVersion :one
SELECT id, model_id, version, base_model, lora_adapter, parent_version, artifact_uri, tags, status, created_by, created_at, updated_at
FROM models WHERE id = sqlc.arg(id)::uuid;

-- name: ListVersionsByModelID :many
SELECT id, model_id, version, base_model, lora_adapter, parent_version, artifact_uri, tags, status, created_by, created_at, updated_at
FROM models WHERE model_id = sqlc.arg(model_id)
ORDER BY created_at DESC;

-- name: RegisterModelVersion :one
INSERT INTO models (model_id, version, base_model, lora_adapter, parent_version, artifact_uri, tags, status, created_by)
VALUES (
    sqlc.arg(model_id), sqlc.arg(version), sqlc.arg(base_model), sqlc.arg(lora_adapter),
    sqlc.arg(parent_version), sqlc.arg(artifact_uri), sqlc.arg(tags)::jsonb, sqlc.arg(status), sqlc.arg(created_by)
)
RETURNING id;

-- name: UpdateModelVersionStatus :one
UPDATE models SET status = sqlc.arg(status), updated_at = now()
WHERE id = sqlc.arg(id)::uuid
RETURNING model_id, version;

-- name: SetModelArtifact :exec
UPDATE models SET artifact_uri = sqlc.arg(artifact_uri), updated_at = now()
WHERE id = sqlc.arg(id)::uuid;

-- name: DeleteModelVersion :one
DELETE FROM models WHERE id = sqlc.arg(id)::uuid
RETURNING model_id, version;
