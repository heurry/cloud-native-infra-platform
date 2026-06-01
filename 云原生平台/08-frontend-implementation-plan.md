# 08 前端分阶段实施技术文档

## 1. 文档目标

本文档用于指导云原生 AI 设施平台前端后续实施，重点解决三个问题：

- 明确每个阶段必须实施哪些能力。
- 明确哪些内容暂缓实施，避免页面和导航过早膨胀。
- 规定实现注意事项、验收标准和质量门禁。

当前前端基线：

- `App.tsx` 只保留平台壳、页面挂载、页面缓存和旧 URL 映射。
- 核心页面已拆分到 `apps/web/src/pages/`。
- 默认视觉方向为浅色企业级控制台，局部深色仅用于拓扑、日志、指标和证据块。
- 右侧 `AI Copilot` 已常驻，但仍需要上下文感知。

## 2. 总体实施原则

### 2.1 必须坚持

- 平台定位必须围绕 **云原生 AI Infra 控制平面**，不是普通 CRUD 后台，也不是纯监控大屏。
- 页面必须体现闭环：`资源状态 -> 指标证据 -> 风险判断 -> 建议动作 -> 验证结果`。
- 先做深现有页面，再新增一级菜单。
- `App.tsx` 不再承载业务页面代码，只做路由挂载和平台壳。
- 页面组件、数据适配、通用 UI 原语要分层维护。
- 默认浅色控制台，不做全局深色主题。

### 2.2 暂不实施

- 暂不新增独立 `Storage`、`Metadata`、`Autoscaling` 一级菜单。
- 暂不做完整拖拽式拓扑编辑器。
- 暂不做真实执行型运维操作，例如真实扩容、回滚、删除 Pod。
- 暂不把所有 mock 数据一次性替换为后端数据。
- 暂不引入大型状态管理库，除非页面间状态共享明显失控。

### 2.3 不允许

- 不允许把新页面继续写回 `App.tsx`。
- 不允许为了展示效果堆静态卡片但没有平台语义。
- 不允许 Copilot 在所有页面展示同一条固定告警。
- 不允许新增无明确工作流价值的一级导航。
- 不允许表格、卡片、按钮在三栏布局下挤压、重叠或横向溢出。

## 3. 阶段划分

## Phase 0：前端结构基线与设计约束

状态：已基本完成，后续持续维护。

### 需要实施

- 保持 `App.tsx` 轻量化，只负责：
  - 顶部栏、左侧导航、主工作区、右侧 Copilot。
  - 页面挂载和页面缓存。
  - 旧 URL 到新页面的兼容映射。
- 所有业务页面放在 `apps/web/src/pages/`。
- 通用组件放在 `apps/web/src/components/`。
- 通用类型放在 `apps/web/src/types/`。
- 通用格式化、API、工具函数放在 `apps/web/src/lib/`。

### 注意事项

- 新增页面前先判断是否可以并入现有页面。
- 样式可以继续使用 `styles.css`，但新增大模块时应加清晰区块注释。
- 后续可逐步拆分 CSS，但不作为当前阶段阻塞项。

### 验收标准

- `npm run build` 通过。
- `App.tsx` 不出现页面级业务逻辑。
- 新增页面能够在三栏布局下正常展示。

## Phase 1：Dashboard 平台总览重构

目标：让首页从普通数据看板升级为云原生 AI Infra 总览。

### 需要实施

- 新增 `Platform Health` 区域：
  - Health Score
  - Active Services
  - Active Models
  - Kubernetes Cluster Status
  - GPU Resource Health
  - Incident Count
  - Deployment Success Rate
- 强化 `Service & Model Topology`：
  - API Gateway
  - Service Mesh / Ingress
  - Business Services
  - Model Gateway
  - Router
  - vLLM Replicas
  - Redis / Vector Store / Model PVC
  - Config Center
  - Observability Stack
- 新增 `AI Serving Runtime`：
  - Active Models
  - Running Replicas
  - GPU Utilization
  - TTFT P95
  - Decode Tokens/s
  - KV Cache / Prefix Cache
  - Queue Length
  - Router Strategy
- 新增 `Ops Loop`：
  - Alert
  - Evidence
  - Diagnosis
  - Action
  - Verification
  - Report

### 注意事项

- 首页第一屏必须说明平台价值，不能只是堆指标。
- KPI 卡片必须可点击跳转到对应页面。
- 拓扑图要表达业务服务、模型服务和基础设施组件的关系。
- Ops Loop 先做只读展示，不做真实执行。

### 验收标准

- 用户进入首页能立即看出平台是 AI Infra 控制平面。
- 首页至少能跳转到 `Services`、`Kubernetes`、`Observability`、`AI Ops`、`Pipelines`。
- 没有 5+1、4+1 这类明显空洞的 KPI 排版。

## Phase 2：Model Serving 与服务治理强化

目标：让 Model Serving 页面体现生产级 LLM Serving 管理能力。

### 需要实施

- 增加模型服务生命周期信息：
  - Model Name
  - Version
  - Runtime
  - Serving Engine
  - Deployment Mode
  - Replica Count
  - Canary / Stable
  - Rollout Status
  - SLO Policy
- 增加 AI Serving 指标：
  - TTFT P50 / P95 / P99
  - TPOT
  - Decode Tokens/s
  - Prompt Tokens/s
  - Queue Length
  - Batch Size
  - KV Cache Hit Rate
  - Prefix Cache Hit Rate
  - GPU Utilization
  - Error by Model
- 增强 Router Governance：
  - Primary Strategy
  - Fallback Strategy
  - Canary Percentage
  - Traffic Split
  - Retry Policy
  - Timeout Policy
  - Circuit Breaker
  - Rate Limit
  - Load Shedding

### 注意事项

- 该页面应优先表现 AI Serving，而不是普通服务列表。
- 关键指标要和 `Observability`、`Benchmarks` 保持命名一致。
- 治理策略先做只读配置视图，后续再接真实变更接口。

### 验收标准

- 页面能回答：哪个模型正在服务、由哪个 runtime 承载、SLO 是否健康、路由策略是什么。
- 至少展示一个模型版本到 serving runtime 的绑定关系。
- 不出现大量空值或无解释的 `0` 指标。

## Phase 3：右侧 AI Copilot 上下文感知

目标：让右侧面板从固定提示变成当前页面的诊断辅助。

### 需要实施

按页面生成不同内容：

| 页面 | Copilot 内容 |
| --- | --- |
| Dashboard | 平台整体风险、关键异常、最近事件、建议优先级 |
| Model Serving | TTFT、P95、Tokens/s、vLLM replica 健康、路由风险 |
| Kubernetes | Pod restart、Pending、Node pressure、HPA、GPU 调度 |
| Observability | 趋势异常、Trace 入口、指标解释、关联资源 |
| AI Ops | 当前诊断阶段、证据链、建议动作、审批状态 |
| Config | 配置 Diff、影响范围、回滚建议、审计风险 |
| Pipelines | 发布失败、SLO Gate、Benchmark Gate、Rollback 建议 |
| Models | 模型版本风险、Serving Binding、评测结果、回滚目标 |
| Knowledge | Index Freshness、证据覆盖率、Runbook 缺口 |
| Benchmarks | Regression、SLO Pass/Fail、Release Blocking Reason |

### 注意事项

- Copilot 内容必须由当前 `page` 决定，不再全局固定一条 warning。
- Copilot 先使用前端静态策略生成，不阻塞后端接口。
- 文案要短，优先展示风险、证据、动作，不写说明书。
- 后续接入 `/api/ai/diagnose` 时保持展示结构不变。

### 验收标准

- 切换页面时 Copilot 标题、风险摘要、指标和建议动作同步变化。
- 每个页面至少有一个与当前页面强相关的建议动作。
- 没有所有页面共用同一个 `payment latency up` 的情况。

## Phase 4：Kubernetes 云原生控制平面增强

目标：让 Kubernetes 页面从 Pod 表格升级为集群运行控制面。

### 需要实施

- 增加 `Cluster Overview`：
  - Cluster
  - Namespace
  - Node Pool
  - Runtime
  - Kubernetes Version
  - Ingress Controller
  - Service Mesh
  - StorageClass
  - GPU Nodes
  - Autoscaler Status
- 增加 `Workload Health` 字段：
  - Desired / Ready / Available
  - Restart Trend
  - Resource Requests / Limits
  - HPA Status
  - Image Version
  - Last Deployment
  - Owner
  - SLO Impact
- 增加 `Kubernetes Events`：
  - Warning Events
  - OOMKilled
  - CrashLoopBackOff
  - Pending
  - ImagePullBackOff
  - FailedScheduling
  - NodePressure
- 增加 `GPU Scheduling`：
  - GPU Node
  - GPU Model
  - Allocated / Free GPU
  - GPU Memory
  - Pod to GPU Mapping
  - Pending GPU Workloads

### 注意事项

- Kubernetes 页面必须服务于 AI Ops 诊断，Events 和 GPU 调度是重点。
- 表格字段多时必须横向滚动在表格内部完成，不能撑破主布局。
- HPA、GPU 等数据可先用前端 mock，但字段结构要贴近未来 API。

### 验收标准

- 页面能回答：集群是否健康、哪些 workload 影响 SLO、GPU 是否成为瓶颈。
- 至少有一个 Events 区域和一个 GPU Scheduling 区域。
- Copilot 能基于 Kubernetes 页面展示对应风险。

## Phase 5：AI Ops 诊断工作台升级

目标：把 AI Ops 从文本诊断页面升级为可审计的诊断闭环工作台。

### 需要实施

- 增加诊断流程状态：
  - Detected
  - Evidence Collected
  - Root Cause Identified
  - Action Suggested
  - Human Approved
  - Applied
  - Verified
- 增加结构化 `Action Plan`：
  - Action Name
  - Risk
  - Expected Impact
  - Command Preview
  - Approval Status
  - Execute / Rollback 占位按钮
- 增加 `Evidence Graph`：
  - 指标异常
  - Trace 证据
  - Config 变更
  - Kubernetes Event
  - Benchmark 结果
  - Root Cause
- 增加诊断报告摘要：
  - Incident ID
  - Impact
  - Root Cause
  - Action Taken
  - Verification Result

### 注意事项

- Execute / Rollback 先做不可执行占位或 disabled 状态，避免误导为真实操作。
- Evidence Graph 可以先用静态节点和连线，不引入复杂图编辑库。
- 诊断内容必须结构化，避免大段自然语言堆叠。

### 验收标准

- 页面能清楚展示一次故障从发现到验证的完整链路。
- 至少 3 个 Action Plan 卡片。
- 每个 Action 都要有风险、预期影响和验证方式。

## Phase 6：Config / Pipelines / Benchmarks 闭环增强

目标：把配置、发布、压测从孤立页面串成发布门禁闭环。

### 需要实施

Config：

- Environment
- Namespace
- Config Type
- Version Diff
- Approval Status
- Rollout Strategy
- Impacted Services
- Rollback Preview
- Drift Detection

Pipelines：

- Pipeline Run Timeline
- Commit ID
- Image Tag
- Config Version
- Model Version
- Canary Result
- SLO Check
- Rollback Status
- RAG Index Rebuild
- Evaluation Gate
- Benchmark Gate

Benchmarks：

- Baseline Version
- Candidate Version
- Regression Result
- SLO Pass / Fail
- Latency Comparison
- Throughput Comparison
- Cost per 1K tokens
- GPU Efficiency
- Release Blocking Reason

### 注意事项

- 这三个页面的数据命名必须一致，例如 `model_version`、`config_version`、`benchmark_run_id`。
- Benchmarks 不只是压测工具，要明确它是发布门禁。
- Pipeline 不只是普通 CI/CD，要包含模型、RAG、SLO、Benchmark。

### 验收标准

- 用户能从 Pipeline 看出某次发布关联了哪个模型、配置和 Benchmark。
- Benchmark 页面能展示 baseline 与 candidate 对比。
- Config 页面能展示变更影响范围和回滚预览。

## Phase 7：Knowledge / Models 治理增强

目标：把知识库和模型注册表升级为 AI Ops 证据治理与模型治理中心。

### 需要实施

Knowledge：

- Corpus Overview
- Index Build Status
- Chunk Count
- Embedding Model
- Vector Store
- Retrieval Latency
- Recall / Hit Rate
- Source Freshness
- Evidence Usage
- Runbook Coverage
- Failed Retrieval Cases

知识分类必须至少包括：

- Runbooks
- Kubernetes YAML
- Config History
- Incident Reports
- Benchmark Reports
- Service Docs
- Demo Data

Models：

- Model Version Lineage
- Artifact Location
- Runtime Compatibility
- Quantization Type
- Context Length
- Runtime Profile
- Evaluation Score
- Safety Policy
- SLO Profile
- Deployment Binding
- Rollback Target
- Owner
- Approval Status

### 注意事项

- Knowledge 不是普通文档管理，要体现它是 AI Ops 的证据来源。
- Models 不是模型列表，要体现模型版本、运行时绑定和上线门禁。
- 不新增 Metadata 一级菜单前，模型和知识相关元数据先在这两个页面体现。

### 验收标准

- Knowledge 页面能回答：哪些证据源可用、索引是否新鲜、是否被诊断使用。
- Models 页面能回答：哪个模型版本可上线、绑定哪个 runtime、是否通过 gate。

## Phase 8：Storage / Metadata / Autoscaling 能力显性化

目标：在不立即新增一级菜单的前提下，先把三类平台能力展示出来。

### 需要实施

Storage 先分散展示：

- Dashboard：Layered Storage 总览。
- Models：Model Store、Artifact、PVC、Object Store。
- Knowledge：Vector Store、Index、Embedding。
- Observability：Log Store、Metric Store。

Metadata 先分散展示：

- Services：Service Metadata、Owner、Dependency。
- Models：Model Metadata、Runtime Binding、Lineage。
- Config：Config Metadata、Version、Impact。
- Pipelines：Deployment Metadata、Commit、Image、Artifact。

Autoscaling 先分散展示：

- Kubernetes：HPA / KEDA / GPU pending workloads。
- Model Serving：Replica Recommendation、Queue-based Scaling。
- Observability：TTFT / Queue / GPU 触发信号。
- AI Ops：Scale Action Plan。

### 暂缓新增一级菜单的判断标准

只有当以下任一条件成立时，才考虑新增独立页面：

- 单类能力在 3 个以上页面重复出现且信息无法统一。
- 用户需要在一个页面完成跨资源查询。
- 后端已经提供独立 API 聚合能力。
- 页面复杂度超过现有页面承载能力。

### 验收标准

- 分层存储、元数据管理、弹性扩缩容不再只停留在文案里。
- 现有页面能够分别承载这些能力的最小可用视图。

## 4. 数据与接口实施要求

### 4.1 前端数据策略

- 第一阶段允许使用前端 mock 数据，但必须接近目标 API DTO。
- 所有 mock 数据必须集中在页面顶部或独立 `mock` 文件，避免散落在 JSX 中。
- API 不可用时可以 fallback 到 demo snapshot，但页面要有真实字段结构。
- 不能为了视觉效果制造无法解释的数据。

### 4.2 建议接口分组

- Overview：`/api/platform/overview`
- Services：`/api/services`
- Model Serving：`/api/model-serving/*`
- Kubernetes：`/api/kubernetes/*`
- Observability：`/api/metrics/current`、`/api/metrics/history`、`/api/metrics/requests`
- AI Ops：`/api/ai/diagnose`
- Config：`/api/configs/*`
- Pipelines：`/api/pipelines/*`
- Benchmarks：`/api/benchmarks/*`
- Knowledge：`/api/knowledge/*`
- Models：`/api/models/*`

### 4.3 DTO 命名注意事项

- 延迟统一用 `latency_ms`、`ttft_ms`、`tpot_ms`。
- 版本统一用 `model_version`、`config_version`、`image_tag`。
- 门禁统一用 `gate_status`、`slo_status`、`benchmark_status`。
- 资源归属统一用 `namespace`、`owner`、`environment`、`cluster`。
- 风险统一用 `severity`、`risk_level`、`impact_scope`。

## 5. UI 实现注意事项

### 5.1 布局

- 主工作区必须适配左侧导航和右侧 Copilot 同时存在的宽度。
- 卡片网格不能出现明显空洞，例如 5+1、4+1。
- 宽表格必须在表格容器内滚动，不能撑破主布局。
- 页面内部尽量避免再做固定右侧 aside，因为全局已有 Copilot。
- 移动端先保证单列可读，右侧 Copilot 可隐藏或下沉。

### 5.2 信息密度

- 控制台页面应信息密度适中，避免营销式大卡片。
- 标题、指标、表格、操作区要有明确层级。
- 页面说明文字要少，功能要通过结构表达。
- 空状态要说明为什么为空，以及下一步动作。

### 5.3 视觉

- 默认浅色企业控制台。
- 深色仅用于拓扑、日志、代码、证据块、局部图表。
- 色彩表示必须稳定：
  - Success：健康、通过、运行中。
  - Warning：风险、待确认、降级。
  - Danger：失败、不可用、阻塞发布。
  - Neutral：未知、草稿、未配置。

### 5.4 交互

- KPI 卡片应支持跳转。
- 表格行应支持选中后显示详情。
- 详情优先使用抽屉、内联详情或下方详情区，不再随意新增页面。
- 真实执行类按钮必须明确 disabled、preview 或 approval 状态。

## 6. 工程质量门禁

每个阶段完成后必须执行：

- `npm run build`
- 截图检查至少两个宽度：
  - desktop：`1440px`
  - narrow desktop：`1180px` 或接近三栏临界宽度
- 检查右侧 Copilot 下是否遮挡主内容。
- 检查页面是否出现横向溢出。
- 检查最长文本是否撑破按钮、卡片、表格列。

建议截图页面：

- Dashboard
- Model Serving
- Kubernetes
- Observability
- AI Ops
- 当前阶段改动页面

## 7. 实施顺序建议

推荐顺序：

1. Dashboard 平台总览重构。
2. Copilot 上下文感知。
3. Model Serving 强化。
4. Kubernetes 控制平面增强。
5. AI Ops 诊断工作台升级。
6. Config / Pipelines / Benchmarks 闭环增强。
7. Knowledge / Models 治理增强。
8. Storage / Metadata / Autoscaling 能力显性化。

原因：

- Dashboard 和 Copilot 是平台第一印象，最能改变“普通后台”的观感。
- Model Serving 和 Kubernetes 是云原生 AI Infra 的核心资源面。
- AI Ops 是智能运维价值的核心，但需要前面页面提供足够证据。
- Config、Pipelines、Benchmarks 适合在资源与诊断信息更完整后串联成门禁闭环。

## 8. 当前下一步任务

下一步建议直接进入 Phase 1：

- 重构 `PlatformOverviewPage`。
- 增加 `AI Serving Runtime` 区域。
- 增加 `Ops Loop` 区域。
- 强化拓扑图中的 AI Gateway、Router、vLLM、Redis、Vector Store、Config Center。
- 修正 Dashboard KPI 为稳定两行或三列布局。
- 让 Dashboard 下的 Copilot 展示平台总览风险，而不是固定通用告警。

完成 Phase 1 后再进入 Copilot 上下文感知和 Model Serving 强化。
