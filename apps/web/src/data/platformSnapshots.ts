import type { ConfigItem, Deployment } from "../types/ops";
import type { ServiceInstance } from "../types/platform";

// 集中展示 snapshot（13-前端复刻改造计划 §5 数据层）。
// 后端暂缺/未运行时的展示数据集中在此，严禁散落进各页 JSX。
// 取数优先级：真实 API > 真实派生 > 本 snapshot > 空态。无后端时用 fallback 兜底，使控制台不空。

type SparkTone = "info" | "success" | "warning" | "danger";

export type DashboardServiceRow = {
  id: string;
  name: string;
  subtitle: string;
  status: "正常" | "降级" | "异常";
  qps: number;
  p95: number;
  errorRate: number;
  availability: number;
  tone: SparkTone;
  trend: number[];
};

export type DashboardDeploymentRow = {
  id: string;
  pipeline: string;
  version: string;
  env: string;
  status: "成功" | "失败" | "运行中";
  time: string;
};

export const dashboardSnapshot = {
  // 头部数字兜底（仅当真实接口缺失/无数据时使用；真实 0 仍显示 0）。
  fallback: {
    healthScore: 96,
    serviceCount: 12,
    healthyCount: 10,
    modelCount: 5,
    podCount: 24,
    incidentCount: 3,
    gpuUtil: 78,
    requestCount: 12442,
    qps: 20.7,
    errorRate: 0.0078,
    p95: 256,
    ttft: 64,
    throughput: 1840,
    deploySuccess: 98,
  },
  // KPI / 核心指标迷你趋势。
  trends: {
    health: [92, 93, 91, 94, 95, 96, 95, 96],
    services: [10, 11, 11, 12, 12, 12, 12, 12],
    models: [3, 3, 4, 4, 4, 5, 5, 5],
    gpu: [60, 64, 71, 68, 73, 77, 75, 78],
    incidents: [4, 3, 5, 4, 3, 2, 3, 3],
    deploySuccess: [94, 95, 96, 95, 97, 98, 98, 98],
    requests: [9800, 10200, 10800, 11200, 11000, 11800, 12100, 12442],
    qps: [16, 17, 18, 19, 18, 20, 21, 20.7],
    errorRate: [1.2, 0.9, 1.1, 0.8, 0.9, 0.7, 0.8, 0.78],
    p95: [240, 250, 268, 255, 262, 258, 251, 256],
    ttft: [58, 60, 66, 62, 64, 63, 61, 64],
    throughput: [1600, 1680, 1720, 1760, 1700, 1820, 1860, 1840],
  },
  // 主区"请求趋势"序列（近 24 点）。
  requestTrend: [
    120, 180, 240, 220, 300, 280, 360, 420, 390, 460, 510, 480, 540, 500, 560,
    600, 580, 620, 610, 660, 640, 700, 680, 720,
  ],
  resource: { cpu: 62, memory: 71, gpu: 78 },
  resources: [
    { id: "cpu", label: "CPU", value: 58, detail: "186 / 320 Core", tone: "info" },
    { id: "memory", label: "内存", value: 61, detail: "386 / 640 GiB", tone: "info" },
    { id: "storage", label: "存储", value: 47, detail: "2.35 / 5.00 TiB", tone: "info" },
    { id: "gpu", label: "GPU", value: 86, detail: "43 / 50", tone: "warning" },
    { id: "network", label: "网络 (出)", value: 32, detail: "4.6 / 15 Gbps", tone: "info" },
  ] as Array<{ id: string; label: string; value: number; detail: string; tone: SparkTone }>,
  alertBreakdown: [
    { id: "critical", label: "严重", count: 2, status: "未处理", tone: "danger" },
    { id: "major", label: "重要", count: 5, status: "未处理", tone: "warning" },
    { id: "minor", label: "次要", count: 17, status: "未处理", tone: "warning" },
    { id: "info", label: "提示", count: 32, status: "未处理", tone: "info" },
  ],
  alertTrend: {
    labels: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"],
    series: [
      { id: "critical", label: "严重", tone: "danger", values: [2, 3, 7, 4, 3, 5, 2] },
      { id: "major", label: "重要", tone: "warning", values: [7, 9, 18, 14, 10, 12, 8] },
      { id: "minor", label: "次要", tone: "warning", values: [18, 22, 34, 27, 20, 25, 18] },
      { id: "info", label: "提示", tone: "info", values: [24, 28, 56, 42, 31, 40, 26] },
    ] as Array<{ id: string; label: string; tone: SparkTone; values: number[] }>,
  },
  services: [
    {
      id: "api-gateway",
      name: "API 网关",
      subtitle: "aibrix-gateway",
      status: "正常",
      qps: 1245,
      p95: 120,
      errorRate: 0.0008,
      availability: 99.95,
      tone: "info",
      trend: [880, 940, 1160, 1090, 1280, 1190, 1245],
    },
    {
      id: "user-service",
      name: "用户服务",
      subtitle: "user-service",
      status: "正常",
      qps: 856,
      p95: 85,
      errorRate: 0.0005,
      availability: 99.98,
      tone: "info",
      trend: [680, 720, 760, 690, 820, 790, 856],
    },
    {
      id: "order-service",
      name: "订单服务",
      subtitle: "order-service",
      status: "降级",
      qps: 652,
      p95: 320,
      errorRate: 0.0132,
      availability: 99.0,
      tone: "warning",
      trend: [430, 460, 520, 610, 580, 690, 652],
    },
    {
      id: "payment-service",
      name: "支付服务",
      subtitle: "payment-service",
      status: "正常",
      qps: 423,
      p95: 210,
      errorRate: 0.0012,
      availability: 99.97,
      tone: "success",
      trend: [280, 310, 360, 340, 390, 410, 423],
    },
    {
      id: "reco-service",
      name: "推荐服务",
      subtitle: "reco-service",
      status: "异常",
      qps: 289,
      p95: 980,
      errorRate: 0.0521,
      availability: 96.2,
      tone: "danger",
      trend: [380, 350, 300, 340, 270, 310, 289],
    },
  ] as DashboardServiceRow[],
  deployments: [
    { id: "dep-order", pipeline: "order-service-pipeline", version: "v2.1.3", env: "Prod", status: "成功", time: "5 分钟前" },
    { id: "dep-user", pipeline: "user-service-pipeline", version: "v1.8.7", env: "Prod", status: "成功", time: "18 分钟前" },
    { id: "dep-reco", pipeline: "reco-service-pipeline", version: "v3.0.1", env: "Staging", status: "失败", time: "32 分钟前" },
  ] as DashboardDeploymentRow[],
  weeklyTrend: [
    { id: "requests", label: "请求量 (QPS)", value: "12,452", delta: "↑ 12.5%", tone: "info", values: [9800, 11200, 10400, 12100, 11800, 12600, 12452] },
    { id: "errors", label: "错误率", value: "0.78%", delta: "↓ 8.2%", tone: "success", values: [1.02, 0.91, 0.95, 0.83, 0.88, 0.81, 0.78] },
    { id: "latency", label: "P95 延迟", value: "256ms", delta: "↑ 18.3%", tone: "danger", values: [188, 201, 224, 218, 241, 232, 256] },
    { id: "gpu", label: "GPU 利用率", value: "86%", delta: "↑ 5.1%", tone: "danger", values: [70, 75, 82, 78, 84, 80, 86] },
  ] as Array<{ id: string; label: string; value: string; delta: string; tone: SparkTone; values: number[] }>,
  quickEntries: [
    { id: "services", title: "服务治理", description: "服务注册、发现与路由", page: "services" },
    { id: "config", title: "配置中心", description: "配置管理与版本控制", page: "config" },
    { id: "pipelines", title: "发布流水线", description: "CI/CD 自动化部署", page: "pipelines" },
    { id: "observability", title: "可观测性", description: "指标、日志、链路追踪", page: "observability" },
    { id: "aiOps", title: "AI Ops 分析", description: "智能告警与根因分析", page: "aiOps" },
    { id: "knowledge", title: "知识库 / RAG", description: "文档检索与问答", page: "knowledge" },
  ],
  knowledge: { documents: 1842, chunks: 28640, hitRate: 0.876, indexHealth: "healthy" },
  service: { healthy: 10, warning: 2, degraded: 0 },
  alerts: [
    { id: "a1", title: "Serving 延迟上升", meta: "P95 256ms · TTFT 64ms", status: "warning" },
    { id: "a2", title: "GPU 利用率偏高", meta: "峰值 78%", status: "warning" },
    { id: "a3", title: "redis 缓存驱逐率升高", meta: "evict +18%", status: "warning" },
  ],
  endpointTrends: [
    { name: "aibrix-gateway", value: "256 ms", tone: "info", values: [240, 252, 268, 255, 262, 258, 251, 256] },
    { name: "vllm-replica-0", value: "238 ms", tone: "success", values: [232, 236, 240, 235, 239, 234, 237, 238] },
    { name: "vllm-replica-1", value: "271 ms", tone: "warning", values: [255, 262, 278, 268, 274, 270, 266, 271] },
    { name: "auto-router", value: "249 ms", tone: "info", values: [244, 248, 256, 250, 252, 247, 245, 249] },
  ] as Array<{ name: string; value: string; tone: SparkTone; values: number[] }>,
};

export type ServiceConsoleRow = {
  id: string;
  name: string;
  runtime: string;
  model: string;
  status: "正常" | "降级" | "异常";
  replicas: string;
  qps: number;
  p95: number;
  errorRate: number;
  cpu: number;
  gpu: number;
  tone: SparkTone;
  trend: number[];
};

export const servicesSnapshot = {
  trends: {
    services: [10, 11, 11, 12, 12, 12, 12],
    healthy: [9, 10, 10, 10, 11, 10, 10],
    p95: [118, 124, 132, 126, 140, 136, 128],
    qps: [920, 980, 1080, 1140, 1220, 1180, 1245],
    errorRate: [0.12, 0.09, 0.1, 0.08, 0.11, 0.09, 0.08],
    gpu: [70, 72, 78, 74, 82, 80, 86],
  },
  rows: [
    {
      id: "aibrix-gateway",
      name: "aibrix-gateway",
      runtime: "AIBrix Gateway",
      model: "qwen3-4b-platform",
      status: "正常",
      replicas: "2/2",
      qps: 1245,
      p95: 120,
      errorRate: 0.0008,
      cpu: 58,
      gpu: 0,
      tone: "info",
      trend: [880, 940, 1160, 1090, 1280, 1190, 1245],
    },
    {
      id: "vllm-replica-0",
      name: "vllm-replica-0",
      runtime: "vLLM",
      model: "qwen3-4b-platform",
      status: "正常",
      replicas: "1/1",
      qps: 642,
      p95: 118,
      errorRate: 0.0006,
      cpu: 64,
      gpu: 81,
      tone: "success",
      trend: [420, 470, 560, 510, 640, 600, 642],
    },
    {
      id: "vllm-replica-1",
      name: "vllm-replica-1",
      runtime: "vLLM",
      model: "qwen3-4b-platform",
      status: "降级",
      replicas: "1/1",
      qps: 603,
      p95: 185,
      errorRate: 0.0014,
      cpu: 71,
      gpu: 86,
      tone: "warning",
      trend: [440, 500, 560, 610, 590, 640, 603],
    },
    {
      id: "embedding-service",
      name: "embedding-service",
      runtime: "Triton",
      model: "bge-m3",
      status: "正常",
      replicas: "3/3",
      qps: 318,
      p95: 42,
      errorRate: 0.0003,
      cpu: 44,
      gpu: 35,
      tone: "info",
      trend: [220, 240, 290, 280, 310, 304, 318],
    },
    {
      id: "rerank-service",
      name: "rerank-service",
      runtime: "ONNX Runtime",
      model: "bge-reranker",
      status: "正常",
      replicas: "2/2",
      qps: 186,
      p95: 63,
      errorRate: 0.0004,
      cpu: 39,
      gpu: 22,
      tone: "info",
      trend: [150, 162, 172, 168, 180, 176, 186],
    },
  ] as ServiceConsoleRow[],
  topology: [
    { id: "gateway", label: "AI Gateway", x: 12, y: 48, tone: "info" },
    { id: "router", label: "AIBrix Router", x: 36, y: 48, tone: "info" },
    { id: "vllm0", label: "vLLM-0", x: 66, y: 30, tone: "success" },
    { id: "vllm1", label: "vLLM-1", x: 66, y: 66, tone: "warning" },
    { id: "cache", label: "Redis Cache", x: 90, y: 48, tone: "warning" },
  ],
  sloCards: [
    { id: "latency", label: "P95 延迟", value: "128ms", target: "< 200ms", status: "通过", tone: "success" },
    { id: "ttft", label: "TTFT P95", value: "64ms", target: "< 80ms", status: "通过", tone: "success" },
    { id: "availability", label: "可用性", value: "99.95%", target: "> 99.9%", status: "通过", tone: "success" },
    { id: "error", label: "错误率", value: "0.08%", target: "< 0.1%", status: "观察", tone: "warning" },
  ] as Array<{ id: string; label: string; value: string; target: string; status: string; tone: SparkTone }>,
  runtimeMix: [
    { label: "vLLM", value: 44, tone: "info" },
    { label: "AIBrix", value: 22, tone: "success" },
    { label: "Triton", value: 19, tone: "warning" },
    { label: "ONNX", value: 15, tone: "danger" },
  ] as Array<{ label: string; value: number; tone: SparkTone }>,
};

export type KubernetesWorkloadRow = {
  id: string;
  name: string;
  kind: string;
  namespace: string;
  replicas: string;
  desired: number;
  availability: number;
  status: "正常" | "异常" | "警告";
};

export type ConfigConsoleRow = {
  id: string;
  name: string;
  key: string;
  namespace: string;
  env: string;
  type: string;
  version: string;
  updatedAt: string;
  owner: string;
  status: string;
  versionCount: number;
  trend: number[];
  source: ConfigItem;
};

function configSource(
  id: string,
  env: string,
  namespace: string,
  configKey: string,
  configType: string,
  activeVersion: number,
  owner: string,
  updatedAt: string,
  versionCount: number,
): ConfigItem {
  return {
    id,
    env,
    namespace,
    config_key: configKey,
    config_type: configType,
    active_version: activeVersion,
    status: "enabled",
    created_by: owner,
    updated_at: updatedAt,
    version_count: versionCount,
  };
}

export const configSnapshot = {
  total: 128,
  process: [
    { title: "发现问题", detail: "配置风险" },
    { title: "定位对象", detail: "配置项" },
    { title: "分析原因", detail: "变更影响" },
    { title: "推荐动作", detail: "变更/回滚" },
    { title: "执行修复", detail: "发布配置" },
    { title: "验证恢复", detail: "配置生效" },
  ],
  trends: {
    configs: [116, 118, 120, 123, 124, 126, 128],
    namespaces: [7, 7, 8, 8, 8, 8, 8],
    envs: [3, 3, 3, 3, 3, 3, 3],
    versions: [82, 86, 89, 91, 93, 95, 96],
    changes: [12, 14, 18, 16, 15, 13, 15],
    compliance: [97.2, 97.6, 98.1, 98.0, 98.3, 98.4, 98.6],
  },
  kpis: [
    { id: "configs", label: "配置项总数", value: "128", detail: "已托管", trend: [116, 118, 120, 123, 124, 126, 128] },
    { id: "namespaces", label: "命名空间", value: "8", detail: "prod / staging / dev...", trend: [7, 7, 8, 8, 8, 8, 8] },
    { id: "envs", label: "环境", value: "3", detail: "prod / staging / dev", trend: [3, 3, 3, 3, 3, 3, 3] },
    { id: "versions", label: "活跃版本", value: "96", detail: "当前生效", trend: [82, 86, 89, 91, 93, 95, 96], tone: "success" },
    { id: "changes", label: "变更请求", value: "15", detail: "待审批 3", trend: [12, 14, 18, 16, 15, 13, 15], tone: "warning" },
    { id: "compliance", label: "合规检查", value: "98.6%", detail: "通过率", trend: [97.2, 97.6, 98.1, 98.0, 98.3, 98.4, 98.6], tone: "success" },
  ] as Array<{ id: string; label: string; value: string; detail: string; trend: number[]; tone?: "success" | "warning" | "danger" | "ai" }>,
  rows: [
    {
      id: "redis-config",
      name: "redis-config",
      key: "redis.cache.config",
      namespace: "default",
      env: "prod",
      type: "ConfigMap",
      version: "v4",
      updatedAt: "2026-05-31 09:12:45",
      owner: "admin",
      status: "生效",
      versionCount: 4,
      trend: [3, 3, 4, 4, 4, 4, 4],
      source: configSource("redis-config", "prod", "default", "redis-config", "ConfigMap", 4, "admin", "2026-05-31T09:12:45+08:00", 4),
    },
    {
      id: "aibrix-gateway-yaml",
      name: "aibrix-gateway.yaml",
      key: "gateway.config",
      namespace: "aibrix-system",
      env: "prod",
      type: "YAML",
      version: "v3",
      updatedAt: "2026-05-31 08:54:21",
      owner: "platform-bot",
      status: "生效",
      versionCount: 3,
      trend: [1, 2, 2, 3, 3, 3, 3],
      source: configSource("aibrix-gateway-yaml", "prod", "aibrix-system", "aibrix-gateway.yaml", "yaml", 3, "platform-bot", "2026-05-31T08:54:21+08:00", 3),
    },
    {
      id: "llm-chat-service-yaml",
      name: "llm-chat-service.yaml",
      key: "services.llm-chat",
      namespace: "default",
      env: "prod",
      type: "YAML",
      version: "v7",
      updatedAt: "2026-05-31 08:40:11",
      owner: "ci-bot",
      status: "生效",
      versionCount: 7,
      trend: [4, 5, 5, 6, 6, 7, 7],
      source: configSource("llm-chat-service-yaml", "prod", "default", "llm-chat-service.yaml", "yaml", 7, "ci-bot", "2026-05-31T08:40:11+08:00", 7),
    },
    {
      id: "vllm-runtime-yaml",
      name: "vllm-runtime.yaml",
      key: "runtime.vllm",
      namespace: "ai-infra",
      env: "prod",
      type: "YAML",
      version: "v5",
      updatedAt: "2026-05-31 07:25:36",
      owner: "alice",
      status: "生效",
      versionCount: 5,
      trend: [2, 3, 4, 4, 5, 5, 5],
      source: configSource("vllm-runtime-yaml", "prod", "ai-infra", "vllm-runtime.yaml", "yaml", 5, "alice", "2026-05-31T07:25:36+08:00", 5),
    },
    {
      id: "prometheus-yaml",
      name: "prometheus.yaml",
      key: "monitoring.prometheus",
      namespace: "observability",
      env: "staging",
      type: "YAML",
      version: "v2",
      updatedAt: "2026-05-30 22:11:09",
      owner: "monitor-bot",
      status: "生效",
      versionCount: 2,
      trend: [1, 1, 2, 2, 2, 2, 2],
      source: configSource("prometheus-yaml", "staging", "observability", "prometheus.yaml", "yaml", 2, "monitor-bot", "2026-05-30T22:11:09+08:00", 2),
    },
    {
      id: "feature-flags-yaml",
      name: "feature-flags.yaml",
      key: "feature.flags",
      namespace: "default",
      env: "dev",
      type: "YAML",
      version: "v12",
      updatedAt: "2026-05-30 18:33:05",
      owner: "bob",
      status: "生效",
      versionCount: 12,
      trend: [8, 9, 10, 10, 11, 12, 12],
      source: configSource("feature-flags-yaml", "dev", "default", "feature-flags.yaml", "yaml", 12, "bob", "2026-05-30T18:33:05+08:00", 12),
    },
    {
      id: "db-config-properties",
      name: "db-config.properties",
      key: "database.config",
      namespace: "default",
      env: "prod",
      type: "Properties",
      version: "v6",
      updatedAt: "2026-05-30 16:20:18",
      owner: "admin",
      status: "生效",
      versionCount: 6,
      trend: [4, 5, 5, 6, 6, 6, 6],
      source: configSource("db-config-properties", "prod", "default", "db-config.properties", "properties", 6, "admin", "2026-05-30T16:20:18+08:00", 6),
    },
    {
      id: "vector-store-yaml",
      name: "vector-store.yaml",
      key: "vector.store.config",
      namespace: "ai-data",
      env: "prod",
      type: "YAML",
      version: "v3",
      updatedAt: "2026-05-30 15:09:42",
      owner: "alice",
      status: "生效",
      versionCount: 3,
      trend: [1, 2, 2, 3, 3, 3, 3],
      source: configSource("vector-store-yaml", "prod", "ai-data", "vector-store.yaml", "yaml", 3, "alice", "2026-05-30T15:09:42+08:00", 3),
    },
  ] as ConfigConsoleRow[],
  recentChanges: [
    { id: "chg-1", title: "发布 redis-config v4", target: "default / prod", time: "5 分钟前" },
    { id: "chg-2", title: "更新 aibrix-gateway.yaml", target: "aibrix-system / prod", time: "38 分钟前" },
    { id: "chg-3", title: "创建 feature-flags.yaml v12", target: "default / dev", time: "2 小时前" },
    { id: "chg-4", title: "回滚 db-config.properties", target: "default / prod", time: "昨天 18:20" },
  ],
  policies: [
    { name: "敏感字段扫描", detail: "检测 secret/token/password 关键字", status: "通过" },
    { name: "生产双人审批", detail: "prod 变更需要审批链路", status: "启用" },
    { name: "回滚点保留", detail: "至少保留最近 5 个版本", status: "通过" },
  ],
};

export type PipelineConsoleRow = {
  id: string;
  name: string;
  service: string;
  env: string;
  version: string;
  commit: string;
  status: string;
  stage: string;
  stageMeta: string;
  trigger: string;
  startedAt: string;
  duration: string;
  tone: SparkTone | "neutral";
  source: Deployment;
};

function deploymentSource(
  id: string,
  name: string,
  version: string,
  env: string,
  status: string,
  startedAt: string,
  image: string,
  branch: string,
  gate: string,
  owner: string,
): Deployment {
  return {
    id,
    name,
    version,
    env,
    status,
    started_at: startedAt,
    finished_at: status === "running" ? null : startedAt,
    metadata: { image, branch, gate, owner },
  };
}

export const pipelineSnapshot = {
  total: 18,
  process: [
    { title: "发现问题", detail: "告警触发" },
    { title: "定位对象", detail: "受影响服务" },
    { title: "分析原因", detail: "根因分析" },
    { title: "推荐动作", detail: "修复方案" },
    { title: "执行修复", detail: "发布 / 部署" },
    { title: "验证恢复", detail: "验证效果" },
  ],
  trends: {
    pipelines: [12, 13, 14, 15, 16, 18, 18],
    builds: [16, 18, 20, 19, 22, 24, 24],
    deploys: [8, 9, 10, 11, 10, 12, 12],
    success: [94.0, 96.0, 97.0, 91.0, 99.0, 98.0, 98.6],
    duration: [10.2, 9.4, 8.9, 9.0, 8.2, 8.6, 8.7],
    rollback: [1, 1, 2, 2, 3, 2, 3],
  },
  kpis: [
    { id: "pipelines", label: "流水线总数", value: "18", detail: "活跃 6", trend: [12, 13, 14, 15, 16, 18, 18] },
    { id: "builds", label: "构建次数（今日）", value: "24", detail: "88% 成功", trend: [16, 18, 20, 19, 22, 24, 24], tone: "success" },
    { id: "deploys", label: "部署次数（今日）", value: "12", detail: "92% 成功", trend: [8, 9, 10, 11, 10, 12, 12], tone: "success" },
    { id: "success", label: "变更成功率", value: "98.6%", detail: "近 7 天", trend: [94.0, 96.0, 97.0, 91.0, 99.0, 98.0, 98.6], tone: "success" },
    { id: "duration", label: "平均部署时长", value: "8m 42s", detail: "-18% (较昨日)", trend: [10.2, 9.4, 8.9, 9.0, 8.2, 8.6, 8.7], tone: "success" },
    { id: "rollback", label: "回滚次数（7天）", value: "3", detail: "需要关注", trend: [1, 1, 2, 2, 3, 2, 3], tone: "warning" },
  ] as Array<{ id: string; label: string; value: string; detail: string; trend: number[]; tone?: "success" | "warning" | "danger" | "ai" }>,
  rows: [
    {
      id: "pipe-chat",
      name: "llm-chat-service 发布",
      service: "llm-chat-service",
      env: "prod",
      version: "v1.3.2",
      commit: "8f3c2d1",
      status: "成功",
      stage: "已完成",
      stageMeta: "Deployed",
      trigger: "alice",
      startedAt: "10:28:16",
      duration: "12m 34s",
      tone: "success",
      source: deploymentSource("pipe-chat", "llm-chat-service", "v1.3.2", "prod", "success", "2026-05-31T10:28:16+08:00", "registry/llm-chat:v1.3.2", "main", "approved", "alice"),
    },
    {
      id: "pipe-vllm",
      name: "vLLM-replica 扩容发布",
      service: "vllm-replica",
      env: "prod",
      version: "v1.2.8",
      commit: "c9a7b2d",
      status: "运行中",
      stage: "部署中 (3/6)",
      stageMeta: "Rolling Update 60%",
      trigger: "bob",
      startedAt: "10:35:02",
      duration: "6m 21s",
      tone: "warning",
      source: deploymentSource("pipe-vllm", "vllm-replica", "v1.2.8", "prod", "running", "2026-05-31T10:35:02+08:00", "registry/vllm:v1.2.8", "release", "approved", "bob"),
    },
    {
      id: "pipe-redis",
      name: "redis-config 配置更新",
      service: "redis-config",
      env: "prod",
      version: "v4.1.0",
      commit: "1a2b3c4",
      status: "成功",
      stage: "已完成",
      stageMeta: "Deployed",
      trigger: "system",
      startedAt: "09:45:18",
      duration: "3m 18s",
      tone: "success",
      source: deploymentSource("pipe-redis", "redis-config", "v4.1.0", "prod", "success", "2026-05-31T09:45:18+08:00", "config/redis:v4.1.0", "main", "auto", "system"),
    },
    {
      id: "pipe-router",
      name: "auto-router 发布",
      service: "auto-router",
      env: "prod",
      version: "v0.9.0",
      commit: "3d4e5f6",
      status: "失败",
      stage: "测试失败 (5/6)",
      stageMeta: "单元测试失败",
      trigger: "charlie",
      startedAt: "09:30:11",
      duration: "9m 12s",
      tone: "danger",
      source: deploymentSource("pipe-router", "auto-router", "v0.9.0", "prod", "failed", "2026-05-31T09:30:11+08:00", "registry/router:v0.9.0", "main", "failed", "charlie"),
    },
    {
      id: "pipe-vector",
      name: "vector-store 发布",
      service: "vector-store",
      env: "staging",
      version: "v1.1.0",
      commit: "7e8f9a0",
      status: "已取消",
      stage: "已取消",
      stageMeta: "Canceled",
      trigger: "david",
      startedAt: "昨天 18:05",
      duration: "2m 03s",
      tone: "neutral",
      source: deploymentSource("pipe-vector", "vector-store", "v1.1.0", "staging", "cancelled", "2026-05-30T18:05:00+08:00", "registry/vector:v1.1.0", "staging", "manual", "david"),
    },
  ] as PipelineConsoleRow[],
  envDistribution: [
    { label: "prod", value: 10, percent: "55.6%", tone: "info" },
    { label: "staging", value: 6, percent: "33.3%", tone: "warning" },
    { label: "dev", value: 2, percent: "11.1%", tone: "success" },
  ] as Array<{ label: string; value: number; percent: string; tone: SparkTone }>,
  releaseTrend: [94, 96, 97, 91, 99, 98, 98.6],
  detailStages: [
    { label: "代码提交", detail: "8f3c2d1", state: "done" },
    { label: "构建镜像", detail: "12s", state: "done" },
    { label: "单元测试", detail: "45s", state: "done" },
    { label: "安全扫描", detail: "36s", state: "done" },
    { label: "集成测试", detail: "1m 12s", state: "done" },
    { label: "部署中", detail: "Rolling Update 60%", state: "active" },
    { label: "健康检查", detail: "等待中", state: "pending" },
    { label: "完成", detail: "等待中", state: "pending" },
  ],
  logs: [
    "10:35:02  开始部署 v1.3.2 到 prod 环境",
    "10:35:05  镜像拉取与校验通过",
    "10:35:08  更新 Deployment/llm-chat-service",
    "10:35:30  Rolling Update: 3/5 Pods 已更新 (60%)",
    "10:35:32  新 Pod 通过就绪检查: llm-chat-service-7d8f9c6bb8-2xk5m",
    "10:35:35  流量切换中...",
  ],
  deployDetails: [
    { resource: "Deployment", name: "llm-chat-service", status: "Rolling Update 60%", version: "v1.3.2", replicas: "3/5", updatedAt: "10:35:30" },
    { resource: "ReplicaSet", name: "llm-chat-service-7d8f9c6bb8", status: "New", version: "v1.3.2", replicas: "3/5", updatedAt: "10:35:30" },
    { resource: "Pod", name: "llm-chat-service-7d8f9c6bb8-2xk5m", status: "Running", version: "v1.3.2", replicas: "1/1", updatedAt: "10:35:25" },
  ],
};

export type BenchmarkTaskRow = {
  id: string;
  name: string;
  service: string;
  version: string;
  scenario: string;
  concurrency: string;
  p95: string;
  ttft: string;
  throughput: string;
  errorRate: string;
  status: string;
  startedAt: string;
  tone: SparkTone;
};

export const benchmarkSnapshot = {
  process: [
    { title: "发现问题", detail: "性能异常" },
    { title: "定位对象", detail: "服务/版本" },
    { title: "分析原因", detail: "性能瓶颈" },
    { title: "推荐动作", detail: "优化建议" },
    { title: "执行修复", detail: "配置/发布" },
    { title: "验证恢复", detail: "Benchmark" },
  ],
  trends: {
    tasks: [14, 16, 18, 20, 21, 23, 24],
    passRate: [91, 92, 93, 94, 95, 94, 95.8],
    p95: [312, 300, 286, 275, 270, 264, 256],
    ttft: [238, 224, 218, 202, 198, 190, 186],
    throughput: [1900, 2040, 2180, 2240, 2320, 2380, 2450],
    errorRate: [0.84, 0.92, 1.1, 1.4, 1.2, 1.46, 1.32],
  },
  kpis: [
    { id: "tasks", label: "压测任务数", value: "24", detail: "近 7 天", trend: [14, 16, 18, 20, 21, 23, 24] },
    { id: "passRate", label: "通过率", value: "95.8%", detail: "23/24 通过", trend: [91, 92, 93, 94, 95, 94, 95.8], tone: "success" },
    { id: "p95", label: "P95 延迟", value: "256ms", detail: "-18% (对比基线)", trend: [312, 300, 286, 275, 270, 264, 256], tone: "success" },
    { id: "ttft", label: "TTFT", value: "186ms", detail: "-22% (对比基线)", trend: [238, 224, 218, 202, 198, 190, 186], tone: "success" },
    { id: "throughput", label: "吞吐量 (tokens/s)", value: "2,450", detail: "+12% (对比基线)", trend: [1900, 2040, 2180, 2240, 2320, 2380, 2450], tone: "success" },
    { id: "errorRate", label: "错误率", value: "1.32%", detail: "+0.48% (对比基线)", trend: [0.84, 0.92, 1.1, 1.4, 1.2, 1.46, 1.32], tone: "danger" },
  ] as Array<{ id: string; label: string; value: string; detail: string; trend: number[]; tone?: "success" | "warning" | "danger" | "ai" }>,
  rows: [
    { id: "bench-1", name: "llm-chat-service 基准压测", service: "llm-chat-service", version: "v1.3.2 (基线)", scenario: "混合读写", concurrency: "500 并发", p95: "312ms", ttft: "232ms", throughput: "2,180", errorRate: "0.68%", status: "通过", startedAt: "05-31 09:45", tone: "success" },
    { id: "bench-2", name: "llm-chat-service 回归测试", service: "llm-chat-service", version: "v1.3.3 (RC)", scenario: "混合读写", concurrency: "500 并发", p95: "256ms", ttft: "186ms", throughput: "2,450", errorRate: "1.32%", status: "通过", startedAt: "05-31 10:15", tone: "success" },
    { id: "bench-3", name: "vLLM-replica 性能压测", service: "vllm-replica", version: "v1.2.8", scenario: "长文本生成", concurrency: "300 并发", p95: "842ms", ttft: "512ms", throughput: "1,120", errorRate: "2.15%", status: "警告", startedAt: "05-31 08:20", tone: "warning" },
    { id: "bench-4", name: "redis-cache 压力测试", service: "redis-cache", version: "v4.1.0", scenario: "缓存读写", concurrency: "1000 并发", p95: "85ms", ttft: "-", throughput: "15,680", errorRate: "0.32%", status: "通过", startedAt: "05-30 18:05", tone: "success" },
  ] as BenchmarkTaskRow[],
  baseline: [
    { label: "P95 延迟 (ms)", values: [512, 566, 520, 502, 442, 392, 368, 344], current: [250, 272, 236, 220, 246, 204, 218, 198], delta: "↓ 56ms (-18.0%)", tone: "success" },
    { label: "TTFT (ms)", values: [322, 356, 308, 320, 348, 312, 286, 268], current: [124, 132, 118, 126, 140, 128, 135, 126], delta: "↓ 46ms (-22.1%)", tone: "success" },
    { label: "吞吐量 (tokens/s)", values: [1600, 2100, 2320, 1860, 2240, 2420, 3020, 2860], current: [1480, 1660, 1780, 1540, 1680, 1600, 1820, 1980], delta: "↑ 270 (+12.4%)", tone: "danger" },
    { label: "错误率 (%)", values: [1.1, 1.2, 1.8, 2.1, 1.6, 1.4, 1.6, 1.8], current: [0.54, 0.48, 0.62, 0.52, 0.58, 0.46, 0.50, 0.44], delta: "↑ 0.64% (+0.48%)", tone: "danger" },
  ] as Array<{ label: string; values: number[]; current: number[]; delta: string; tone: SparkTone }>,
  gateRows: [
    { metric: "P95 延迟", threshold: "≤ 300ms", current: "256ms", result: "通过" },
    { metric: "TTFT", threshold: "≤ 200ms", current: "186ms", result: "通过" },
    { metric: "错误率", threshold: "≤ 2.00%", current: "1.32%", result: "通过" },
    { metric: "吞吐量", threshold: "≥ 2,000", current: "2,450", result: "通过" },
  ],
};

export type ModelRegistryRow = {
  id: string;
  name: string;
  description: string;
  type: string;
  version: string;
  status: string;
  env: string;
  quality: number | null;
  instances: number;
  updatedAt: string;
  source?: ServiceInstance;
};

export const modelsSnapshot = {
  process: [
    { title: "发现问题", detail: "模型异常" },
    { title: "定位对象", detail: "模型/版本" },
    { title: "分析原因", detail: "性能/质量" },
    { title: "推荐动作", detail: "模型优化" },
    { title: "执行修复", detail: "发布/切换" },
    { title: "验证恢复", detail: "验证效果" },
  ],
  trends: {
    total: [23, 24, 25, 26, 27, 28, 28],
    versions: [35, 36, 38, 39, 40, 42, 42],
    instances: [120, 132, 140, 148, 152, 156, 156],
    types: [7, 8, 8, 9, 9, 9, 9],
    compliance: [93.2, 94.0, 95.1, 95.8, 96.0, 96.2, 96.4],
  },
  kpis: [
    { id: "total", label: "模型总数", value: "28", detail: "已注册模型", trend: [23, 24, 25, 26, 27, 28, 28] },
    { id: "versions", label: "活跃版本", value: "42", detail: "生产环境运行中", trend: [35, 36, 38, 39, 40, 42, 42] },
    { id: "instances", label: "运行实例", value: "156", detail: "绑定实例总数", trend: [120, 132, 140, 148, 152, 156, 156] },
    { id: "types", label: "模型类型", value: "9", detail: "文本/视觉/多模态", trend: [7, 8, 8, 9, 9, 9, 9] },
    { id: "compliance", label: "合规检查", value: "96.4%", detail: "通过率", trend: [93.2, 94.0, 95.1, 95.8, 96.0, 96.2, 96.4], tone: "success" },
  ] as Array<{ id: string; label: string; value: string; detail: string; trend: number[]; tone?: "success" | "warning" | "danger" | "ai" }>,
  rows: [
    { id: "llm-chat-service", name: "llm-chat-service", description: "通用对话大模型", type: "LLM", version: "v1.3.3", status: "运行中", env: "prod", quality: 92.1, instances: 32, updatedAt: "2026-05-31 10:20" },
    { id: "vllm-replica", name: "vllm-replica", description: "vLLM 推理服务模型", type: "LLM", version: "v1.2.8", status: "运行中", env: "prod", quality: 94.3, instances: 64, updatedAt: "2026-05-31 09:58" },
    { id: "embedding-model", name: "embedding-model", description: "文本向量嵌入模型", type: "Embedding", version: "v2.1.0", status: "运行中", env: "prod", quality: 89.7, instances: 18, updatedAt: "2026-05-31 09:37" },
    { id: "vision-understanding", name: "vision-understanding", description: "视觉理解模型", type: "Vision", version: "v1.0.5", status: "测试中", env: "staging", quality: 86.5, instances: 8, updatedAt: "2026-05-31 08:42" },
    { id: "rerank-model", name: "rerank-model", description: "结果重排序模型", type: "Rerank", version: "v1.1.2", status: "运行中", env: "prod", quality: 91.0, instances: 24, updatedAt: "2026-05-31 08:20" },
    { id: "tts-speech", name: "tts-speech", description: "语音合成模型", type: "TTS", version: "v0.9.1", status: "未发布", env: "dev", quality: 78.3, instances: 0, updatedAt: "2026-05-30 23:15" },
    { id: "multimodal-llm", name: "multimodal-llm", description: "多模态大模型", type: "Multimodal", version: "v0.4.0", status: "评估中", env: "dev", quality: null, instances: 0, updatedAt: "2026-05-30 21:44" },
    { id: "safety-classifier", name: "safety-classifier", description: "内容安全分类器", type: "Classifier", version: "v1.2.1", status: "运行中", env: "prod", quality: 95.4, instances: 12, updatedAt: "2026-05-30 20:11" },
  ] as ModelRegistryRow[],
};

type KpiSnap = { id: string; label: string; value: string; detail: string; trend: number[]; tone?: "success" | "warning" | "danger" | "ai" };

// ===== 知识库 / RAG（对齐 image copy 9.png）=====

// ===== 平台设置（对齐 image copy 10.png）=====