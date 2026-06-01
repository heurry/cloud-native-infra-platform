# CloudNative Infra Platform AI Service

独立可部署的 FastAPI 服务，是 Go 控制面背后的 **Python AI 推理面**（云原生平台/11-go迁移计划.md Phase 3）。

```
前端 ──► Go 控制面(:8081) ──┬─► /api/ai/diagnose   ──(取证)──► /internal/diagnose（本服务）
                            └─► /api/ai/chat:stream ──(SSE 透传)──► /internal/chat:stream（本服务）
                                                          │
                                                          ▼
                                              AIBrix 网关 / vLLM（qwen3-4b-customer）
```

边界分工（D4）：**Go 取证**（聚合 metrics/事件/部署/配置/k8s）→ **本服务推理**（RAG+LLM 出结构化 JSON）→ **Go 落库+审计**。本服务不碰 PostgreSQL，无状态。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/internal/health` | 存活 + 当前模式（stub/live）+ 上游地址 |
| POST | `/internal/diagnose` | 结构化诊断；入参 `{question, evidence, options?}`，返回 `DiagnoseResponse` |
| POST | `/internal/chat:stream` | SSE 流式问答；入参 `{question? \| messages?, max_tokens, temperature}` |

`DiagnoseResponse` 契约（与 Go `internal/aiclient.DiagnoseResult` 逐字段对齐）：
`status / root_cause / confidence / impact / evidence[] / recommended_actions[] / related_resources[] / model_id / endpoint_id / latency_ms / mode / error`

## stub vs live（`AI_STUB_MODE`）

- `auto`（默认）：先试 live；上游不可达时**回退 stub**，并在 `error` 标注回退原因。
- `on`：强制 stub —— 无 GPU 也能端到端跑通，`mode=stub`，诊断由证据**确定性**推导。
- `off`：强制 live —— 上游失败直接返回 `status=failed`。

> stub 不是占位假数据：它按错误率/延迟阈值/未解决故障**从真实证据推导**根因与建议，因此即便没有 GPU，整条 Go↔Python 链路与前端展示也都能验证。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_LLM_BASE_URL` | `http://127.0.0.1:8010/v1` | OpenAI 兼容上游（AIBrix 网关） |
| `AI_LLM_MODEL` | `qwen3-4b-customer` | 模型 id |
| `AI_LLM_API_KEY` | `EMPTY` | 网关无鉴权时留 `EMPTY` |
| `AI_LLM_TIMEOUT_SECONDS` | `60` | 调 LLM 超时 |
| `AI_STUB_MODE` | `auto` | `auto` / `on` / `off` |
| `AI_SERVICE_PORT` | `8200` | 监听端口 |

## 本地运行

```bash
cd apps/ai-service
pip install -r requirements.txt

# 单测（纯逻辑，无需 GPU / FastAPI）
python -m pytest tests/ -q

# 起服务（无 GPU 时建议强制 stub）
AI_STUB_MODE=on uvicorn app:app --host 0.0.0.0 --port 8200
```

## Docker

```bash
docker build -t twf-ai-service:dev apps/ai-service
docker run --rm -p 8200:8200 -e AI_STUB_MODE=on twf-ai-service:dev
```
