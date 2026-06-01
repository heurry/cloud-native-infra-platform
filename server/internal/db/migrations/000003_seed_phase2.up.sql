-- V3 Phase 2 种子：配置中心 / 发布流水线 / 审计 / 故障事件的可演示初始数据。
-- 由 Flyway V3__seed_phase2.sql 逐字迁移而来。
-- 与前端原占位页对齐（redis-config / vllm-deployment / aibrix-gateway 等），
-- 让控制面在空库首启时即可呈现真实交互（可发布/回滚/处置），非业务 mock。

-- ============================================================
-- 配置项 + 版本
-- ============================================================
INSERT INTO config_items (id, env, namespace, config_key, config_type, active_version, status, created_by)
VALUES
    ('11111111-1111-1111-1111-111111111101', 'prod', 'default', 'redis-config', 'ConfigMap', 2, 'active', 'Platform'),
    ('11111111-1111-1111-1111-111111111102', 'prod', 'default', 'vllm-deployment', 'Deployment', 1, 'active', 'AI Infra'),
    ('11111111-1111-1111-1111-111111111103', 'prod', 'aibrix-system', 'aibrix-gateway', 'Gateway', 1, 'active', 'AIBrix')
ON CONFLICT (id) DO NOTHING;

INSERT INTO config_versions (config_item_id, version, content, change_reason, operator, status)
VALUES
    ('11111111-1111-1111-1111-111111111101', 1, 'maxmemory 2gb\nmaxmemory-policy allkeys-lru', '初始化', 'Platform', 'archived'),
    ('11111111-1111-1111-1111-111111111101', 2, 'maxmemory 4gb\nmaxmemory-policy allkeys-lru', '提升缓存上限以缓解驱逐', 'Platform', 'active'),
    ('11111111-1111-1111-1111-111111111102', 1, 'replicas: 2\nimage: vllm-openai:2026.05', '初始化', 'AI Infra', 'active'),
    ('11111111-1111-1111-1111-111111111103', 1, 'routing: least-request\nversion: 0.6.0', '初始化', 'AIBrix', 'active')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 发布部署
-- ============================================================
INSERT INTO deployments (id, deployment_key, version, env, status, started_at, finished_at, metadata)
VALUES
    ('22222222-2222-2222-2222-222222222201', 'qwen3-4b-platform-serving', '2026.05', 'prod', 'running',
     now() - interval '2 minutes', NULL,
     '{"image": "vllm-openai:2026.05", "branch": "main", "gate": "security scan", "owner": "Model Platform"}'::jsonb),
    ('22222222-2222-2222-2222-222222222202', 'aibrix-gateway', '0.6.0', 'prod', 'success',
     now() - interval '1 day', now() - interval '1 day' + interval '3 minutes',
     '{"image": "aibrix/gateway:0.6.0", "branch": "main", "gate": "approved", "owner": "AI Infra"}'::jsonb),
    ('22222222-2222-2222-2222-222222222203', 'metadata-service', '2026.05', 'prod', 'success',
     now() - interval '2 days', now() - interval '2 days' + interval '2 minutes',
     '{"image": "metadata:2026.05", "branch": "main", "gate": "approved", "owner": "Platform"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 故障事件 + 时间线
-- ============================================================
INSERT INTO incidents (id, title, severity, status, summary, created_at)
VALUES
    ('33333333-3333-3333-3333-333333333301', 'redis 缓存驱逐率升高导致 P95 抖动', 'warning', 'open',
     'redis-config maxmemory 不足，命中率下降，上游 TTFT 升高', now() - interval '30 minutes')
ON CONFLICT (id) DO NOTHING;

INSERT INTO incident_events (incident_id, event_type, payload, created_at)
VALUES
    ('33333333-3333-3333-3333-333333333301', 'created', '{"severity": "warning"}'::jsonb, now() - interval '30 minutes'),
    ('33333333-3333-3333-3333-333333333301', 'analyzed', '{"root_cause": "redis maxmemory 2gb 不足"}'::jsonb, now() - interval '20 minutes')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 审计事件（对齐上述变更）
-- ============================================================
INSERT INTO audit_events (actor_id, actor_role, action, resource_type, resource_id, metadata, created_at)
VALUES
    ('Platform', 'operator', 'config.publish', 'config_item', 'redis-config',
     '{"version": 2, "reason": "提升缓存上限以缓解驱逐"}'::jsonb, now() - interval '15 minutes'),
    ('AI Infra', 'operator', 'deployment.finish', 'deployment', 'aibrix-gateway',
     '{"status": "success"}'::jsonb, now() - interval '1 day'),
    ('system', 'operator', 'incident.create', 'incident', '33333333-3333-3333-3333-333333333301',
     '{"severity": "warning", "title": "redis 缓存驱逐率升高导致 P95 抖动"}'::jsonb, now() - interval '30 minutes')
ON CONFLICT DO NOTHING;
