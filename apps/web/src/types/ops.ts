// Phase 2 运维域类型：配置中心 / 发布流水线 / 审计 / 故障事件。
// 对齐 Java 控制面契约（/api/config、/api/deployments、/api/audit、/api/incidents）。

export type ConfigItem = {
  id: string;
  env: string;
  namespace: string | null;
  config_key: string;
  config_type: string;
  active_version: number;
  status: string;
  created_by: string | null;
  updated_at: string | null;
  version_count: number;
};

export type ConfigVersion = {
  version: number;
  content: string | null;
  change_reason: string | null;
  operator: string | null;
  status: string;
  created_at: string;
};

export type ConfigVersionsResponse = {
  active_version: number;
  versions: ConfigVersion[];
};

export type DeploymentMeta = {
  image?: string;
  branch?: string;
  gate?: string;
  owner?: string;
  rollback_of?: string;
};

export type Deployment = {
  id: string;
  name: string;
  version: string | null;
  env: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  metadata: DeploymentMeta;
};

export type AuditEvent = {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Incident = {
  id: string;
  title: string;
  severity: string;
  status: string;
  summary: string | null;
  created_at: string;
  resolved_at: string | null;
};
