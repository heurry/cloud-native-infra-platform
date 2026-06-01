-- AI 诊断查询（Phase 3）。

-- name: InsertDiagnosis :one
INSERT INTO diagnoses (
    question, status, root_cause, confidence, impact,
    evidence, recommended_actions, related_resources,
    model_id, endpoint_id, latency_ms, error
) VALUES (
    sqlc.arg(question), sqlc.arg(status), sqlc.arg(root_cause), sqlc.arg(confidence), sqlc.arg(impact),
    sqlc.arg(evidence)::jsonb, sqlc.arg(recommended_actions)::jsonb, sqlc.arg(related_resources)::jsonb,
    sqlc.arg(model_id), sqlc.arg(endpoint_id), sqlc.arg(latency_ms), sqlc.arg(error)
)
RETURNING id;

-- name: GetDiagnosis :one
SELECT id, question, status, root_cause, confidence, impact,
       evidence, recommended_actions, related_resources,
       model_id, endpoint_id, latency_ms, error, created_at
FROM diagnoses WHERE id = sqlc.arg(id)::uuid;

-- name: ListDiagnoses :many
SELECT id, question, status, root_cause, confidence, impact,
       model_id, endpoint_id, latency_ms, error, created_at
FROM diagnoses
ORDER BY created_at DESC
LIMIT sqlc.arg(lim);
