-- V2 默认种子数据：让首批只读接口在空集群下也能返回可演示的服务实例。
-- 由 Flyway V2__seed_defaults.sql 逐字迁移而来。
-- 这些是平台自身的服务治理对象（与前端 mockServiceInstances 对齐），非业务 mock。

INSERT INTO knowledge_versions (version, description, status)
VALUES ('default', '默认知识库版本', 'active')
ON CONFLICT (version) DO NOTHING;

INSERT INTO service_instances (name, base_url, model_id, kind, gpu_id, routing_role, status, metadata)
VALUES
    ('auto-router', 'http://127.0.0.1:8088/api/proxy/auto-router/v1', 'qwen3-4b-platform', 'auto_router', 'auto', 'auto_router', 'unknown',
     '{"candidate_endpoints": ["aibrix-gateway", "direct-round-robin"], "routing_strategies": ["least-request", "least-kv-cache", "prefix-cache"]}'::jsonb),
    ('aibrix-gateway', 'http://127.0.0.1:8010/v1', 'qwen3-4b-platform', 'aibrix', 'gateway', 'gateway', 'unknown',
     '{"routing_strategies": ["least-request", "least-kv-cache", "prefix-cache"]}'::jsonb),
    ('direct-round-robin', 'http://127.0.0.1:8088/api/proxy/direct-round-robin/v1', 'qwen3-4b-platform', 'client_round_robin', 'client', 'client_round_robin', 'unknown',
     '{"target_instances": ["vllm-replica-0", "vllm-replica-1"]}'::jsonb),
    ('vllm-replica-0', 'http://127.0.0.1:8000/v1', 'qwen3-4b-platform', 'vllm', '0', 'replica', 'unknown', '{}'::jsonb),
    ('vllm-replica-1', 'http://127.0.0.1:8001/v1', 'qwen3-4b-platform', 'vllm', '1', 'replica', 'unknown', '{}'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO models (model_id, display_name, base_model, status, metadata)
VALUES ('qwen3-4b-platform', 'Qwen3 4B Platform', 'Qwen/Qwen3-4B', 'serving',
        '{"context_length": 4096, "quantization": "awq"}'::jsonb)
ON CONFLICT (model_id) DO NOTHING;
