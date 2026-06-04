-- C1：把既有 models 表（000001）升级为版本化模型注册中心（model registry）。
-- 既有 models 是「每 model_id 一行、无版本」且无写入方；这里加 版本/血缘/LoRA/标签/创建人，
-- 并把唯一约束从 (model_id) 改为 (model_id, version)，支持同一模型的多版本与血缘链。
-- 复用既有列：display_name / base_model / artifact_uri / tokenizer_uri / status / metadata。
ALTER TABLE models ADD COLUMN version VARCHAR(64) NOT NULL DEFAULT 'v1';
ALTER TABLE models ADD COLUMN lora_adapter VARCHAR(256);
ALTER TABLE models ADD COLUMN parent_version VARCHAR(64);
ALTER TABLE models ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE models ADD COLUMN created_by VARCHAR(128);

ALTER TABLE models DROP CONSTRAINT IF EXISTS models_model_id_key;
ALTER TABLE models ADD CONSTRAINT models_model_id_version_key UNIQUE (model_id, version);

CREATE INDEX IF NOT EXISTS idx_models_model_id ON models (model_id);
