# 平台升级路线图 / ROADMAP

> 面向云原生微服务场景的分布式基础设施管理平台。
> 本文档基于 2026-06-03 对当前代码（Go 控制面路由 + 各 handler + ai-service + 前端实际调用）的逐条核对结果，给出后续优化升级计划。
> 维护约定：完成一项即勾选其验收清单；新增/调整任务保持「目标 → 做法 → 工作量 → 验收 → 风险」五要素。

---

## 0. 现状基线（能力真实性矩阵）

核对方法：以 `server/internal/httpx/router.go` 的端点为锚点，逐个读对应 handler，并比对前端 `apps/web/src` 实际调用的端点。

| 宣称能力 | 真实程度 | 证据 | 诚实边界 |
|---|---|---|---|
| 配置中心 | ✅ 完整 | `router.go:69-75` 增查/发布/回滚 + 审计，PG 落库 | 真 CRUD + 版本 + 回滚，前端已接 |
| 服务治理 | ✅ 完整 | `router.go:63-67` 注册/心跳/注销/健康检查 + TTL reaper | 真服务注册表；C3 增「实时调用图」(OTel span 派生，连线粗细=真实 QPS)，serving 架构示意保留为互补视角 |
| 可观测监控 | ✅ 最强项 | `router.go:43-60` metrics/alerts/k8s 快照（client-go 直读） | 指标来自真实 AIBrix/vLLM serving 栈；告警为规则评估 |
| AI 运维分析 | ✅ 真实 + agentic（E1） | 单轮：`ai_handlers.go` Go 聚证据→LLM→落库+审计；agentic：`diagnose_agent.go` 多轮工具取证（`/ai/diagnose:agent`）+ 推理轨迹；`/ai/chat:stream` 流式 Copilot | LLM 不可达落 failed + 502；agent 无 GPU 走确定性 stub 脚本，降级诚实 |
| 分层存储 | ✅ 有生命周期（C2 已实现） | Redis 热 + PG 关系 + MinIO 对象 + pgvector；`storage_archiver.go` 把过期 metrics/audit 归档 PG→MinIO（保留期读自配置中心），`/storage/tiers\|archives` | 真冷热迁移：PG 体积随归档下降、冷数据经清单可回溯；前端「存储分层」页 |
| 元数据管理 | ✅ 独立注册中心（C1 已实现） | `models` 表版本化（version/parent_version血缘/lora/tags/artifact）；`/api/models/registry` CRUD + 产物→MinIO + 按 model_id 绑定 service_instances | 真 model registry：版本/血缘/产物/运行时绑定；前端「元数据管理」tab 接真数据 |
| CI/CD 自动化 | ✅ 真实 rollout（A1 已实现） | 给出 image → `PatchDeploymentImage` + 轮询 `RolloutStatus`（`deploy_runner.go`），成败回写 + 失败自动回滚；未给 image 仍为记录态 | 真改 Deployment 镜像 + 跟踪滚动发布；受 `ALLOW_K8S_WRITES` + 命名空间守卫约束。仍无 build/test 阶段（CD 而非完整 CI） |
| 弹性扩缩容 | ✅ 可配置（A2 已实现） | 读：`/kubernetes/hpa` HPA spec/status；写：`ScaleDeployment` / `UpsertHPA` / `DeleteHPA`（`client.go`），路由见 `router.go` | 手动扩缩 + 配/删 HPA 真写；受 `ALLOW_K8S_WRITES` + 命名空间允许名单约束，serving 命名空间硬禁 |

**已做未露（后端就绪、前端无消费）**：
- `/api/chat/sessions`（客服 RAG 会话，含 `messages:stream`、`/feedback`）—— 无前端页。
- `/api/evals/customer-support`（检索召回评测）—— 无前端页。

**跨切面（生产级，已落地）**：Redis 令牌桶限流 + 幂等键 + cache-aside、统一错误信封、审计日志、request-id、各依赖不可达透明降级、sqlc→store→dto 分层。

**总体判断**：「管理控制面 + 可观测 + AI 分析」三条线真实闭环；「自动化执行」线（CI/CD 跑流水线、主动扩缩容）是建模/观测而非执行。

---

## 通用原则（贯穿所有阶段）

- 守住既有约定：production-grade 不简化、no-placeholder（有后端才接 UI）、RAG 语料 = 基准日志（不重新引入招聘语料）、Go 单一后端、所有 K8s 写操作走 feature-flag + 可降级。
- 每个能力升级配三件套：**真实执行 + 落库审计 + 前端可演示**，否则又变成「做了没露出」。
- 工作量记号：S ≈ 1 天 / M ≈ 2-4 天 / L ≈ 1 周+。

---

## Phase A · 让「自动化执行」名副其实

### A1 — CI/CD 从「记录状态机」升级为「真实 rollout 执行器」 【L】✅ 已实现
- **目标**：触发部署真的改 minikube 中某 Deployment 的镜像并跟踪滚动发布，失败自动回滚。
- **做法**（已落地）：
  - `k8s/client.go` 增写能力：`PatchDeploymentImage`（strategic-merge 设新 image，返回旧 image 供回滚）+ `RolloutStatus`（读 observedGeneration / updated / ready / available + Progressing 条件，判定 complete/failed）。
  - 改造 `ops_handlers.go:triggerDeployment`：**给出 image 即走真实 rollout**——复用 A2 的 `k8sWriteGuard`（feature flag + 命名空间守卫，serving 命名空间硬禁），创建记录后启 goroutine（`deploy_runner.go`）调 Patch → 轮询状态（2s，超时 180s）→ 成功回写 `finishDeployment(success)`。未给 image 时保持既有「记录态」行为（向后兼容）。
  - 失败/超时路径：Patch 回旧镜像 = 自动回滚，落 `deployment.rollout.failed` + `deployment.rollout.rolledback` 两条审计。
  - 实时进度写进 `deployments.metadata`（phase/progress/ready/desired + 小事件日志），**无需迁移**——前端轮询既有 `/deployments` 列表即见进度条（`PipelineTableRow` 渲染 `RolloutProgress`，rollout 行隐藏手动 finish/rollback）。
- **验收**：
  - [x] 前端「触发真实 rollout」后列表实时显示相位 + ready/desired 进度条
  - [x] 失败/坏镜像 → 自动回滚到旧镜像 + 两条审计记录（代码路径就绪）
  - [x] rollout 成败真实回写部署记录（success/failed）
  - [ ] 真集群端到端联调（需 minikube + 一个 demo Deployment 作目标；ALLOW_K8S_WRITES + 非 serving 命名空间）
- **风险处置**：默认关写（同 A2）；目标必须是允许名单内、非 serving 的 Deployment（如 `default/demo-echo`）。

### A2 — 弹性扩缩容从「只读 HPA」升级为「配 HPA + 手动扩缩」 【M】✅ 已实现
- **目标**：平台能创建/修改/删除 HPA（min/max/目标 CPU 利用率），也能对 Deployment 直接 scale。
- **做法**（已落地）：
  - `client.go` 增 `ScaleDeployment`（scale 子资源 Get/Update）、`UpsertHPA`（AutoscalingV2 Create/Update，幂等）、`DeleteHPA`；`hpaToSnapshot` 在读/写路径共用。
  - `router.go` 增 `POST /kubernetes/deployments/{name}/scale`、`PUT /kubernetes/hpa`、`DELETE /kubernetes/hpa/{name}`。写后失效集群快照缓存、落审计（`k8s.deployment.scale` / `k8s.hpa.upsert` / `k8s.hpa.delete`）。
  - **安全写路径基建（同时给 A1 铺路）**：`ALLOW_K8S_WRITES` feature flag（默认关）+ `K8S_WRITE_NAMESPACES` 命名空间允许名单 + serving 组件（aibrix/envoy/vllm/qwen）与系统命名空间硬禁；`k8sWriteGuard` 统一校验，未开启返回 403。
  - 前端 Kubernetes 页：`snapshot.writes_enabled/write_namespaces` 驱动控件灰显；工作负载行内「弹性伸缩」按钮 → `WorkloadScaleDrawer`（手动扩缩 section + HPA 配置 section）；写逻辑收敛在 `lib/useK8sScaling.ts`。只读时显示 hint。
- **验收**：
  - [x] 手动 scale 立即生效并落审计（写后 invalidate 快照，10s 内回显）
  - [x] 配/删 HPA 幂等、落审计；HPA 状态读路径实时回显 `desired vs current`
  - [ ] 改 HPA target 后压测打流量、副本随真实负载伸缩（需 metrics-server + demo workload，留待联调）
- **风险处置**：默认不碰 AIBrix/vLLM serving 命名空间（硬禁 + 允许名单双保险）；操作对象限 `default` 等显式放行的 demo workload。

---

## Phase B · 把「已做未露」的后端变成可演示亮点（纯前端，最高性价比）

### B1 — 客服 RAG 会话前端 【M】
- **目标**：露出 `/api/chat/sessions` 全套（列表/新建/流式问答/引用来源/反馈）。
- **做法**：新增「智能客服」页（或并入知识库页）：左会话列表（`GET/POST /chat/sessions`），右流式对话（`messages:stream`，复用 `lib/api.ts` 的 SSE 客户端），展示 RAG 引用（来源 = 基准日志），消息级 👍/👎 调 `/messages/{id}/feedback`；加导航项。
- **验收**：
  - [ ] 能开会话、流式回答、看到检索引用、点反馈落库
  - [ ] 语料严格限基准日志
- **风险**：低。

### B2 — 检索召回评测前端 【S-M】
- **目标**：露出 `/api/evals/customer-support`。
- **做法**：评测页触发评测 → 轮询 `GET /evals/{run_id}` → 展示 recall@k / 命中率 / 逐条用例对错；可并入「压测验证」作第二个 tab。
- **验收**：
  - [ ] 跑一次评测看到指标卡 + 用例明细
- **风险**：低。

---

## Phase C · 把「浅/静态」的能力做深

### C1 — 元数据管理做实（独立模型注册中心） 【L】✅ 已实现
- **目标**：从「`/models` 派生自服务注册表」升级为真正的 model registry。
- **做法**（已落地）：
  - 迁移 `000009_models`：把既有（无版本、无写入方的）`models` 表升级为版本化台账——加 `version / parent_version(血缘) / lora_adapter / tags / created_by`，唯一约束改 `(model_id, version)`；sqlc 重新生成（`models.sql` 查询 + `sqlc-verify` 一致）。
  - store `ModelVersion` 领域类型 + CRUD；handlers `model_registry_handlers.go`：`GET/POST /api/models/registry`、`GET/PATCH(status)/DELETE /api/models/registry/{id}`、`POST/GET /api/models/registry/{id}/artifact`（产物 multipart→MinIO + 预签名下载）。
  - 与 `service_instances` 按 `model_id` 关联：列表/详情带 `bindings`（哪些运行实例在 serve 该 model_id）。注册重复 (model_id,version) → 409。
  - 前端：`lib/useModelRegistry.ts` + `components/registry/`（RegisterVersionDrawer + ModelRegistryPanel）；模型页「元数据管理」tab 接真注册中心，「注册模型」走真实写接口（删除原会话级占位）。
- **验收**：
  - [x] 注册模型版本 → 产物上传至 MinIO → 模型页显示版本/基座+LoRA/血缘/标签/运行时绑定
  - [x] 状态机 registered→active→deprecated + 注销；血缘链按 parent_version 回溯
  - [ ] 真栈联调：起 compose（含 MinIO）实际跑一遍注册+上传+绑定展示

### C2 — 分层存储做出「生命周期」 【M-L】✅ 已实现
- **目标**：从「按类型静态分层」升级为有冷热迁移策略。
- **做法**（已落地）：
  - 迁移 `000010_archive_manifests`（归档清单：source_table/object_key/row_count/bytes/时间范围）。
  - `storage_archiver.go`：归档 `metrics_samples` / `audit_events` 早于保留期的行——序列化 NDJSON → 上传 MinIO → 事务内删 PG + 写清单。**安全**：仅删严格早于 cutoff 的行；先上传后删；对象层不可用则跳过（绝不无对象层时删 PG）。保留期读自**配置中心 `storage.retention`**（平台用自己的配置中心管自己），缺省内置默认。周期自动归档 opt-in（`STORAGE_ARCHIVE_ENABLED`），手动 `POST /api/storage/archive` 始终可用。
  - 端点：`GET /storage/tiers`（各层占用：Redis/PG 逐表行数+物理大小/MinIO 归档聚合）、`GET /storage/archives`、`GET /storage/archives/{id}`（预签名下载）、`POST /storage/archive`。
  - 前端新增「存储分层」页：分层卡片 + 保留策略（带跳配置中心入口）+ 归档清单表（冷数据可回溯/下载）+「立即归档」。
- **验收**：
  - [x] 调短保留期 → 触发归档 → 旧数据迁 MinIO、PG 行数/体积下降、归档清单可回溯下载（SQL 在 pgvector:pg16 实测：3 老行下沉、剩 2 行、清单 +1）
  - [ ] 真栈联调：起 compose（含 MinIO）跑一次自动/手动归档看对象层增长
- **说明**：可回溯 = 经归档清单取对象层（预签名下载/NDJSON），非「透明合并进 live 查询」（后者留作增强）。

### C3 — 服务拓扑从静态示意 → 真实调用图 【L，依赖数据源】✅ 已实现
- **目标**：连线/流量来自真实数据而非写死。
- **做法**（已落地，走方案 b——借 D1 的 OTel span 派生）：
  - `obs/servicegraph.go`：自定义 `sdktrace.SpanProcessor`，`OnEnd` 时把 server span（入口→控制面）与 client span（控制面→ai-service/推理网关，经 otelhttp 传输的目标 host 归类）归并成「边」，按 60×1s 滚动桶计近 60s QPS/错误。**始终安装**（TracerProvider 无条件挂该 processor），故调用图不依赖 OTLP 导出。
  - `GET /api/topology/graph` 返回节点 + 边（边带 qps/requests/errors/total）。
  - 前端 ServicesPage 新增「实时调用图」面板：`components/topology/CallGraph.tsx` 固定分列 SVG，**连线粗细 ∝ 真实 QPS**，与上方架构示意（serving 链路）互补。
  - 单测覆盖聚合/自环忽略/滚动窗口过期。
- **验收**：
  - [x] 调用图连线粗细随真实流量变化（控制面自身 span：入口 / ai-service / 推理网关）
  - [ ] serving 栈内部（gateway→router→vLLM）边级流量——本进程 span 看不到，需 Tempo metrics-generator 或 AIBrix 边级指标（留作增强）
- **说明**：控制面不在 serving 数据路径上，故真实调用图反映的是「平台 API → 控制面 → 下游」的调用关系（真实、按流量加权），与 serving 架构示意是两个互补视角。

---

## Phase D · 生产化 / 平台工程加固

### D1 — 全链路可观测性（OpenTelemetry + Prometheus + Grafana） 【L】✅ 已实现
- **做法**（已落地）：
  - **Go 控制面**：新增 `internal/obs`——OTel TracerProvider + OTLP/HTTP 导出（env-gated，未配 `OTEL_EXPORTER_OTLP_ENDPOINT` 即 no-op，不阻塞启动）；Prometheus `/metrics`（始终开，HTTP 请求计数 + 时延直方图）。`httpx.Telemetry` 中间件建 server span（提取入站 traceparent）+ 记指标，复用 SSE-safe 的 statusRecorder（不破坏 chat:stream 流式）。
  - **出站传播**：aiclient / proxyHTTPClient(Go→vLLM) / AI 反向代理(chat:stream) 的 Transport 均包 `otelhttp.NewTransport`，注入 W3C traceparent。
  - **ai-service**：`aiservice/telemetry.py`（env-gated）——FastAPIInstrumentor 延续入站 traceparent，RequestsInstrumentor 把 span 继续传给上游 vLLM。requirements 增 otel sdk/exporter/instrumentation。
  - **infra**：`deploy/compose` 增 `observability` profile（Tempo + Prometheus + Grafana，含数据源/看板自动置备）。一行启用：`OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 docker compose --profile observability up -d`。
- **验收**：
  - [x] `/metrics` 暴露真实 HTTP 指标；Grafana「Control Plane」看板出请求速率/p95/状态码
  - [x] 代码路径就绪：Go→ai-service→vLLM 经 traceparent 串联
  - [ ] 真栈端到端联调：在 Grafana/Tempo 看到一条请求的端到端 span 瀑布（需起 observability profile + 有流量）

### D2 — 认证授权 / 多租户 RBAC 【L】
- **做法**：现状 operator 写死为 `defaultOperator`；引入 JWT/OIDC，按路由 authz（只读/写/管理员），审计 actor 绑真实身份；配置中心/部署写操作要求相应角色。
- **验收**：
  - [ ] 不同角色可见/可做范围不同，审计含真实用户

### D3 — 平台自托管（Helm/Kustomize 上 K8s） 【M-L】✅ 已实现
- **做法**（已落地，补全既有 chart 为可自托管的完整栈）：
  - **新增 web 镜像**：`apps/web/Dockerfile`（多阶段 Node 构建 → nginx）+ `nginx.conf`——nginx 提供 SPA 静态资源 + 反代 `/api` → go-server（同源，前端 `VITE_API_BASE` 留空）；`/api` 上游经 `GO_SERVER_UPSTREAM` 由 helm 注入（`NGINX_ENVSUBST_FILTER` 限定只替换该变量，保留 nginx 自身 `$host/$uri`）。SSE 关缓冲。`release.yml` 镜像矩阵加 web。
  - **chart 补全**（`deploy/helm/cloudnative-infra-platform`）：新增 `web` Deployment/Service 模板；go-server values 补齐新配置（`ALLOW_K8S_WRITES`/`K8S_WRITE_NAMESPACES`/`OTEL_*`/`STORAGE_ARCHIVE_ENABLED`，均安全默认）；新增可选 `ingress`（/api→go-server、/→web）。Chart 升 0.2.0。
  - 已有 postgres/redis/minio/rbac/agent 模板沿用；go-server 多副本无状态。
- **验收**：
  - [x] `helm lint` + `helm template` 通过（6 Deployments / 8 Services，ingress 默认关）；新配置/web 渲染正确
  - [x] web 镜像实建通过：nginx envsubst 把 `${GO_SERVER_UPSTREAM}` 替成 `proxy_pass http://...go-server:8081`，`nginx -t` 语法 OK，nginx 自身 `$host` 保留
  - [ ] `helm install` 进 minikube 端到端起平台（需集群 + 把镜像 load 进集群）

### D4 — 工程质量：e2e + 负载 + 混沌 【M】
- **做法**：补 API e2e（起真实依赖的集成测试）、关键路径负载基线、混沌实验（杀 Redis/MinIO/AI 验证降级——代码已支持降级，需测试固化）；CI 跑全套。
- **验收**：
  - [ ] CI 绿；混沌实验下平台不崩、降级路径有覆盖

---

## Phase E · AI 能力升级

### E1 — 诊断从单轮 → agentic 工具调用 【L】✅ 已实现
- **做法**（已落地，Go 编排循环 + ai-service 当 reasoner，无 Python→Go 回调）：
  - Go `diagnose_agent.go`：注册只读取证工具（`recent_metrics` / `recent_deployments` / `open_incidents` / `kubernetes_pods`，复用既有数据访问，Go 本地执行）；多轮循环（≤5 步）调 ai-service `/internal/agent-step` 问「下一步调哪个工具 / 给最终结论」，执行 tool_calls、回灌结果、累积推理轨迹，落库（轨迹存 evidence，结论存 root_cause/actions）+ 审计。`POST /api/ai/diagnose:agent`。
  - aiclient `AgentStep`；ai-service `agent.py`：live 用 OpenAI 工具调用（vLLM），stub 走确定性脚本（按 tools 依次取证→据结果复用 diagnose 规则下结论）——无 GPU 也能端到端跑 + 单测。
  - 前端 AIOps 页加「Agent 诊断」按钮 + 「推理轨迹」面板（逐步展示模型调了哪些工具 / 看到什么）。
- **验收**：
  - [x] 诊断含「模型主动查了哪些证据」的推理轨迹（多轮工具调用，stub/live 一致契约）
  - [x] stub 模式可端到端演示 + 单测（ai-service 2 个 agent 测试 + 契约 JSON 形状校验）
  - [ ] live 模型真栈联调：Qwen3 实际发起 tool_calls 的多轮取证（需 vLLM + 工具调用模板）

### E2 — RAG 评测体系 + 在线反馈回流 【M】
- **做法**：`/messages/{id}/feedback` 已有端点——把反馈回流成评测数据集/重排信号；建立离线评测指标基线（接 B2）。语料仍限基准日志。

### E3 — 模型路由 / A-B / 影子流量 【L】
- **做法**：借 AIBrix 路由做多模型/多版本灰度、影子流量对比；与 C1（版本）、A1（发布）联动，形成「注册 → 灰度发布 → 评测 → 全量/回滚」闭环。

---

## 推荐执行顺序

1. ~~**B1 + B2**（纯前端、后端已就绪）→ 立刻补上「做了没露出」，演示面最快变厚。~~ ✅ 已完成
2. ~~**A1 + A2**（CI/CD 真执行 + 扩缩容真配）→ 把宣称里最虚的两项做实。~~ ✅ 已完成（共用 `k8sWriteGuard` 安全写路径；真集群端到端联调需 demo workload）。
3. **D1（OTel）**→ 为 C3、E1 喂数据，同时是平台工程硬信号。 ← 下一步
4. **C1 / C3 / D2 / D3** 按精力推进。
5. **E 系列**作为 AI 方向纵深加分。

## 作品集视角取舍

面试展示（非长期产品）建议优先 **B（露出）+ A（执行）+ D1（trace）**，做完即可完整演示「注册 → 发布 → 观测 → AI 诊断 → 回滚」闭环；C/D/E 其余项按目标岗位侧重挑选（投平台/SRE 重 D，投 AI Infra 重 E + C1）。
