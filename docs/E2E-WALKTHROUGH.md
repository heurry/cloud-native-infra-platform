# 真栈端到端联调串讲 / Live E2E Walkthrough

> 2026-06-08。把 ROADMAP 里所有「真栈联调」验收项，放到**真 GPU serving 栈 + 真控制面 + 真 k8s 写 + 真可观测**上逐条跑通，并留下机读证据。
> 逐条原始输出在 [`docs/e2e-evidence/`](./e2e-evidence/)。本文件是导读 + 结论。

本次联调把平台从「代码路径就绪 / 单测覆盖」推进到「在真实依赖上端到端验证过」，并在过程中真实发现并修复了 1 个 live-path bug。

---

## 0. 联调时的真实拓扑

```
浏览器/curl ──► go-server :8081 (单一入口, chi, sqlc→store→dto)
                     ├─ PostgreSQL(pgvector:pg16)  Redis:7  MinIO   ← compose
                     ├─ /api/ai/* ─► python-ai-service :8200 ─► AIBrix 网关 :8010 ─► 2×vLLM (Qwen3-4B, 各 1 GPU)
                     ├─ client-go 直读/直写 ─► minikube apiserver (192.168.49.2:8443)
                     └─ OTel trace ─► Tempo :4318 ; /metrics ─► Prometheus ; Grafana :3000
```

- **GPU**：2× RTX 3090，每卡一个 vLLM 副本，AIBrix v0.6.0 网关在前做多副本负载均衡。
- **启动顺序（硬约束）**：serving 栈（`scripts/run_aibrix_4b_stack.sh`，先把 minikube 拉起）**必须早于** compose（否则 go-server 抢占 minikube 保留 IP `192.168.49.2`，`minikube start` 撞 "Address already in use"）。
- **联调期临时开关**（公共演示默认全关，联调后已还原）：`ALLOW_K8S_WRITES=true` + `K8S_WRITE_NAMESPACES=default`、`RAG_RERANK_FEEDBACK=true`、`ROUTING_SHADOW_ENABLED=true`。
- **AI 真伪边界（诚实）**：LLM 生成是**真 live**（Qwen3-4B 经 AIBrix→vLLM，token 真流式）；**embedding 是确定性 stub**——serving 栈跑的是 chat 模型、无 `/v1/embeddings`，ai-service 退回本地确定性嵌入（1024 维）。RAG 检索因此是「确定性向量 + 真 pgvector 余弦」，召回机制真实，只是嵌入空间非学习得来。

---

## 1. 控制面闭环（Stage 1）

| 闭环 | 关键结果 | 证据 |
|---|---|---|
| 配置中心 | create→publish v2→rollback v1，版本/状态/审计齐全 | [`01-config-loop.txt`](./e2e-evidence/01-config-loop.txt) |
| **C1 模型注册中心** | 注册 qwen3-4b-customer/1.0.0 + 产物上传 MinIO + **预签名回环下载 HTTP 200 字节一致** + 绑定显示 2 个真 vLLM 副本 | [`02-registry-loop.txt`](./e2e-evidence/02-registry-loop.txt) |
| **C2 分层存储生命周期** | 经配置中心置短保留期 → 手动归档把 **9129 行真实 metrics_samples（~118 MiB）PG→MinIO**、PG 该表降至 0、清单 +1、冷数据 NDJSON 预签名回环 9129 行 | [`03-storage-loop.txt`](./e2e-evidence/03-storage-loop.txt) |
| **E2 RAG 反馈闭环** | 建会话→**live 流式回答**（答案精确复述 benchmark 实测 p99=3284.86ms / 119.24 tok/s）→检索引用→👍→回流数据集→**recall@1/3/5 + 逐样本 case detail**→基线历史 | [`04-rag-feedback-loop.txt`](./e2e-evidence/04-rag-feedback-loop.txt) |
| C3 实时服务拓扑 | 突发流量后 `/topology/graph` 出**真 QPS 加权**边：client→控制面 0.88 qps、控制面→ai-service、控制面→serving 网关 | [`05-topology-loop.txt`](./e2e-evidence/05-topology-loop.txt) |
| **D1 全链路 trace** | 一条 `/api/ai/chat:stream` 在 Tempo 出 **37-span 跨服务瀑布**（go-control-plane→ai-service，traceparent 串联，token 流式呈阶梯） | [`06-trace-waterfall.txt`](./e2e-evidence/06-trace-waterfall.txt) |

> 语料严格限基准日志（ROADMAP 验收）：rebuild-index 只灌 `benchmark_runs`，所有 kb 文档 `category=benchmark` / `source_uri=benchmark_runs/*`，见 04。

---

## 2. K8s 写闭环（Stage 2，受 `k8sWriteGuard` 守卫）

| 闭环 | 关键结果 | 证据 |
|---|---|---|
| **A1 真实 rollout + 自动回滚** | good image (v1→v2) 滚动成功；**bad image → k8s ProgressDeadlineExceeded → 自动回滚上一版**，2 条审计（`rollout.failed` + `rollout.rolledback`），**零停机**；ns 守卫对 aibrix-system 返回 403 | [`07-a1-rollout.txt`](./e2e-evidence/07-a1-rollout.txt) |
| **A2 真实 scale + HPA CRUD** | 手动 scale demo-echo 2→4→2；HPA upsert/delete **真建真删**（kubectl 实证）；守卫对 aibrix-system **和** serving 名 `qwen3-4b-customer`（即便在 default ns）双双 403 | [`08-a2-scale-hpa.txt`](./e2e-evidence/08-a2-scale-hpa.txt) |
| **D3 helm install 起平台** | 镜像 load 进集群 → `helm install` → **6 pods 全 Running，go-server 2/2 自迁移 fresh DB（36 表 + "migrations applied"），`/api/health` ok** | [`09-d3-helm.txt`](./e2e-evidence/09-d3-helm.txt) |

> **唯一未通过项（环境问题，非平台问题）**：A2「副本随真实负载自动伸缩」需 metrics-server。本次 `registry.k8s.io` 及 aliyun/daocloud/bitnami/rancher 各镜像源在该时段全部 EOF/超时，且一次半截拉取污染了 docker 的内容寻址 blob（后续按 digest 跳过 → 空镜像，只有 `docker restart` 能修，会拆掉正在跑的整套栈，故不做）。HPA/scale 写路径本身已联调通过。详见 08 的 A2.5。

---

## 3. Live LLM 闭环（Stage 3，真 Qwen3-4B）

| 闭环 | 关键结果 | 证据 |
|---|---|---|
| **E1 agentic 诊断（真 tool_calls）** | vLLM 开 `--enable-auto-tool-choice --tool-call-parser qwen3_coder` 后，Qwen3-4B 发起**结构化 tool_calls**；`/ai/diagnose:agent` 走 **live 多轮**（recent_metrics→recent_deployments→open_incidents→kubernetes_pods）并给出带证据的结论（还推理出"qps/p99=0 与所述高延迟矛盾，疑似历史快照"，confidence 0.8） | [`10-e1-agent-toolcalls.txt`](./e2e-evidence/10-e1-agent-toolcalls.txt) |
| **E2 反馈重排 A/B** | 积累真 👍 后开 `RAG_RERANK_FEEDBACK`，同一 query `'p95 ttft serving'` 下被赞文档由 **raw cosine #3/#4 被净分加权顶到 reranked #1/#2**；离线 `/rag/eval` 仍用 raw 检索避免泄漏 | [`11-e2-rerank-ab.txt`](./e2e-evidence/11-e2-rerank-ab.txt) |
| **E3 多副本灰度 + 影子** | 经 AIBrix 多副本网关跑加权 canary **80/20（stable 18 / canary 2）** + **影子镜像全量 20/20**（主路不受影响）+ **promote→canary 100%**（promote 后 12 个请求全进 canary，stable 不再进） | [`12-e3-canary-shadow.txt`](./e2e-evidence/12-e3-canary-shadow.txt) |

---

## 4. 联调中真实发现并修复的 bug

**agent live 多轮在「强制最终结论」步 422（`agent diagnose failed: upstream error`）。** 开启 vLLM 工具调用后，agent 循环第一次真正走到"不带工具、只要结论"的收口步；此步 Go 的 `aiclient.AgentStepRequest.Tools`（nil 切片，无 `omitempty`）被序列化成 `"tools": null`，被 ai-service 的 Pydantic（`List[AgentTool]` 非 Optional）判 `422 list_type`。此前工具调用没开、循环永远在第 1 步就用 stub 收口，故从未触发。

**修复**：`server/internal/aiclient/client.go` 给 `Tools` 字段加 `omitempty`（与既有 `MaxTokens/Temperature` 一致）——nil 时省略字段，服务端用默认空列表。修后 E1 走通 live 多轮。

附带的平台改进（已留在仓库）：vLLM 部署清单 `deploy/aibrix/vllm-qwen35-4b-deployment.yaml` 加了 `--enable-auto-tool-choice --tool-call-parser qwen3_coder`（agentic 诊断所需）。

---

## 5. 怎么复跑

```bash
# 1) serving 栈（先起，把 minikube + AIBrix + 2×vLLM 拉起）
bash scripts/run_aibrix_4b_stack.sh
# 2) 控制面 + 可观测（compose；联调期临时开 k8s 写 / 重排 / 影子，公共演示请关）
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 \
  docker compose -f deploy/compose/docker-compose.yml --profile observability up -d
# 3) 逐条证据脚本的命令都在 docs/e2e-evidence/*.txt 顶部可见，curl --noproxy '*' 直打 :8081/api
```
