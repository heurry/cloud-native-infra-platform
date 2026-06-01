# 07 AI Gateway 设计

## 1. 设计目标

AI Gateway 是平台的模型访问入口和 AI Ops 编排入口，目标使用 **Java / Spring Boot** 实现。

它需要同时承担：

- OpenAI-compatible proxy。
- SSE streaming。
- 模型路由和服务降级。
- AIBrix Gateway / vLLM replica 转发。
- RAG 上下文注入。
- 请求 trace、token、latency、target pod 统计。
- AI Ops 诊断工作流编排。

当前 Python FastAPI 中的聊天、RAG、round-robin、trace 和 benchmark 原型可作为迁移参考；目标实现以 Spring Boot AI Gateway 为主。

## 2. 模块边界

```text
Spring Boot AI Gateway
  |
  +-- OpenAI-Compatible Controller
  +-- Chat / Diagnose Controller
  +-- Routing Engine
  +-- RAG Context Builder
  +-- Upstream Client
  +-- Streaming Adapter
  +-- Trace Recorder
  +-- Policy / Fallback Handler
  +-- Tool Orchestrator
```

外部依赖：

- Model Serving Service：读取 service instances、routing policies、model metadata。
- Knowledge Service：检索知识库文档。
- Observability Service：读取 request traces、metrics、pod 状态。
- Config Service：读取最近配置变更。
- Benchmark Service：读取近期压测结果。
- vLLM / AIBrix：OpenAI-compatible upstream。

## 3. 核心接口

### 3.1 OpenAI-compatible proxy

```text
POST /v1/chat/completions
```

请求兼容 OpenAI Chat Completions：

```json
{
  "model": "qwen3-4b-customer",
  "messages": [
    {"role": "user", "content": "为什么服务延迟升高？"}
  ],
  "stream": true,
  "temperature": 0.0,
  "max_tokens": 512
}
```

行为：

- 根据 `model`、headers、payload 和 routing policy 选择 upstream。
- 支持 `stream=true` 时透传 SSE。
- 记录 request trace。
- 返回 header：`x-request-id`、`x-routing-endpoint`、`x-target-pod`。

### 3.2 平台 Chat Stream

```text
POST /api/ai/chat:stream
```

用途：

- 平台控制台 AI Copilot。
- 支持携带页面上下文。
- 可注入 RAG 文档和资源信息。

请求：

```json
{
  "session_id": "optional-session-id",
  "user_message": "解释这个 Pod 为什么重启",
  "context": {
    "page": "kubernetes",
    "resource_type": "pod",
    "resource_id": "default/qwen3-4b-customer-xxx"
  },
  "endpoint_id": "auto-router",
  "stream": true
}
```

### 3.3 AI Ops Diagnose

```text
POST /api/ai/diagnose
```

请求：

```json
{
  "problem": "payment-service 最近 10 分钟 P95 延迟升高",
  "scope": {
    "service": "payment-service",
    "namespace": "default",
    "time_range": "10m"
  },
  "evidence_types": ["metrics", "traces", "pods", "configs", "knowledge", "benchmarks"]
}
```

响应：

```json
{
  "diagnosis_id": "diag-20260524-001",
  "status": "success",
  "summary": "检测到 gateway 路由和上游 replica 延迟异常",
  "root_cause": "vLLM replica-1 最近请求排队增加，且配置变更后 max_tokens 上升",
  "evidence": [],
  "impact": "影响生产环境部分长上下文请求，P95 延迟升高",
  "recommended_actions": [],
  "confidence": 0.78,
  "related_resources": []
}
```

### 3.4 查询诊断结果

```text
GET /api/ai/diagnoses/{diagnosisId}
```

用于前端刷新诊断详情和历史记录。

## 4. 路由策略

MVP 支持这些 endpoint kind：

| kind | 说明 |
| --- | --- |
| `vllm` | 直连 vLLM OpenAI-compatible server |
| `aibrix` | 通过 AIBrix Gateway / Envoy Gateway |
| `client_round_robin` | Gateway 侧轮询多个 vLLM replica |
| `auto_router` | 根据策略选择 AIBrix 或直连路径 |

MVP 路由决策：

1. 如果指定 `endpoint_id`，优先使用该 endpoint。
2. 如果 endpoint 是 `auto_router`，按 routing policy 选择候选 upstream。
3. AIBrix 健康时优先走 AIBrix。
4. AIBrix 不可用时 fallback 到 direct round-robin。
5. 所有候选不可用时返回结构化错误，并记录 trace。

策略字段：

- `least-request`
- `prefix-cache`
- `least-kv-cache`
- `least-latency`
- `throughput`

MVP 不实现复杂在线策略编辑，只读取数据库或配置文件中的 routing policy。

## 5. RAG 上下文注入

AI Gateway 不直接承担重型 embedding 训练，但需要编排 RAG：

```text
User Query
  -> Query Rewrite / Context Extraction
  -> Knowledge Service Search
  -> Top-K Documents
  -> Prompt Assembly
  -> Upstream Model
```

MVP 检索来源：

- 平台文档。
- Kubernetes YAML。
- 部署说明。
- Benchmark 报告。
- 配置变更记录。
- 历史 Incident。

Prompt 必须包含：

- 用户问题。
- 当前页面上下文。
- Top-K 文档摘要。
- 可用工具结果摘要。
- 输出格式要求。

输出格式要求用于 AI Ops 时必须结构化，不允许只返回自由文本。

## 6. Tool Orchestrator

AI Ops Diagnose 会调用内部工具：

| 工具 | 数据来源 |
| --- | --- |
| `get_service_metrics` | Observability Service |
| `get_request_traces` | request_traces |
| `get_kubernetes_status` | Go Infra Agent / k8s_resources |
| `get_recent_config_changes` | Config Service |
| `get_recent_benchmarks` | Benchmark Service |
| `search_knowledge` | Knowledge Service |
| `get_service_dependencies` | Metadata Service |

工具调用结果作为 evidence 写入诊断结果。

MVP 工具编排可以使用固定流程，不要求自主 agent 无限循环：

```text
1. 解析问题和 scope
2. 拉取 metrics
3. 拉取 traces
4. 拉取 Kubernetes 状态
5. 拉取配置变更和 benchmark
6. 检索知识库
7. 调用模型生成诊断报告
8. 落库并返回
```

## 7. Streaming 设计

SSE 事件类型：

```text
route
retrieval
tool_call
tool_result
token
diagnosis
error
done
```

示例：

```text
event: route
data: {"endpoint_id":"auto-router","selected_endpoint_id":"aibrix-gateway"}

event: tool_call
data: {"tool":"get_service_metrics","status":"running"}

event: token
data: {"text":"初步判断..."}

event: done
data: {"request_id":"req-xxx","diagnosis_id":"diag-xxx"}
```

前端必须能在流式过程中展示：

- 路由选择。
- 检索文档。
- 工具调用进度。
- 模型输出。
- 最终结构化报告。

## 8. Trace 与指标

每次请求都必须生成 `request_id`。

记录字段：

- request id
- session id
- endpoint id
- selected endpoint id
- target pod
- model id
- routing strategy
- retrieval ms
- queue / gateway ms
- ttft ms
- generation ms
- total ms
- input tokens
- output tokens
- status
- error
- citation doc ids
- created at

这些数据写入 `request_traces`，并用于：

- Observability 页面。
- Model Serving 详情。
- AI Ops evidence。
- Benchmark 对比。

## 9. Fallback 与错误处理

MVP 错误策略：

- upstream 超时：返回 `upstream_timeout`，记录 endpoint 和耗时。
- upstream 5xx：尝试 fallback endpoint；失败后返回 `upstream_error`。
- RAG 检索失败：继续模型请求，但标记 `retrieval_unavailable`。
- 所有模型不可用：返回可读错误，不伪造 AI 结果。
- streaming 中断：发送 `error` 事件并关闭流。

安全边界：

- AI Diagnose 只推荐动作，不自动执行重启、扩容、回滚。
- 配置和集群写操作必须由独立平台 API 执行，并需要人工确认。
- Prompt 中要求模型引用 evidence，不能凭空生成不存在的资源状态。

## 10. MVP 边界

- 不实现完整多租户限流和计费。
- 不实现复杂 Agent 自主规划。
- 不要求所有 OpenAI API 完全兼容，只优先 Chat Completions。
- 不在 Java Gateway 中加载模型权重。
- 不把 Python FastAPI 作为目标主后端；其逻辑用于迁移参考。

## 11. 验收标准

- `/v1/chat/completions` 可以路由到 AIBrix 或 vLLM。
- `/api/ai/chat:stream` 能返回 route、retrieval、token、done 等 SSE 事件。
- `/api/ai/diagnose` 能生成结构化诊断报告。
- 每次请求都能在 request trace 中查询到路由、延迟、token 和状态。
- RAG、metrics、Kubernetes、config、benchmark 至少有 3 类 evidence 能进入诊断报告。
- 文档明确 AI Gateway 的目标实现是 Spring Boot，Python 只作为 AI 工具链和已有原型参考。
