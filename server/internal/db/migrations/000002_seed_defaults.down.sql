-- 回滚 000002：删除默认种子。
DELETE FROM service_instances
 WHERE name IN ('auto-router', 'aibrix-gateway', 'direct-round-robin', 'vllm-replica-0', 'vllm-replica-1');
DELETE FROM models WHERE model_id = 'qwen3-4b-platform';
DELETE FROM knowledge_versions WHERE version = 'default';
