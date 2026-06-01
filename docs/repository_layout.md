# 仓库归位说明

更新时间：2026-06-01

本仓库只保留当前云原生基础设施管理平台主线，不再发布历史 LLM 训练平台、浏览器扩展、招聘采集工具或本地实验产物。

## 保留范围

- `apps/web/`：React/Vite 控制台。
- `server/`：Go 控制面 API。
- `agent/`：Go Node/Kubernetes 采集代理。
- `apps/ai-service/`：Python AI 诊断与 Copilot 服务。
- `src/api/`、`src/customer_support/`、`src/jobs/`、`src/metrics/`、`src/rag/`、`src/serve/`：迁移期 Python facade、知识库、压测、指标和系统快照辅助。
- `configs/app/`、`configs/serve/`：平台运行和服务配置。
- `deploy/`：compose、AIBrix、observability 部署模板。
- `docs/`、`云原生平台/`：当前平台设计、迁移计划和复刻说明。
- `data/customer_support/`：轻量 demo 知识库和评测样例。
- `screenshots/`：前端样例、复刻和联调截图。

## 移除范围

- 历史 LLM 训练配置、训练源码、评测源码、profiling 源码和训练报告。
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

新功能优先落在 `apps/web`、`server`、`agent`、`apps/ai-service`、`configs/app`、`configs/serve`、`deploy`、`docs` 和 `云原生平台`。如果文件不能支撑云原生平台的运行、展示、部署或文档说明，不进入公开仓库。
