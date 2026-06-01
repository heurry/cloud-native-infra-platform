import type { ServiceInstance, Metrics } from "../types/platform";
import type { EventListItem, KeyValueItem, StrategyCardItem } from "../types/ui";

export const PLATFORM_MODEL_ID = "qwen3-4b-platform";
export const PLATFORM_MODEL_VERSION = "2026.05-prod";
export const PLATFORM_ROLLBACK_VERSION = "2026.04";

export function normalizeModelId(modelId: string | null | undefined) {
  return String(modelId || PLATFORM_MODEL_ID).replace(/qwen3-4b-customer/g, PLATFORM_MODEL_ID);
}

export function normalizeServiceInstance(instance: ServiceInstance): ServiceInstance {
  return {
    ...instance,
    model_id: normalizeModelId(instance.model_id)
  };
}

export const mockServiceInstances: ServiceInstance[] = [
  { name: "auto-router", base_url: "http://127.0.0.1:8088/api/proxy/auto-router/v1", model_id: PLATFORM_MODEL_ID, kind: "auto_router", gpu_id: "auto", routing_role: "auto_router", status: "healthy" },
  { name: "aibrix-gateway", base_url: "http://127.0.0.1:8010/v1", model_id: PLATFORM_MODEL_ID, kind: "aibrix", gpu_id: "gateway", routing_role: "gateway", status: "healthy" },
  { name: "vllm-replica-0", base_url: "http://127.0.0.1:8000/v1", model_id: PLATFORM_MODEL_ID, kind: "vllm", gpu_id: "0", routing_role: "replica", status: "healthy" },
  { name: "vllm-replica-1", base_url: "http://127.0.0.1:8001/v1", model_id: PLATFORM_MODEL_ID, kind: "vllm", gpu_id: "1", routing_role: "replica", status: "warning" }
];

export const overviewAlerts: EventListItem[] = [
  { id: "latency", title: "服务延迟升高", status: "Warning", meta: "payment-service", time: "2 分钟前" },
  { id: "gpu", title: "GPU 显存压力", status: "Warning", meta: "vllm-replica-1", time: "6 分钟前" },
  { id: "config", title: "配置漂移已发现", status: "Critical", meta: "redis-config", time: "10 分钟前" }
];

export const overviewDeployments: EventListItem[] = [
  { id: "payment-service", title: "payment-service", status: "Success", meta: "生产环境", time: "5 分钟前" },
  { id: "qwen3-4b", title: "qwen3-4b", status: "Warning", meta: "Canary", time: "18 分钟前" },
  { id: "rag-index", title: "rag-index", status: "Success", meta: "预发环境", time: "1 小时前" }
];

export const storageLayers: KeyValueItem[] = [
  { id: "postgresql", label: "PostgreSQL", value: "目标元数据存储", status: "Planned" },
  { id: "redis", label: "Redis", value: "路由缓存 / 限流状态", status: "Planned" },
  { id: "vector-store", label: "Vector Store", value: "RAG 检索索引", status: "Ready" },
  { id: "model-pvc", label: "Model PVC", value: "Qwen 服务模型制品", status: "Ready" }
];

export const serviceLifecycleRows: KeyValueItem[] = [
  { id: "model", label: "模型", value: PLATFORM_MODEL_ID },
  { id: "version", label: "版本", value: PLATFORM_MODEL_VERSION },
  { id: "runtime", label: "运行时", value: "vLLM OpenAI Server" },
  { id: "engine", label: "服务引擎", value: "AIBrix Gateway" },
  { id: "deployment", label: "部署模式", value: "稳定版 + Canary" },
  { id: "canary", label: "Canary", value: "10% 流量" },
  { id: "rollout", label: "发布状态", value: "进行中" },
  { id: "slo", label: "SLO 策略", value: "P95 < 200ms / TTFT < 80ms" }
];

export const routerGovernancePolicies: StrategyCardItem[] = [
  { id: "primary", label: "主策略", value: "least-request", description: "按活跃请求压力进行均衡。" },
  { id: "fallback", label: "兜底策略", value: "direct round-robin", description: "网关路由健康下降时绕过 AIBrix。" },
  { id: "canary", label: "Canary 比例", value: "10%", description: "限制候选模型暴露面。" },
  { id: "traffic", label: "流量分配", value: "90 / 10", description: `稳定版 ${PLATFORM_MODEL_ID} 与候选版本分流。` },
  { id: "prefix-cache", label: "Prefix Cache", value: "enabled", description: "优先复用共享 Prompt 工作负载。" },
  { id: "retry", label: "重试策略", value: "2 attempts", description: "仅对幂等 Chat Completions 生效。" },
  { id: "timeout", label: "超时策略", value: "30s total / 2s TTFT", description: "保护客户端尾延迟。" },
  { id: "breaker", label: "熔断策略", value: "5% error / 60s", description: "错误预算快速燃烧时打开熔断。" },
  { id: "rate-limit", label: "限流", value: "120 RPM / tenant", description: "保护 GPU 与路由队列。" },
  { id: "shedding", label: "降载", value: "queue > 32", description: "优先拒绝低优先级请求。" }
];

export type WorkloadRow = {
  name: string;
  namespace: string;
  desired: string;
  ready: string;
  available: string;
  restarts: string;
  resources: string;
  hpa: string;
  image: string;
  lastDeploy: string;
  owner: string;
  sloImpact: string;
};

export const mockKubernetesPods: Metrics["kubernetes"]["pods"] = [
  { namespace: "default", name: "aibrix-gateway-6f7d9c8b6c-gw01", phase: "Running", ready: "1/1", restarts: 0, pod_ip: "10.244.0.21", node: "gpu-node-a", component: "gateway" },
  { namespace: "default", name: `${PLATFORM_MODEL_ID}-vllm-0`, phase: "Running", ready: "1/1", restarts: 1, pod_ip: "10.244.0.22", node: "gpu-node-a", component: "vllm" },
  { namespace: "default", name: `${PLATFORM_MODEL_ID}-vllm-1`, phase: "Running", ready: "1/1", restarts: 3, pod_ip: "10.244.0.23", node: "gpu-node-b", component: "vllm" },
  { namespace: "aibrix-system", name: "metadata-service-7c8f9d54bb-md01", phase: "Running", ready: "1/1", restarts: 0, pod_ip: "10.244.0.31", node: "cpu-node-a", component: "metadata" },
  { namespace: "observability", name: "prometheus-server-0", phase: "Running", ready: "2/2", restarts: 0, pod_ip: "10.244.0.41", node: "cpu-node-b", component: "metrics" }
];

export const clusterOverviewItems: KeyValueItem[] = [
  { id: "cluster", label: "集群", value: "minikube-gpu", detail: "prod / us-east-1" },
  { id: "namespace", label: "命名空间", value: "default", detail: "模型服务范围" },
  { id: "node-pool", label: "节点池", value: "gpu-pool-a", detail: "2 个 GPU 节点 / 14 个 CPU 节点" },
  { id: "runtime", label: "容器运行时", value: "containerd", detail: "NVIDIA device plugin" },
  { id: "kubernetes-version", label: "Kubernetes 版本", value: "v1.30", detail: "目标控制平面" },
  { id: "ingress", label: "Ingress Controller", value: "Envoy Gateway", detail: "AIBrix 入口" },
  { id: "mesh", label: "Service Mesh", value: "Istio sidecar", detail: "mTLS 规划中" },
  { id: "storage-class", label: "StorageClass", value: "local-path / model-pvc", detail: "热模型制品" },
  { id: "gpu-nodes", label: "GPU 节点", value: "2", detail: "RTX 3090 workers" },
  { id: "autoscaler", label: "Autoscaler", value: "HPA + KEDA 规划中", detail: "MVP 只读" }
];

export const workloadRows: WorkloadRow[] = [
  { name: "aibrix-gateway", namespace: "default", desired: "2", ready: "2", available: "2", restarts: "0", resources: "500m / 1Gi", hpa: "enabled", image: "aibrix/gateway:0.3.0", lastDeploy: "12 分钟前", owner: "AI Infra", sloImpact: "P95 偏高" },
  { name: PLATFORM_MODEL_ID, namespace: "default", desired: "2", ready: "2", available: "2", restarts: "4", resources: "2 GPU / 42Gi", hpa: "enabled", image: "vllm-openai:2026.05", lastDeploy: "18 分钟前", owner: "Model Platform", sloImpact: "TTFT 观察" },
  { name: "auto-router", namespace: "default", desired: "1", ready: "1", available: "1", restarts: "0", resources: "300m / 512Mi", hpa: "planned", image: "router:2026.05", lastDeploy: "21 分钟前", owner: "AI Gateway", sloImpact: "healthy" },
  { name: "redis-cache", namespace: "default", desired: "1", ready: "1", available: "1", restarts: "0", resources: "250m / 1Gi", hpa: "disabled", image: "redis:7", lastDeploy: "1 小时前", owner: "Platform", sloImpact: "配置漂移" },
  { name: "prometheus", namespace: "observability", desired: "1", ready: "1", available: "1", restarts: "0", resources: "1 CPU / 4Gi", hpa: "disabled", image: "prometheus:v2.52", lastDeploy: "2 小时前", owner: "SRE", sloImpact: "healthy" }
];

export const kubernetesEvents: EventListItem[] = [
  { id: "failed-scheduling", title: "FailedScheduling", status: "Warning", meta: `${PLATFORM_MODEL_ID}-canary`, description: "gpu-pool-a 的 nvidia.com/gpu 资源不足。", time: "4 分钟前" },
  { id: "backoff", title: "BackOff", status: "Warning", meta: `${PLATFORM_MODEL_ID}-vllm-1`, description: "健康探针超时后进入重启退避。", time: "9 分钟前" },
  { id: "create-gateway", title: "SuccessfulCreate", status: "Normal", meta: "aibrix-gateway", description: "新建网关副本。", time: "12 分钟前" },
  { id: "node-pressure", title: "NodePressure", status: "Warning", meta: "gpu-node-b", description: "GPU 显存压力超过 86%。", time: "15 分钟前" },
  { id: "scale-router", title: "ScalingReplicaSet", status: "Normal", meta: "auto-router", description: "ReplicaSet 扩容到 2。", time: "21 分钟前" }
];

export type GpuScheduleRow = {
  node: string;
  model: string;
  allocated: string;
  memory: string;
  pod: string;
  status: string;
};

export const gpuScheduleRows: GpuScheduleRow[] = [
  { node: "gpu-node-a", model: "RTX 3090", allocated: "2 / 2", memory: "42.8 / 48 GB", pod: `${PLATFORM_MODEL_ID}-vllm-0`, status: "碎片率低" },
  { node: "gpu-node-b", model: "RTX 3090", allocated: "1 / 2", memory: "43.3 / 48 GB", pod: `${PLATFORM_MODEL_ID}-vllm-1`, status: "显存压力" },
  { node: "gpu-node-b", model: "RTX 3090", allocated: "0 / 1", memory: "pending", pod: "qwen3-4b-canary", status: "FailedScheduling" }
];

export const autoscalingRows: KeyValueItem[] = [
  { id: "aibrix-gateway", label: "aibrix-gateway", value: "2 -> 4", detail: "CPU 68% / P95 145ms", status: "建议扩容" },
  { id: PLATFORM_MODEL_ID, label: PLATFORM_MODEL_ID, value: "2 -> 3", detail: "TTFT 42ms / queue 3", status: "Hold" },
  { id: "auto-router", label: "auto-router", value: "1 -> 2", detail: "RPS 120 / error 0.23%", status: "Planned" },
  { id: "rag-index-worker", label: "rag-index-worker", value: "0 -> 1", detail: "索引重建等待中", status: "按需" }
];

export const benchmarkProfiles: StrategyCardItem[] = [
  { id: "aibrix", label: "AIBrix Gateway", value: "least-request", description: "P95 145ms，可见路由压力。" },
  { id: "direct", label: "Direct Round Robin", value: "round-robin", description: "P95 132ms，基线路径。" },
  { id: "vllm0", label: "vLLM Replica 0", value: "direct", description: "P95 118ms，缓存健康。" },
  { id: "vllm1", label: "vLLM Replica 1", value: "direct", description: "P95 176ms，需要观察 GPU 压力。" }
];

export const benchmarkGates: StrategyCardItem[] = [
  { id: "latency", label: "延迟门禁", value: "P95 < 180ms / P99 < 280ms", description: "发布前必须满足端到端延迟预算。", status: "Pass" },
  { id: "error-budget", label: "错误预算", value: "error rate < 1%", description: "请求失败率低于阈值。", status: "Pass" },
  { id: "routing", label: "路由均衡", value: "target pod skew < 30%", description: "目标 Pod 分布不可明显倾斜。", status: "Warning" },
  { id: "aiops", label: "AI Ops 证据", value: "报告已关联", description: "报告写入 Incident 时间线。", status: "Ready" }
];
