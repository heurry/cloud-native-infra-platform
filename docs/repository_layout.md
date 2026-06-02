# 仓库归位说明

更新时间：2026-06-02

本仓库只保留当前云原生基础设施管理平台主线，不再发布历史 LLM 训练平台、浏览器扩展、招聘采集工具或本地实验产物。Java 后端与 legacy Python 单体（`src/`）已随 Go 迁移收尾全部退役。

## 保留范围

- `apps/web/`：React/Vite 控制台。
- `server/`：Go 控制面 API（单一入口，全部 `/api` 原生：治理、知识库 pgvector RAG、压测 runner、流式 Copilot）。
- `agent/`：Go Node/Kubernetes 采集代理。
- `apps/ai-service/`：Python AI 诊断与 LLM/Embedding 服务。
- `configs/serve/`：vLLM / AIBrix / 模型服务配置。
- `deploy/`：compose、Helm、AIBrix、observability 部署模板。
- `scripts/`：AIBrix/vLLM 服务层与一键启动脚本（`run_aibrix_4b_stack.sh`、`run_full_stack.sh`）。
- `docs/`：当前平台设计、部署和复刻说明。
- `docs/images/`：控制台各页面截图。

## 移除范围

- 历史 LLM 训练配置、训练源码、评测源码、profiling 源码和训练报告。
- legacy Python 单体源码（`src/`）、迁移期 FastAPI facade、客户支持 demo 与离线压测脚本（已被 Go 原生能力取代）。
- 客户支持 demo 知识库与评测样例（`data/customer_support/`）；知识库语料只保留基准测试日志。
- 非平台浏览器扩展。
- 招聘采集示例相关源码、文档和数据。
- 根级 Puppeteer 临时包。
- 本地运行日志、PID、模型权重、训练输出和 SQLite 运行库。

## 本地运行产物

以下目录可以存在于本机，但不应进入 GitHub：

```text
model/
runs/
logs/aibrix_4b/
logs/runtime/
logs/observability/
node_modules/
apps/web/dist/
apps/web/node_modules/
deploy/compose/.secrets/
```

## 原则

新功能优先落在 `apps/web`、`server`、`agent`、`apps/ai-service`、`configs/serve`、`deploy`、`scripts`、`docs` 和 `云原生平台`。如果文件不能支撑云原生平台的运行、展示、部署或文档说明，不进入公开仓库。
