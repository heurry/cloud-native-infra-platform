# 01 PRD：云原生 AI 设施平台

## 1. 产品定位

**Cloud Native AI Infrastructure Platform（云原生 AI 设施平台）** 是一个面向大模型推理服务治理、云原生资源观测和 AI Ops 诊断的全栈平台。

平台不定位为普通后台 CRUD 系统，而是围绕以下能力构建：

- 模型服务治理：统一管理 vLLM、AIBrix Gateway、多副本实例、模型路由、健康检查和压测结果。
- 云原生观测：聚合 Kubernetes Pod / Deployment / Service、GPU、主机、容器和请求链路指标。
- AI Ops 诊断：结合 RAG 知识库、请求追踪、指标、配置变更和 Kubernetes 状态，生成结构化诊断建议。
- 平台工程工作台：提供服务目录、配置中心、部署记录、Benchmark、审计日志和问题复盘入口。

目标技术主线：

```text
React / TypeScript Console
  -> Go Control Plane API
  -> Python AI Service / RAG / Evaluation Tooling
  -> Go Infra Agent / Metrics Collector
  -> Kubernetes + vLLM + AIBrix + Observability Runtime
```

当前仓库以 Go 后端为主入口，Python AI 服务承接 RAG、诊断和部分推理工具能力。

## 2. 背景与问题

大模型服务上线后，平台侧通常面对这些问题：

- 推理实例多：直连 vLLM、多副本、AIBrix Gateway 和不同模型版本混在一起。
- 故障定位慢：P95 延迟升高、TTFT 变差、GPU 利用率异常、Pod 重启、配置变更之间缺少统一关联。
- 可观测性分散：Kubernetes、Prometheus、vLLM metrics、Benchmark 报告、日志和知识库分别散落在不同工具。
- AI 功能表层化：很多项目只提供聊天框，不能结合真实资源、指标、配置和历史事件做诊断。
- 项目展示割裂：训练、推理、网关、观测、前端控制台如果没有统一产品叙事，难以体现 AI Infra 全栈能力。

本平台要把这些能力组合成一个可演示、可扩展、能支撑面试和后续开发的云原生 AI Infra 控制台。

## 3. 用户角色

| 角色 | 关注点 | 典型操作 |
| --- | --- | --- |
| 平台工程师 | 集群状态、服务治理、配置变更、审计 | 查看 Kubernetes 资源、配置发布、健康检查、排查告警 |
| AI Infra 工程师 | 模型服务吞吐、延迟、路由、GPU | 管理 vLLM/AIBrix 实例、运行 Benchmark、分析 TTFT/P95/tokens/s |
| 算法 / 模型工程师 | 模型版本、评测、知识库、运行时参数 | 查看模型发布状态、检索知识库、评估服务质量 |
| SRE / 运维 | 告警、事件、根因、修复建议 | 查看 Incident、调用 AI Diagnose、生成 Runbook |
| 面试 / 项目评审者 | 架构完整性、工程落地、技术深度 | 快速理解系统边界、演示核心链路、查看文档与指标 |

## 4. 核心用户场景

### 场景 1：查看平台健康状态

用户进入 Overview，看到平台健康分、运行中服务、活跃告警、Kubernetes 资源、GPU 使用率、请求量、P95 延迟和近期部署。

系统应支持：

- 汇总最近 10 分钟请求指标。
- 展示 vLLM/AIBrix 实例状态。
- 展示 Kubernetes Pod / Deployment 摘要。
- 展示 AI 诊断摘要和高风险服务。

### 场景 2：管理模型服务实例

用户进入 Model Serving，查看模型、网关、直连副本、路由策略和健康状态。

系统应支持：

- 列出 `auto-router`、`aibrix-gateway`、`direct-round-robin`、`vllm-replica-*` 等服务实例。
- 对实例执行健康检查。
- 展示 endpoint、model id、routing role、GPU 绑定和最近调用指标。
- 进入实例详情后查看请求分布、错误率和上游 metrics。

### 场景 3：定位推理服务异常

用户在 Observability 或 AI Ops 页面看到 `payment-service` 或 `qwen3-4b-customer` 延迟升高。

系统应支持：

- 一键触发 AI Diagnose。
- 查询请求追踪、指标、Kubernetes Pod 状态、最近配置变更、Benchmark 结果和知识库。
- 生成结构化诊断报告：Root Cause、Evidence、Impact、Recommended Actions、Confidence。

### 场景 4：维护知识库和诊断资料

用户进入 Knowledge / RAG 页面，上传或维护平台文档、Kubernetes YAML、故障手册、Benchmark 报告和项目 README。

系统应支持：

- 文档创建、版本管理和检索。
- MVP 使用本地词法检索或 FAISS；目标架构支持向量数据库。
- AI Gateway 在诊断和问答时注入检索上下文。

### 场景 5：运行和对比 Benchmark

用户进入 Benchmarks，选择 endpoint、并发级别、请求数和 workload，触发压测。

系统应支持：

- 运行 serving benchmark。
- 记录 QPS、TTFT、P50/P95/P99、decode tokens/s、error rate、target pod distribution。
- 对比直连 vLLM、FastAPI round-robin 原型和 AIBrix Gateway 的结果。

## 5. MVP 功能范围

MVP 必须包含：

- Overview：平台健康总览、KPI、模型服务摘要、近期告警、近期部署。
- Model Serving：服务实例列表、模型列表、健康检查、路由策略展示。
- Kubernetes：Pod / Deployment / Service 摘要和资源状态。
- Observability：请求、延迟、错误率、GPU、主机、容器、vLLM metrics。
- AI Ops：上下文诊断、诊断报告、证据列表、建议动作。
- Knowledge / RAG：文档列表、文档写入、检索、索引重建。
- Benchmarks：Benchmark 创建、状态查询、事件流、报告摘要。
- Config / Deployments：配置项、版本历史、部署记录和配置变更审计的最小闭环。

## 6. 非目标

MVP 阶段不做：

- 多租户计费系统。
- 完整生产级权限体系和组织架构。
- 复杂审批流和 ITSM 工单。
- 多云资源编排。
- 完整替代 Prometheus、Grafana、Loki 或 Argo CD。
- 从零实现模型推理引擎。
- 生产级多节点训练平台。

## 7. 成功指标

| 指标 | MVP 验收标准 |
| --- | --- |
| 演示完整性 | 能从 Overview 进入 Model Serving、Observability、AI Ops、Knowledge、Benchmarks 完成一条闭环演示 |
| 服务治理 | 能展示至少 3 类 endpoint：vLLM replica、client round-robin、AIBrix Gateway |
| 诊断能力 | AI Ops 报告必须包含 root cause、evidence、impact、actions、confidence |
| 可观测性 | 能展示 QPS、错误率、P95、TTFT、tokens/s、GPU、Pod 状态 |
| 数据闭环 | Benchmark、request trace、knowledge document、service instance 均可落库 |
| 技术叙事 | 文档中 Go 为目标平台主线，Python 用于 AI/RAG/诊断和推理工具链 |

## 8. 验收标准

- 产品文档能清晰说明“模型服务治理 + 云原生观测 + AI Ops 诊断”的核心价值。
- MVP 页面和后端接口有一一对应关系。
- 技术边界清晰：Go 是目标平台控制面，Python 是 AI 服务和推理工具链。
- Customer Support 只作为 Demo App，不作为平台主导航第一优先级。
- 文档能指导后续工程实现，不依赖口头解释才能理解范围。
