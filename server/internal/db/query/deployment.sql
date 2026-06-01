-- 发布流水线查询（复刻 Java DeploymentController）。

-- name: ListDeployments :many
SELECT id, deployment_key, version, env, status, started_at, finished_at, metadata
FROM deployments
ORDER BY started_at DESC NULLS LAST, id DESC
LIMIT 100;

-- name: CreateDeployment :one
INSERT INTO deployments (deployment_key, version, env, status, started_at, metadata)
VALUES (sqlc.arg(deployment_key), sqlc.arg(version), sqlc.arg(env), 'running', now(), sqlc.arg(metadata)::jsonb)
RETURNING id;

-- name: FinishDeployment :exec
UPDATE deployments SET status = sqlc.arg(status), finished_at = now() WHERE id = sqlc.arg(id)::uuid;

-- name: GetDeploymentKey :one
SELECT deployment_key FROM deployments WHERE id = sqlc.arg(id)::uuid;

-- name: GetDeploymentForRollback :one
SELECT deployment_key, version, env, metadata FROM deployments WHERE id = sqlc.arg(id)::uuid;

-- name: MarkDeploymentRolledBack :exec
UPDATE deployments SET status = 'rolled_back', finished_at = now() WHERE id = sqlc.arg(id)::uuid;
