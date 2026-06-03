# CloudNative Infra Platform

[![CI](https://github.com/heurry/cloud-native-infra-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/heurry/cloud-native-infra-platform/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go&logoColor=white)
![Node](https://img.shields.io/badge/Node-20-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)

面向云原生微服务场景的分布式基础设施管理平台，统一提供配置中心、服务治理、元数据管理、可观测监控、CI/CD 自动化、弹性扩缩容、分层存储与 AI 运维分析能力。

> **项目状态**：本仓库为演示 / 作品集级别的平台实现，端到端可运行；部分链路（AIBrix/vLLM、GPU、minikube 集群）依赖本地环境，在普通机器上可按需跳过。

![平台总览界面](docs/images/dashboard.png)

当前项目采用 **Go-primary** 架构：React 控制台只对接 Go 控制面 API；Go 负责平台治理、PostgreSQL 数据、Kubernetes/Agent 访问、审计、可观测聚合，以及原生的知识库 RAG、压测 runner 和流式 Copilot；Python AI Service 仅提供结构化诊断与 LLM/Embedding 推理。Java 后端与 legacy Python 单体（`src/`）已全部退役，所有 `/api/*` 均由 Go 原生提供（或经 AI Service）。

## Architecture

```text
React / Vite Console
  -> Go Control Plane API (:8081)   ← single entry; every /api is Go-native
       ├─ Config / deployments / incidents / audit / metrics / platform overview
       ├─ Models / proxy / benchmarks / knowledge (pgvector RAG) / evals / chat
       ├─ Kubernetes snapshot via client-go + Go Agent (:8090)
       └─ /api/ai/* -> Python AI Service (:8200, diagnose + LLM/embed)

PostgreSQL (+ pgvector) stores control-plane data and RAG embeddings.
Redis backs cache / rate-limit / idempotency; MinIO holds benchmark & eval artifacts.
AIBrix / vLLM provide OpenAI-compatible model serving for AIOps and benchmark flows.
```

## 核心能力

- 平台总览：健康分、服务状态、活跃告警、集群 Pod 和关键指标聚合。
- 配置中心：配置项、版本发布、回滚和审计链路。
- 服务治理：模型服务实例、运行时健康、Gateway / vLLM 路由状态。
- 发布流水线：发布记录、Canary 状态、回滚入口和 SLO / Benchmark 门禁。
- 可观测监控：请求延迟、TTFT、吞吐、主机资源、GPU、cAdvisor 和 Kubernetes 快照。
- 知识库 / RAG：基准测试日志入库、pgvector 向量检索、索引重建和检索增强问答（Go 原生）。
- AI Ops：Go 聚合证据，Python AI Service 生成根因、影响面、证据和建议动作。
- 设置页：API、Agent、AI Service 健康探测和本地配置编辑。

## 界面预览

| 服务治理 | 集群快照 |
| --- | --- |
| ![服务治理](docs/images/services.png) | ![集群快照](docs/images/kubernetes.png) |
| **可观测监控** | **AI Ops** |
| ![可观测监控](docs/images/observability.png) | ![AI Ops](docs/images/ai-ops.png) |
| **发布流水线** | **压测门禁** |
| ![发布流水线](docs/images/pipelines.png) | ![压测门禁](docs/images/benchmarks.png) |

> 更多页面截图见 [`docs/images/`](docs/images/)（知识库 / 模型注册 / 配置中心 / 演示应用 / 设置）。

## 仓库结构

```text
apps/web/          React/Vite 控制台
server/            Go 控制面 API（单一入口，全部 /api 原生）
agent/             Go Node/Kubernetes 采集代理
apps/ai-service/   Python AI 诊断与 LLM/Embedding 服务
configs/serve/     vLLM / AIBrix / 模型服务配置
deploy/            compose、Helm、AIBrix、observability 部署文件
scripts/           AIBrix/vLLM 服务层与一键启动脚本
docs/              当前平台设计、部署和归位说明
docs/images/       控制台各页面截图
```

## 快速开始

### 1. 启动后端控制面

```bash
docker compose -f deploy/compose/docker-compose.yml up -d --build
```

Compose 会启动：

- PostgreSQL (+ pgvector) `:5432`
- Redis `:6379`、MinIO `:9000/:9001`
- Go control plane `:8081`
- Python AI Service `:8200`
- Go Agent `:8090`

> 这一步即可独立运行：AI 服务回退 stub、k8s / 指标链路降级，不阻塞启动。需要真实模型推理见下方「3. 完整本地栈」——届时改用 `scripts/run_full_stack.sh` 拉起 Go 应用层（内置启动顺序预检）。

### 2. 启动前端控制台

```bash
cd apps/web
npm install
npm run dev
```

默认访问：

- Web UI: `http://127.0.0.1:5173`
- Go API health: `http://127.0.0.1:8081/api/health`
- Python AI health: `http://127.0.0.1:8200/internal/health`

### 3. 完整本地栈（含 GPU 推理，可选）

本机具备 minikube、NVIDIA runtime、AIBrix、vLLM 与模型权重（`model/Qwen3.5-4B/`）时，可拉起真实推理链路。**启动顺序很重要——必须先推理层、后应用层**：

```bash
# 1) 先起推理层：minikube + AIBrix + vLLM(Qwen3.5-4B) + cAdvisor；AIBrix 网关 → 127.0.0.1:8010
bash scripts/run_aibrix_4b_stack.sh

# 2) 再起 Go 应用层 + 前端
bash scripts/run_full_stack.sh

# 3) 确认网关在服务（应列出 qwen3-4b-customer）
curl -s http://127.0.0.1:8010/v1/models
```

网关就绪后，AI Copilot 会从 stub 自动切到真实流式推理（ai-service `AI_STUB_MODE=auto` 每条消息重试 live，无需重启前端）。

> **为什么顺序不能反**：go-server 接入 `minikube` 外部网络以直达集群 API（`192.168.49.2:8443`）。若 minikube 未运行时先起应用层，Docker 会把 minikube 保留的 `192.168.49.2` 分给 go-server，之后 `minikube start` 报 `Address already in use`。两个脚本都内置预检，会**快速失败并给出修复指引**：
> - `run_full_stack.sh`：minikube 容器存在但未运行时拒绝启动；无 GPU 仅跑应用层降级模式时用 `ALLOW_MINIKUBE_DOWN=1` 覆盖。
> - `run_aibrix_4b_stack.sh`：`192.168.49.2` 被非 minikube 容器占用时拒绝启动，提示先 `docker compose -f deploy/compose/docker-compose.yml down`。

## 开发验证

Frontend:

```bash
cd apps/web
npm run build
```

Go control plane:

```bash
cd server
go test ./...
```

Go agent:

```bash
cd agent
go test ./...
```

Python legacy API:

```bash
pip install -r requirements.txt
pytest tests/ -q
```

Python AI Service:

```bash
cd apps/ai-service
pip install -r requirements.txt
pytest tests/ -q
```

## 贡献与社区

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 安全漏洞报告：[SECURITY.md](SECURITY.md)（请勿提交公开 issue）
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

欢迎通过 Issue / Pull Request 参与。提交前请阅读贡献指南并确保相关构建与测试通过。

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。
