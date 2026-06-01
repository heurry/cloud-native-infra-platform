# 04 UI / UX 设计

## 1. 设计目标

平台 UI 定位为 **浅色企业级云原生 AI Infra 控制台**，局部使用深色观测组件。

设计目标：

- 让复杂的模型服务、Kubernetes 资源、指标、配置和诊断证据变得可理解。
- 优先服务运维和平台工程工作流，而不是做展示型大屏。
- AI 功能嵌入资源上下文，不只是孤立聊天页。
- 信息密度高但层级清晰，适合反复使用和快速定位问题。

## 2. 视觉原则

默认主题：

```text
整体：浅色企业控制台
背景：#F5F7FB
Surface / Card：#FFFFFF
Border：#E5E7EB
Text Primary：#111827
Text Secondary：#64748B
Primary：#2563EB
Success：#16A34A
Warning：#D97706
Error：#DC2626
Radius：6px ~ 8px
```

局部深色区域：

```text
适用：Metrics Chart、Service Topology、Log Viewer、YAML Preview、AI Evidence Block
Background：#0B1120
Surface：#111827
Border：#263244
Text Primary：#E5E7EB
Text Secondary：#94A3B8
```

不采用全局默认深色大屏风格。深色只用于增强可观测性、日志、拓扑和代码类内容的可读性。

## 3. 页面骨架

标准布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ Top Bar: Global Search | Env | Namespace | Notice | User     │
├───────────────┬──────────────────────────────────┬───────────┤
│ Left Sidebar  │ Main Workspace                   │ Right     │
│               │                                  │ Panel     │
│ Overview      │ Page Header                      │ AI Copilot│
│ Model Serving │ KPI Cards                        │ Details   │
│ Kubernetes    │ Charts / Tables / Topology       │ Evidence  │
│ Observability │ Resource List                    │ Actions   │
│ AI Ops        │                                  │           │
└───────────────┴──────────────────────────────────┴───────────┘
```

布局要求：

- 左侧导航宽度 220px ~ 260px。
- 顶部栏高度 52px ~ 60px。
- 主工作区使用 12 栏或 CSS grid。
- 右侧面板默认可折叠，宽度 320px ~ 420px。
- 移动端优先隐藏右侧面板，导航折叠为 drawer。

## 4. 信息架构

主导航：

```text
Overview
Model Serving
Kubernetes
Observability
AI Ops
Knowledge / RAG
Benchmarks
Config / Deployments
Demo Apps
Settings
```

导航规则：

- `Overview` 是默认首页。
- `Demo Apps` 收纳 Customer Support，不在主工作流中置顶。
- `AI Ops` 是诊断工作台，`Chat` 不再作为单独泛聊天入口命名。
- `Models` 与服务实例合并到 `Model Serving`，避免模型元数据和推理治理割裂。

## 5. 核心页面设计

### 5.1 Overview

第一屏结构：

```text
Page Header: Platform Overview
KPI Row:
  Health Score | Running Services | Active Alerts | K8s Pods | Deployments | P95 Latency

Main Grid:
  Service Topology / Model Serving Map
  Resource Usage Trends
  AI Diagnosis Summary

Bottom:
  Recent Incidents
  Recent Benchmarks
  Risk Services
```

交互：

- KPI 卡片可点击跳转。
- AI Diagnosis Summary 可展开证据。
- Risk Services 点击进入 AI Ops 或服务详情。

### 5.2 Model Serving

页面结构：

```text
Header: Model Serving
Filters: search, kind, status, model, routing role
Table:
  Name | Kind | Model | Routing Role | GPU | Status | P95 | TTFT | Last Checked | Actions
Right Drawer:
  Basic Info
  Routing Policy
  Recent Metrics
  Upstream Distribution
  Healthcheck Result
  AI Diagnose
```

状态展示：

- healthy / running：绿色。
- warning / degraded：黄色。
- unreachable / failed：红色。
- unknown：灰色。

### 5.3 Kubernetes

页面结构：

```text
Header: Kubernetes
Namespace Selector
KPI Row: Pods | Deployments | Nodes | CPU | Memory
Tabs: Workloads | Pods | Deployments | Services | Events
Resource Table
Detail Drawer
```

详情抽屉：

- metadata、labels、phase、ready、restarts。
- container statuses。
- recent events。
- related service instance。
- AI Diagnose 按钮。

### 5.4 Observability

页面结构：

```text
Header: Observability
Time Range + Refresh
KPI Row: QPS | Error Rate | P95 | TTFT | tokens/s | GPU Memory
Charts:
  Request Rate
  Error Rate
  P95 / P99 Latency
  TTFT
  GPU / CPU / Memory
Tables:
  Request Traces
  Endpoint Stats
  Target Pod Stats
  vLLM Metrics
```

局部深色组件：

- 折线图面板可以使用深色背景。
- 日志和 trace payload 使用深色代码块。

### 5.5 AI Ops

页面结构：

```text
Left: Diagnosis History / Input
Center: Diagnosis Report
Right: Evidence / Tool Calls / Actions
```

诊断报告格式：

```text
Problem Summary
Root Cause
Evidence
Impact
Recommended Actions
Confidence
Related Resources
```

交互：

- 从任何资源页点击 AI Diagnose 时，AI Ops 自动携带上下文。
- 用户可追加问题。
- 证据卡片能跳回对应资源、trace、config、benchmark。

### 5.6 Knowledge / RAG

页面结构：

```text
Header: Knowledge / RAG
Document Table
Search Panel
Create / Edit Drawer
Index Status
```

交互：

- 搜索结果展示 score、category、version、source。
- 文档内容长文本使用分段预览。
- 重建索引显示状态和文档数量。

### 5.7 Benchmarks

页面结构：

```text
Header: Benchmarks
Create Benchmark Form
Run Table
Run Detail
Report Summary
Event Stream
```

结果展示：

- 并发级别趋势。
- QPS、TTFT、P95/P99、tokens/s。
- target pod / upstream distribution。
- error samples。

### 5.8 Config / Deployments

页面结构：

```text
Tabs: Configurations | History | Deployments | Events
Config Table
Version History
Deployment Timeline
Detail Drawer
```

交互：

- 查看配置版本 diff。
- 查看变更原因。
- 从 AI Ops 证据跳转到配置变更。

## 6. 组件规范

标准组件：

- Metric Card
- Status Badge
- Resource Table
- Detail Drawer
- Right AI Copilot Panel
- Time Series Chart
- Service Topology Graph
- Log Viewer
- YAML Preview
- Diagnosis Report
- Evidence Card
- Pipeline / Deployment Timeline
- Benchmark Report Table

按钮规范：

- 图标按钮优先使用 lucide icon。
- 危险操作必须使用红色强调并二次确认。
- `AI Diagnose` 使用主色按钮，放在异常状态附近。

表格规范：

- 支持搜索、过滤、排序、分页。
- 行点击打开右侧详情抽屉。
- 状态字段必须使用 Badge。
- 长字段使用省略和 tooltip。

## 7. MVP 边界

- 不做完整主题切换系统，默认浅色即可。
- 不做拖拽式自定义 Dashboard。
- 不做复杂动画和炫酷大屏。
- 不做完整移动端功能，只保证可读和基础操作。
- 不把 AI 聊天作为唯一入口，必须服务资源上下文。

## 8. 验收标准

- 全局默认是浅色企业控制台。
- Observability、Logs、Topology、YAML、Evidence 可使用深色局部面板。
- 主导航与 MVP 范围一致。
- Overview 能承载第一屏演示。
- AI Ops 能展示结构化诊断报告和证据链。
- Customer Support 进入 Demo Apps，不抢占平台主流程。
