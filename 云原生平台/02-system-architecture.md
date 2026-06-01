# 02 系统架构设计

> **架构已切换为 Go-primary（2026-05，Phase 4）。** 主后端由 Java/Spring Boot 迁移为
> **Go 控制面**（chi + pgx + client-go）；Java backend 已退役。Python 收敛为**常驻 AI 服务**
> （RAG / 诊断 / chat），由 Go 调用与反向代理。迁移过程与阶段进度以
> `11-go迁移计划.md` 为准；本文第 1、2 节已更新为 Go-primary，第 3 节起的细节正逐步回填，
> 凡提及 "Spring Boot 主后端" 处一律以 Go 控制面替代理解。

## 1. 架构目标

云原生 AI 设施平台采用 **Go 主后端 + Python AI 服务 + 工具链** 的分层架构：

- **Go 控制面（主后端）**：统一对外 `/api/*` 单一入口；原生承担平台元数据/总览、配置中心、
  部署流水线、故障事件、审计、可观测聚合（含百分位）；经 client-go/Agent 读 Kubernetes；
  并把 AI/服务面端点反向代理给 Python（SSE 透传）。
- **Python AI 服务（常驻）**：结构化诊断（Go 取证→Python 推理）、RAG 知识库、流式 chat；
  serving benchmark 和模型服务工具脚本作为辅助能力。
- **Go Infra Agent**：Kubernetes 资源与节点 / GPU 采集（DaemonSet 形态）。
- **React / TypeScript**：企业级浅色控制台 + 局部深色观测组件。
- **Kubernetes + vLLM + AIBrix**：模型服务运行时、网关路由和服务治理。

架构目标不是一次性做成生产级全量平台，而是在 MVP 阶段形成可演示、可迁移、可扩展的控制面。

## 2. 总体架构

```text
React / TypeScript Console
  |
  | REST / SSE
  v
Go 控制面 API（主后端，:8081 单一入口）       ← 退役：Java/Spring Boot
  |  chi + pgx + client-go
  +-- 平台元数据 / 总览
  +-- 配置中心 / 部署流水线 / 故障事件
  +-- 审计 / 可观测聚合（百分位）
  +-- AI 边界：/api/ai/diagnose、/api/ai/chat:stream
  +-- 反向代理：aiops / knowledge / benchmarks / proxy → Python AI 服务
  |
  +------------------+--------------------------+
                     |                          |
Go Infra Agent       PostgreSQL                 Python AI 服务 (FastAPI)
  |                                              |
  | Kubernetes API                               | RAG / 诊断 / chat
  | cAdvisor / Node / GPU metrics                | vLLM / OpenAI-compatible Client
  v                                              v
Kubernetes Runtime                          Vector / File / Report Artifacts
  |
  +-- vLLM Replicas
  +-- AIBrix Gateway / Envoy Gateway
  +-- Observability Components
  +-- Model PVC / Object Storage

Storage:
PostgreSQL（+ 后续 Redis / Vector Store / Object Storage）
```

## 3. 分层职责

### 3.1 Frontend Console

技术：

- React / TypeScript
- Vite 或 Next.js
- Tailwind / shadcn-style components
- ECharts / Recharts
- SSE 用于流式 AI 回复和指标事件

职责：

- Overview、Model Serving、Kubernetes、Observability、AI Ops、Knowledge、Benchmarks、Config/Deployments。
- 左侧资源导航、顶部搜索、资源表格、详情抽屉、右侧 AI Copilot。
- 浅色企业控制台为主，日志、拓扑、图表和 YAML 使用深色局部面板。

### 3.2 Go 控制面 API（主后端，原 Spring Boot 职责已迁移至此）

职责：

- 统一对外暴露 `/api/*` 与 `/v1/chat/completions`。
- 聚合平台元数据、Go Agent 状态、Benchmark、RAG、AI Gateway 和审计数据。
- 向前端提供页面级 API，减少前端拼装复杂度。
- 负责鉴权预留、请求 trace id、错误格式、SSE 转发和审计记录。

目标服务拆分：

```text
infra-api-gateway
infra-metadata-service
infra-config-service
infra-model-serving-service
infra-observability-service
infra-benchmark-service
infra-ai-gateway
infra-audit-service
```

MVP 可以先在一个 Spring Boot monolith 内按 package 分层实现，后续再拆微服务。

### 3.3 Go Infra Agent

职责：

- 读取 Kubernetes Pod / Deployment / Service / Endpoint / Event。
- 采集节点 CPU、内存、磁盘、网络和 GPU 摘要。
- 可选读取 cAdvisor、Prometheus、vLLM `/metrics`。
- 向 Spring Boot Observability Service 上报资源快照。
- 提供轻量 `/healthz` 和 `/metrics`。

部署形态：

- MVP：单进程 agent，运行在本机或集群内。
- 后续：DaemonSet + 集群级 collector 双组件。

### 3.4 Python AI Toolchain

Python 不作为目标主后端，而作为 AI Infra 工具链：

- RAG 文档解析、chunk、embedding、检索原型。
- RAG 文档管理、检索、诊断提示词和流式 chat。
- serving benchmark、vLLM 客户端、报告生成。
- 当前 FastAPI 兼容层中的接口可作为 Go 控制面绞杀迁移参考。

### 3.5 Runtime Layer

运行时组件：

- Kubernetes：服务编排和资源状态来源。
- vLLM：OpenAI-compatible 大模型推理。
- AIBrix Gateway / Envoy Gateway：多副本路由、模型服务治理、路由策略实验。
- cAdvisor / Prometheus：容器与指标采集。
- Model PVC / Object Storage：模型权重、adapter 和报告产物存储。

## 4. 核心数据流

### 4.1 Overview 数据流

```text
Frontend Overview
  -> Spring Boot BFF /api/platform/overview
  -> Metadata Service: service instances, deployments, incidents
  -> Observability Service: request metrics, GPU, host, pod status
  -> Go Agent: Kubernetes resource snapshot
  -> PostgreSQL / Redis
```

输出：

- 平台健康分
- 服务数量和状态
- 活跃告警
- Kubernetes 资源摘要
- 模型服务和 Benchmark 摘要
- AI 诊断摘要

### 4.2 AI Ops 诊断数据流

```text
Frontend AI Diagnose
  -> Spring Boot AI Gateway /api/ai/diagnose
  -> Observability Service: metrics, traces, pods
  -> Config Service: recent config changes
  -> Benchmark Service: recent benchmark runs
  -> Knowledge Service: RAG search
  -> vLLM / AIBrix / external OpenAI-compatible model
  -> Diagnosis Report
```

输出必须结构化：

- Root Cause
- Evidence
- Impact
- Recommended Actions
- Confidence
- Related Resources

### 4.3 Model Serving 请求流

```text
Client / Console
  -> /v1/chat/completions
  -> Spring Boot AI Gateway
  -> route decision
  -> AIBrix Gateway or direct vLLM replica
  -> streaming response
  -> request trace + metrics + audit
```

## 5. 目标接口分组

平台 API：

```text
GET /api/platform/overview
GET /api/services
GET /api/services/{serviceId}
GET /api/kubernetes/pods
GET /api/kubernetes/deployments
GET /api/configs
POST /api/configs
POST /api/configs/{configId}/versions
```

AI Gateway：

```text
POST /v1/chat/completions
POST /api/ai/chat:stream
POST /api/ai/diagnose
GET  /api/ai/diagnoses/{diagnosisId}
```

观测与治理：

```text
GET  /api/metrics/current
GET  /api/model-serving/instances
POST /api/model-serving/instances/{id}/healthcheck
POST /api/benchmarks
GET  /api/benchmarks/{runId}
GET  /api/audit-events
```

RAG：

```text
POST /api/knowledge/documents
GET  /api/knowledge/documents
GET  /api/knowledge/search
POST /api/knowledge/rebuild-index
```

## 6. MVP 部署形态

MVP 推荐：

```text
frontend
spring-boot-platform-api
go-infra-agent
python-rag-benchmark-worker
postgres
redis
vllm-replica-0
vllm-replica-1
aibrix-gateway
```

本地演示允许：

- PostgreSQL 降级为 SQLite。
- 向量库降级为 FAISS 或词法检索。
- Prometheus / Loki 暂不强依赖，通过 Go Agent 和 vLLM `/metrics` 先完成展示。
- 当前 FastAPI 原型保持可运行，用于对照迁移。

## 7. MVP 边界

- 不要求所有服务拆成独立微服务，Spring Boot 可以先做模块化单体。
- 不要求生产级多租户和完整 RBAC，只预留 actor、role、audit 字段。
- 不要求替代 Grafana，只做平台内轻量观测视图。
- 不要求 Go Agent 覆盖所有 Kubernetes 资源，优先 Pod、Deployment、Service、Event。

## 8. 验收标准

- 架构图和模块职责能解释前端、Java、Go、Python、Kubernetes、vLLM、AIBrix 的关系。
- 所有核心页面都能映射到后端服务和数据来源。
- 文档明确当前 FastAPI 是原型参考，不是目标主后端。
- MVP 与后续演进边界清晰，便于按阶段实现。
