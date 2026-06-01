  # 云原生平台前端样例图复刻完整改造计划

  ## Summary

  将现有前端改造成 /screenshots/example 下样例图一致的控制台体验，同时保持“Go 后端作为唯一入口”的架构：Go 已原生实现的控制面能力直接使用 /api/*，尚未迁移的 AI Ops Copilot、知识库、压测、模型目录等能力继续通过 Go 的 legacy proxy 透传。最终效果是一个面向云原生微服务与模型服
  务场景的分布式基础设施管理平台，而不是普通管理后台。

  成功标准：

  - 12 个页面的布局、导航、信息密度、卡片样式、右侧面板、表格与图表区域对齐样例图。
  - 页面数据优先来自 Go 后端真实接口；样例图中后端暂缺的数据用集中 snapshot 补齐，不散落硬编码。
  - 核心操作仍可用：配置发布/回滚、流水线触发/完成/回滚、服务健康检查、AI 诊断、知识库搜索、压测启动。
  - 1440、1366、1180 三类宽度下无重叠、无明显错位。

  ## Backend Contract

  前端统一通过现有 apps/web/src/lib/api.ts 请求 Go 入口，运行方式为：

  cd apps/web
  VITE_PROXY_TARGET=http://127.0.0.1:8081 npm run dev

  Go 原生接口：

  - /api/health
  - /api/platform/overview
  - /api/service-instances
  - /api/service-instances/{name}/healthcheck
  - /api/kubernetes/pods
  - /api/kubernetes/deployments
  - /api/kubernetes/snapshot
  - /api/metrics/current
  - /api/metrics/history
  - /api/metrics/requests
  - /api/config/items
  - /api/config/items/{id}/versions
  - /api/config/items/{id}/rollback
  - /api/deployments
  - /api/deployments/{id}/finish
  - /api/deployments/{id}/rollback
  - /api/incidents
  - /api/incidents/{id}
  - /api/incidents/{id}/ack
  - /api/incidents/{id}/resolve
  - /api/audit/events
  - /api/ai/diagnose
  - /api/ai/diagnoses
  - /api/ai/diagnoses/{id}
  - /api/ai/chat:stream

  Go legacy proxy 继续承接：

  - /api/aiops/*
  - /api/knowledge/*
  - /api/benchmarks/*
  - /api/models/*
  - /api/proxy/*
  - /api/chat/*
  - /api/evals/*

  前端原则：

  - 不直接请求旧 Java、Python 单体或 AI 服务地址。
  - 缺失字段先在前端派生或 snapshot 补齐。
  - 只有无法从现有 Go API 组合得到的关键业务字段，才规划追加 Go DTO。

  ## Information Architecture

  导航按样例图重排为能力域，不再按当前阶段式分组展示。

  固定菜单：

  - 平台总览：/dashboard
  - 模型服务：/services
  - Kubernetes：/kubernetes
  - 可观测性：/observability
  - AI Ops：/ai-ops
  - 配置中心：/config
  - 发布流水线：/pipelines
  - 压测验证：/benchmarks
  - 模型注册：/models
  - 知识库/RAG：/knowledge
  - Demo 应用：/demo-apps
  - 设置：/settings

  全局布局：

  - 左侧 sidebar：约 216px，深色/浅色按样例图风格统一，展示平台 Logo、菜单、当前环境。
  - 顶部 topbar：高度约 56px，包含全局搜索、快捷键提示、环境选择、告警入口、用户头像。
  - 中心内容区：页面标题、摘要说明、KPI 区、主分析区、表格/详情区。
  - 右侧洞察面板：约 320-340px，默认展示 AI Copilot、风险摘要、推荐动作或页面上下文信息。
  - 响应式：>=1360px 使用三栏；1180-1359px 压缩右侧面板；<1180px 右侧面板改抽屉或折叠入口。

  ## Shared UI System

  新增或整理统一组件，避免每页单独拼样式。

  核心组件：

  - MetricCard：指标卡，支持数值、单位、趋势、状态色、sparkline。
  - StatusBadge：统一 healthy、warning、critical、running、success、failed、unknown。
  - ConsoleTable：统一控制台表格，支持密集行高、状态列、操作列、空态。
  - FilterToolbar：搜索、环境、命名空间、状态、时间范围筛选。
  - RightInsightPanel：右侧 Copilot/建议/上下文面板。
  - MiniChart：折线、面积、柱状、环形小图。
  - TopologyView：服务拓扑、调用链、依赖边。
  - StageFlow：流水线阶段、压测阶段、诊断阶段。
  - PageHeader：标题、说明、刷新、主操作按钮。
  - EmptyState / ErrorState / LoadingSkeleton：统一加载、异常、空数据。

  样式统一：

  - 页面背景使用浅灰控制台底色。
  - 卡片圆角控制在 8px 左右，避免过度圆润。
  - 表格使用紧凑行距、弱分割线、状态色点。
  - 图表颜色使用多色业务语义，不做单一蓝紫渐变主题。
  - 按钮修复现有 --accent HSL 元组导致的无效背景问题。
  - 修复配置中心、流水线等页面表格列数与 CSS grid 列定义不一致问题。

  ## Data Strategy

  新增集中展示数据层，例如 apps/web/src/data/platformSnapshots.ts。

  数据优先级：

  1. Go API 真实返回。
  2. 从真实数据派生的展示字段。
  3. 集中 snapshot 默认值。
  4. 页面空态/不可用态。

  禁止：

  - 不在 JSX 中散落样例图数字。
  - 不在每个页面重复维护 mock。
  - 不让页面感知旧服务地址。

  建议封装：

  - usePlatformOverviewData
  - useServiceGovernanceData
  - useKubernetesConsoleData
  - useObservabilityData
  - useAIOpsData
  - useConfigConsoleData
  - usePipelineConsoleData
  - useBenchmarkData
  - useKnowledgeData

  这些 hook 负责 API 请求、字段派生、snapshot merge、错误降级。

  ## Page-by-Page Plan

  ### 1. 平台总览

  对齐 image.png。

  改造内容：

  - 顶部 KPI：平台健康度、服务数、模型实例、K8s 工作负载、GPU 使用率、活跃事件、发布成功率。
  - 主区展示告警概览、资源使用趋势、服务实例表。
  - 右区展示 AI Copilot、快速入口、最近发布、7 日趋势。
  - 数据来自 /api/platform/overview、/api/metrics/current、/api/deployments、/api/incidents。
  - 缺失的 7 日趋势从 /api/metrics/history 派生，不足时 snapshot 补齐。

  ### 2. 模型服务

  对齐 image copy.png。

  改造内容：

  - KPI：在线服务、健康实例、P95、QPS、错误率、GPU 使用。
  - 主表：服务名、版本、实例、状态、延迟、QPS、资源、操作。
  - 中部展示服务拓扑和 SLO 概览。
  - 右侧 Copilot 展示风险服务、扩容建议、健康检查结果。
  - 数据来自 /api/service-instances、/api/metrics/current、健康检查 POST。
  - 当前 ModelsPage 与 ServicesPage 职责要拆清：模型服务负责运行实例，模型注册负责模型资产。

  ### 3. Kubernetes

  对齐 image copy 2.png。

  改造内容：

  - KPI：集群健康、节点、Pod、Deployment、CPU、内存、GPU。
  - 主区展示资源使用图、节点状态、工作负载表。
  - 事件区展示最近 K8s event 或 agent 不可用提示。
  - 右侧展示集群信息、命名空间分布、资源建议。
  - 数据来自 /api/kubernetes/snapshot，必要时补充 /api/kubernetes/pods 和 /api/kubernetes/deployments。
  - available=false 时不破坏布局，显示降级状态。

  ### 4. 可观测性

  对齐 image copy 3.png。

  改造内容：

  - KPI：P95、P99、QPS、错误率、活跃 trace、告警数。
  - 筛选条：服务、环境、时间范围、状态码。
  - 主图：延迟趋势、当前指标、服务概览。
  - 下方：慢请求 Top 5、错误分布、实时告警。
  - 右侧 Copilot 展示异常解释和跳转 AI Ops 诊断按钮。
  - 数据来自 /api/metrics/current、/api/metrics/history、/api/metrics/requests、/api/incidents。

  ### 5. AI Ops

  对齐 image copy 4.png。

  改造内容：

  - KPI：活跃故障、平均恢复时间、诊断成功率、建议采纳率。
  - 主区：故障事件表、根因分析、证据链、推荐动作。
  - 诊断输入走 /api/ai/diagnose。
  - 历史记录走 /api/ai/diagnoses。
  - 详情走 /api/ai/diagnoses/{id}。
  - 事件状态操作走 /api/incidents/{id}/ack 和 /api/incidents/{id}/resolve。
  - 右侧面板优先接 /api/ai/chat:stream，兼容 /api/aiops/* 旧会话。

  ### 6. 配置中心

  对齐 image copy 5.png。

  改造内容：

  - KPI：配置项、命名空间、待发布、回滚次数、最近变更。
  - 顶部 tabs：配置列表、版本历史、审计事件、灰度发布。
  - 表格：key、环境、namespace、类型、版本、状态、更新人、更新时间、操作。
  - 详情抽屉：内容、版本 diff、发布、回滚。
  - 数据来自 /api/config/items、/api/config/items/{id}/versions、/api/audit/events?resourceType=config_item。
  - 保留现有新增配置、发布版本、回滚版本交互。
  - 修复当前表格列数和操作按钮换行问题。

  ### 7. 发布流水线

  对齐 image copy 6.png。

  改造内容：

  - KPI：今日发布、成功率、运行中、失败、回滚。
  - 主表：应用、版本、环境、状态、开始时间、结束时间、操作者、操作。
  - 展示环境分布、发布趋势、阶段日志、发布详情。
  - 数据来自 /api/deployments。
  - 触发发布走 POST /api/deployments。
  - 完成发布走 POST /api/deployments/{id}/finish。
  - 回滚走 POST /api/deployments/{id}/rollback。
  - metadata 中的阶段信息若不存在，用 snapshot 展示阶段流。

  ### 8. 压测验证

  对齐 image copy 7.png。

  改造内容：

  - KPI：压测任务、最大 QPS、P95、错误率、SLO 通过率。
  - 主表：任务、模型/服务、并发、状态、开始时间、结果。
  - 图表：基线对比、吞吐趋势、延迟分布、SLO Gate。
  - 操作：启动压测、查看事件、查看结果。
  - 数据优先走 Go legacy proxy：/api/benchmarks/*。
  - 如果 legacy 不可用，展示样例图结构和不可用提示，不阻塞整体控制台。

  ### 9. 模型注册

  对齐 image copy 8.png。

  改造内容：

  - 从当前“服务实例视图”调整为“模型资产目录”。
  - KPI：模型数、已部署、可回滚版本、评测通过率。
  - 主表：模型、版本、框架、大小、状态、关联服务、更新时间、操作。
  - 右侧展示模型详情、部署建议、兼容性检查。
  - 数据优先走 /api/models/* legacy proxy；缺失时用 snapshot。
  - 与模型服务页建立跳转关系：模型资产 -> 运行服务。

  ### 10. 知识库/RAG

  对齐 image copy 9.png。

  改造内容：

  - KPI：文档数、向量块、索引健康、检索命中率。
  - 主表：文档、来源、状态、chunk 数、更新时间、操作。
  - 检索测试区：输入 query，展示 top-k 命中、分数、片段。
  - 右侧展示索引健康、重建索引、RAG 建议。
  - 数据走 /api/knowledge/documents、/api/knowledge/search、/api/knowledge/rebuild-index。
  - legacy 不可用时展示结构化不可用态。

  ### 11. Demo 应用

  对齐 ChatGPT Image 2026年5月31日 17_55_56.png。

  改造内容：

  - 顶部 tabs：全部、LLM 服务、RAG、可观测、AI Ops。
  - 特色应用卡片：状态、入口、关联模型、部署环境。
  - 应用表：名称、场景、服务、健康、最近访问、操作。
  - 右侧展示应用详情、统计、快速动作。
  - 数据以 snapshot 为主，可关联 /api/service-instances 和 /api/deployments 派生状态。

  ### 12. 设置

  对齐 image copy 10.png。

  改造内容：

  - 页面不使用普通 Copilot，而是设置专用右侧状态栏。
  - 主区 tabs：平台配置、集群接入、AI 服务、通知、权限、审计。
  - 右侧：平台状态、使用统计、快捷动作。
  - 展示 Go API、Agent、AI 服务、legacy proxy 的连接状态。
  - 数据来自 /api/health、必要时探测核心接口。
  - 暂无真实权限系统时保持只读配置展示，不伪造真实登录能力。

  ## File-Level Implementation Notes

  主要修改区域：

  - apps/web/src/App.tsx：调整 shell、右侧面板策略、页面缓存结构。
  - apps/web/src/components/layout/AppSidebar.tsx：重建导航。
  - apps/web/src/components/layout/PlatformTopBar.tsx：对齐样例图顶部栏。
  - apps/web/src/components/layout/AICopilotPanel.tsx、AIOpsCopilotPanel.tsx：统一右侧面板形态并接 Go AI API。
  - apps/web/src/components/common/*：沉淀 KPI、表格、图表、状态、抽屉等组件。
  - apps/web/src/pages/*Page.tsx：逐页重排。
  - apps/web/src/styles.css：全局布局、设计 token、响应式、页面样式。
  - apps/web/src/types/*：补齐 Go DTO 与页面展示类型。
  - apps/web/src/data/*：新增集中 snapshot 和派生工具。

  不建议改动：

  - 不改 api.ts 的基本行为，除非需要增强错误信封解析。
  - 不为复刻样式改 Go 路由。
  - 不把样例图中的展示数字直接写进页面 JSX。

  ## Implementation Order

  ### Phase 1：全局壳层和设计系统

  - 重写 sidebar 导航为能力域。
  - 调整 topbar 为样例图布局。
  - 建立三栏 console shell。
  - 新增通用 KPI、表格、状态、右侧面板、图表组件。
  - 完成全局颜色、间距、圆角、字体和响应式规则。

  验收：

  - 所有页面共用同一壳层。
  - 页面切换不跳动。
  - 右侧面板宽度一致。
  - sidebar 当前态清晰。

  ### Phase 2：核心观测页面

  - 改造平台总览。
  - 改造模型服务。
  - 改造 Kubernetes。
  - 改造可观测性。
  - 接入 Go 原生只读 API 和 snapshot merge。

  验收：

  - 4 个页面在后端可用时展示真实数据。
  - agent 不可用时 Kubernetes 页面布局仍完整。
  - 指标图和表格与样例图信息结构一致。

  ### Phase 3：治理与操作页面

  - 改造 AI Ops，接入 /api/ai/* 和 /api/incidents/*。
  - 改造配置中心，保留新增、发布、回滚。
  - 改造发布流水线，保留触发、完成、回滚。
  - 统一审计事件展示。

  验收：

  - 写操作成功后能刷新页面数据。
  - 错误请求显示统一错误态。
  - 表格操作列不挤压、不换行错位。

  ### Phase 4：扩展能力页面

  - 改造压测验证。
  - 改造模型注册。
  - 改造知识库/RAG。
  - 改造 Demo 应用。
  - 改造设置页。
  - legacy proxy 不可用时展示清晰降级。

  验收：

  - 所有样例图对应页面都完成视觉对齐。
  - 页面功能边界清晰，不把未实现能力伪装成已实现生产能力。

  ### Phase 5：截图回归和精修

  - 启动 Go 后端和前端。
  - 用 Playwright 截取 12 个页面桌面截图。
  - 输出到 screenshots/after。
  - 与 screenshots/example 逐页对比布局、密度、视觉层级。
  - 修复错位、重叠、文本溢出、图表空白、响应式问题。

  ## Test Plan

  构建检查：

  cd apps/web
  npm run build

  前端运行：

  cd apps/web
  VITE_PROXY_TARGET=http://127.0.0.1:8081 npm run dev

  截图检查：

  - /dashboard
  - /services
  - /kubernetes
  - /observability
  - /ai-ops
  - /config
  - /pipelines
  - /benchmarks
  - /demo-apps
  - /settings

  功能检查：

  - 平台总览能加载 /api/platform/overview。
  - 模型服务健康检查按钮能请求 Go 后端。
  - Kubernetes agent 不可用时显示降级而非白屏。
  - 可观测性筛选不破坏图表和表格。
  - AI Ops 可提交诊断并展示历史。
  - 配置中心可新增配置、发布版本、回滚版本。
  - 发布流水线可触发、完成、回滚。
  - 知识库、压测、模型注册在 legacy 不可用时有统一错误态。
  - 设置页能显示 Go API 健康状态。

  响应式检查：

  - 1440px：完整三栏。
  - 1366px：右侧面板略收缩，主表仍可读。
  - 1180px：内容不重叠，必要时横向滚动表格。
  - 移动宽度不是本轮主要目标，但不能出现不可恢复白屏。

  ## Acceptance Criteria

  - 样例图 12 个页面都有对应实现。
  - 页面第一屏视觉结构与样例图一致：左导航、顶部栏、KPI、主图/表、右侧面板。
  - 后端真实数据优先展示，mock/snapshot 只作为补齐。
  - 所有核心 API 错误都有可见反馈。
  - npm run build 通过。
  - 生成 screenshots/after 后可用于人工对比评审。
  - 没有明显文本溢出、按钮错位、表格列错乱、卡片嵌套卡片、图表空白问题。

  ## Assumptions

  - 当前项目已经切换到 Go 后端，Go 服务默认监听 :8081。
  - 前端只需要配置到 Go 后端，不再单独配置 Java 后端。
  - aiops / knowledge / benchmarks / models 仍允许通过 Go legacy proxy 透传。
  - 本次目标是前端复刻和体验升级，不强制完成所有后端能力迁移。
  - 样例图中的具体数值可作为 demo snapshot，不作为真实生产指标。
  - 不引入重量级新图表库，优先用现有依赖、CSS 和轻量 SVG 实现。
