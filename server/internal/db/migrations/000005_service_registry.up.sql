-- Phase 5 / 5B.2：服务注册 + 心跳治理。
-- 为 service_instances 增加心跳时间戳；注册/心跳刷新它，后台 reaper 据 TTL 将
-- 超时未心跳的实例置为 unreachable。NULL（静态种子实例）不参与 reaper，保持原状态。
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
