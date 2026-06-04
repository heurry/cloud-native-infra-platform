DROP INDEX IF EXISTS idx_models_model_id;
ALTER TABLE models DROP CONSTRAINT IF EXISTS models_model_id_version_key;
ALTER TABLE models ADD CONSTRAINT models_model_id_key UNIQUE (model_id);
ALTER TABLE models DROP COLUMN IF EXISTS created_by;
ALTER TABLE models DROP COLUMN IF EXISTS tags;
ALTER TABLE models DROP COLUMN IF EXISTS parent_version;
ALTER TABLE models DROP COLUMN IF EXISTS lora_adapter;
ALTER TABLE models DROP COLUMN IF EXISTS version;
