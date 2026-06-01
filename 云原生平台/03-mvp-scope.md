# 03 MVP 范围

## 1. MVP 目标

MVP 要证明平台具备三条闭环能力：

1. **模型服务治理闭环**：查看模型服务实例、路由、健康检查、请求指标和 Benchmark。
2. **云原生观测闭环**：查看 Kubernetes 资源、GPU/主机/容器、vLLM metrics 和请求追踪。
3. **AI Ops 诊断闭环**：基于指标、Pod 状态、知识库、配置变更和请求 trace 生成诊断报告。

MVP 不是完整生产平台，重点是把当前仓库已有的 vLLM、AIBrix、RAG、Benchmark、Metrics 能力用 Go/Java 主线重新组织成可持续演进的产品形态。

## 2. 主导航范围

MVP 主导航固定为：

```text
Overview
Model Serving
Kubernetes
Observability
AI Ops
Knowledge / RAG
Benchmarks
Config / Deployments
Demo Apps
Settings
```

说明：

- `Demo Apps` 收纳 Customer Support 示例，不作为平台主线第一入口。
- `Settings` 只做基础配置展示和后续预留。
- 不新增 `06-*` 文档，不影响 MVP 范围。

## 3. 页面范围

### 3.1 Overview

目标：成为平台第一屏。

必须展示：

- Platform Health Score
- Running Services
- Active Alerts
- Kubernetes Pods / Deployments
- GPU / CPU / Memory 摘要
- QPS、P95、TTFT、error rate
- Model Serving 状态
- Recent Incidents
- Recent Benchmarks
- AI Diagnosis Summary

验收标准：

- 用户能在 30 秒内判断平台是否健康。
- 每个 KPI 都能点击进入对应模块。
- 页面不堆满表格，优先卡片、趋势、摘要和风险列表。

### 3.2 Model Serving

目标：管理大模型推理服务治理对象。

必须展示：

- service instances：vLLM replica、AIBrix Gateway、client round-robin、auto-router。
- model id、base URL、kind、routing role、GPU、status、last checked time。
- 健康检查按钮。
- 目标 pod / upstream 分布。
- 近 10 分钟请求数、错误率、P95、TTFT、tokens/s。

MVP 操作：

- 查看实例详情。
- 触发 healthcheck。
- 查看路由策略。
- 进入 Benchmark 创建页。

不做：

- 在线编辑复杂路由规则。
- 自动扩缩容。
- 多租户模型权限。

### 3.3 Kubernetes

目标：提供 AI 服务运行时资源视图。

必须展示：

- namespace、pod、deployment、service、phase、ready、restarts、node、pod ip。
- default、aibrix-system、envoy-gateway-system、observability 等关键 namespace。
- vLLM / AIBrix 相关资源优先展示。

MVP 操作：

- 按 namespace、status、component 过滤。
- 点击资源打开详情抽屉。
- 对异常 Pod 提供 AI Diagnose 入口。

不做：

- 在线编辑 YAML 并 apply 到集群。
- 替代 Kubernetes Dashboard。
- 完整 RBAC。

### 3.4 Observability

目标：展示平台运行数据和推理性能。

必须展示：

- 请求量、QPS、error rate。
- mean latency、P50/P95/P99、TTFT。
- input/output tokens、tokens/s。
- GPU memory、GPU utilization。
- host CPU、memory、disk、network。
- cAdvisor 容器摘要。
- vLLM `/metrics` 关键指标。
- Request traces 表格。

MVP 操作：

- 时间窗口切换：最近 10 分钟、30 分钟、1 小时。
- 按 endpoint、target pod、status 过滤。
- 从异常 trace 进入 AI Ops。

不做：

- 完整 logs/traces 后端。
- 替代 Grafana。
- 自定义 Dashboard 编排。

### 3.5 AI Ops

目标：不是孤立聊天框，而是诊断工作台。

必须展示：

- 左侧问题输入和历史诊断。
- 中间结构化诊断报告。
- 右侧证据面板：metrics、traces、pods、configs、knowledge docs。
- Tool Calls / Evidence 展示。
- Recommended Actions。

MVP 诊断类型：

- 推理延迟升高。
- 错误率升高。
- vLLM replica 不健康。
- AIBrix Gateway 不可达。
- Kubernetes Pod 重启或 Pending。
- 配置变更后异常。

不做：

- 自动执行修复动作。
- 自动回滚生产配置。
- 无人工确认的集群写操作。

### 3.6 Knowledge / RAG

目标：管理 AI Ops 和问答使用的知识来源。

必须展示：

- 文档列表。
- category、version、source uri、created time。
- 文档创建 / 更新。
- 搜索结果和 score。
- 重建索引。

知识来源：

- README 和架构文档。
- Kubernetes YAML。
- AIBrix / vLLM 部署说明。
- Benchmark 报告。
- 故障手册。
- 配置变更记录。

MVP 边界：

- 本地可使用词法检索或 FAISS。
- 目标架构保留向量数据库接口。

### 3.7 Benchmarks

目标：管理推理压测和报告。

必须展示：

- run id、endpoint、workload、routing strategy、status。
- 并发级别、请求数、prompt profile。
- QPS、TTFT、P95/P99、decode tokens/s、error rate。
- target pod / upstream distribution。
- report path 和事件流。

MVP 操作：

- 创建 serving benchmark。
- 查看 run 状态。
- 查看 benchmark events。
- 查看报告摘要。

不做：

- 分布式压测集群。
- 复杂成本核算。

### 3.8 Config / Deployments

目标：提供配置中心和部署记录的最小闭环。

必须展示：

- config key、namespace、env、version、status。
- 配置历史。
- 变更人、变更原因、变更时间。
- deployment id、service、version、env、status、started/finished time。

MVP 操作：

- 新建配置项。
- 创建新版本。
- 查看历史。
- 标记配置为 active / inactive。
- 从 AI Ops 查看最近配置变更作为证据。

不做：

- 灰度发布完整引擎。
- 客户端长轮询 SDK。
- 生产级审批流。

## 4. 优先级

| 优先级 | 模块 | 理由 |
| --- | --- | --- |
| P0 | Overview、Model Serving、Observability、AI Ops | 直接体现 AI Infra 核心价值 |
| P0 | Knowledge / RAG、Benchmarks | 当前仓库已有基础，能形成闭环 |
| P1 | Kubernetes、Config / Deployments | 增强云原生和平台工程属性 |
| P1 | Audit、Incidents | 支撑诊断和复盘 |
| P2 | Settings、Demo Apps 整理 | 体验优化和展示补充 |

## 5. 目标接口

```text
GET  /api/platform/overview
GET  /api/model-serving/instances
POST /api/model-serving/instances/{id}/healthcheck
GET  /api/kubernetes/pods
GET  /api/kubernetes/deployments
GET  /api/metrics/current
GET  /api/metrics/requests
POST /api/ai/diagnose
POST /api/knowledge/documents
GET  /api/knowledge/search
POST /api/knowledge/rebuild-index
POST /api/benchmarks
GET  /api/benchmarks/{runId}
GET  /api/configs
POST /api/configs
GET  /api/audit-events
```

## 6. 验收标准

- 主导航和模块范围与本文档一致。
- Demo Apps 不再抢占平台第一屏。
- P0 页面能完成一条演示链路：Overview 发现异常 -> Observability 查看证据 -> AI Ops 诊断 -> Model Serving / Benchmarks 验证。
- 每个 MVP 模块都有明确数据来源、页面目标和不做事项。
