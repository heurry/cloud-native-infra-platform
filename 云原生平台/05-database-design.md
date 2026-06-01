# 05 数据库设计

## 1. 设计目标

目标数据库使用 **PostgreSQL**，MVP 本地演示可降级为 SQLite。

设计目标：

- 支撑平台元数据、模型服务治理、Kubernetes 资源快照、配置版本、RAG、请求追踪、Benchmark、Incident 和审计。
- 保留当前 SQLite 原型中的 `service_instances`、`request_traces`、`documents`、`benchmark_runs` 等概念。
- 数据模型以平台控制面为核心，不绑定某一个业务 Demo。
- JSONB 用于存放可变 metadata，但核心查询字段必须结构化。

## 2. 表组总览

```text
Identity / Audit
  users
  audit_events

Platform Metadata
  applications
  platform_services
  service_dependencies

Kubernetes
  clusters
  namespaces
  k8s_resources
  k8s_events

Model Serving
  models
  model_adapters
  service_instances
  routing_policies

Config / Deployments
  config_items
  config_versions
  deployments

Observability
  request_traces
  metrics_samples
  incidents
  incident_events

Knowledge / RAG
  knowledge_versions
  knowledge_documents
  knowledge_chunks

Benchmarks / Evaluation
  benchmark_runs
  benchmark_samples
  eval_runs
```

## 3. 核心表设计

### 3.1 users

MVP 只做 actor 记录预留，不实现完整账号体系。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| username | varchar(128) | 用户名 |
| display_name | varchar(128) | 展示名 |
| role | varchar(64) | admin / operator / viewer |
| created_at | timestamptz | 创建时间 |

### 3.2 audit_events

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| actor_id | varchar(128) | 操作者 |
| actor_role | varchar(64) | 操作角色 |
| action | varchar(128) | 操作名 |
| resource_type | varchar(64) | 资源类型 |
| resource_id | varchar(128) | 资源 ID |
| metadata | jsonb | 操作上下文 |
| created_at | timestamptz | 创建时间 |

索引：

- `(resource_type, resource_id, created_at desc)`
- `(actor_id, created_at desc)`

### 3.3 applications

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| app_key | varchar(128) | 应用唯一标识 |
| name | varchar(128) | 应用名称 |
| owner | varchar(128) | 负责人 |
| env | varchar(32) | dev / staging / prod |
| description | text | 描述 |
| metadata | jsonb | 扩展信息 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 3.4 platform_services

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| app_id | uuid | 所属应用 |
| service_key | varchar(128) | 服务标识 |
| name | varchar(128) | 服务名称 |
| namespace | varchar(128) | Kubernetes namespace |
| service_type | varchar(64) | api / worker / model-serving / gateway |
| status | varchar(32) | healthy / warning / failed / unknown |
| metadata | jsonb | 扩展信息 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 3.5 service_dependencies

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| source_service_id | uuid | 上游服务 |
| target_service_id | uuid | 下游服务 |
| dependency_type | varchar(64) | http / grpc / db / cache / model |
| metadata | jsonb | 调用信息 |
| created_at | timestamptz | 创建时间 |

## 4. Kubernetes 表组

### 4.1 clusters

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| cluster_key | varchar(128) | 集群标识 |
| name | varchar(128) | 集群名称 |
| provider | varchar(64) | local / minikube / eks / ack |
| region | varchar(64) | 区域 |
| status | varchar(32) | active / unavailable |
| metadata | jsonb | 扩展信息 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 4.2 namespaces

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| cluster_id | uuid | 集群 ID |
| name | varchar(128) | namespace 名称 |
| status | varchar(32) | active / terminating |
| labels | jsonb | labels |
| updated_at | timestamptz | 更新时间 |

### 4.3 k8s_resources

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| cluster_id | uuid | 集群 ID |
| namespace | varchar(128) | namespace |
| kind | varchar(64) | Pod / Deployment / Service / Endpoint |
| name | varchar(256) | 资源名 |
| status | varchar(64) | phase 或聚合状态 |
| ready | varchar(32) | ready 摘要 |
| restarts | integer | 重启数 |
| node_name | varchar(128) | 节点 |
| pod_ip | inet | Pod IP |
| labels | jsonb | labels |
| raw | jsonb | 原始资源摘要 |
| observed_at | timestamptz | 采集时间 |

索引：

- `(cluster_id, namespace, kind, name)`
- `(kind, status, observed_at desc)`

### 4.4 k8s_events

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| cluster_id | uuid | 集群 ID |
| namespace | varchar(128) | namespace |
| resource_kind | varchar(64) | 关联资源类型 |
| resource_name | varchar(256) | 关联资源名 |
| reason | varchar(128) | 事件原因 |
| message | text | 事件内容 |
| type | varchar(32) | Normal / Warning |
| event_time | timestamptz | 事件时间 |

## 5. Model Serving 表组

### 5.1 models

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| model_id | varchar(128) | OpenAI-compatible model id |
| display_name | varchar(128) | 展示名 |
| base_model | varchar(256) | 基座模型 |
| artifact_uri | text | 模型路径或对象存储 URI |
| tokenizer_uri | text | tokenizer 路径 |
| status | varchar(32) | draft / ready / serving / archived |
| metadata | jsonb | 参数、上下文长度、量化信息 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 5.2 model_adapters

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| model_id | uuid | 关联模型 |
| adapter_id | varchar(128) | adapter 标识 |
| adapter_type | varchar(64) | runtime / prompt / routing |
| artifact_uri | text | adapter 路径 |
| status | varchar(32) | ready / serving / archived |
| metadata | jsonb | 任务类型和评测摘要 |
| created_at | timestamptz | 创建时间 |

### 5.3 service_instances

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| name | varchar(128) | 实例名 |
| base_url | text | OpenAI-compatible endpoint |
| model_id | varchar(128) | 服务模型 |
| kind | varchar(64) | vllm / aibrix / auto_router / client_round_robin |
| gpu_id | varchar(64) | GPU 或 gateway 标识 |
| routing_role | varchar(64) | replica / gateway / auto_router |
| status | varchar(32) | healthy / unreachable / unknown |
| last_checked_at | timestamptz | 最近健康检查 |
| metadata | jsonb | target_instances、策略等 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 5.4 routing_policies

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| policy_key | varchar(128) | 策略标识 |
| service_instance_id | uuid | 关联 router |
| strategy | varchar(64) | least-request / prefix-cache / least-kv-cache |
| weight | integer | 权重 |
| conditions | jsonb | 路由条件 |
| status | varchar(32) | active / inactive |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

## 6. Config / Deployments 表组

### 6.1 config_items

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| app_id | uuid | 应用 ID |
| env | varchar(32) | dev / staging / prod |
| namespace | varchar(128) | namespace |
| config_key | varchar(256) | 配置 key |
| config_type | varchar(64) | yaml / properties / json |
| active_version | integer | 当前版本 |
| status | varchar(32) | active / inactive |
| created_by | varchar(128) | 创建人 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

唯一约束：

- `(app_id, env, namespace, config_key)`

### 6.2 config_versions

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| config_item_id | uuid | 配置项 |
| version | integer | 版本号 |
| content | text | 配置内容 |
| change_reason | text | 变更原因 |
| operator | varchar(128) | 操作者 |
| status | varchar(32) | draft / active / rolled_back |
| created_at | timestamptz | 创建时间 |

### 6.3 deployments

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| service_id | uuid | 服务 ID |
| deployment_key | varchar(128) | 部署标识 |
| version | varchar(128) | 发布版本 |
| env | varchar(32) | 环境 |
| status | varchar(32) | running / success / failed / rolled_back |
| started_at | timestamptz | 开始时间 |
| finished_at | timestamptz | 结束时间 |
| metadata | jsonb | 镜像、commit、pipeline 等 |

## 7. Observability 表组

### 7.1 request_traces

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| request_id | varchar(128) | 请求 ID |
| session_id | varchar(128) | 会话 ID |
| endpoint_id | varchar(128) | endpoint |
| target_pod | varchar(256) | 目标 pod |
| model_id | varchar(128) | 模型 |
| retrieval_ms | numeric | 检索耗时 |
| ttft_ms | numeric | 首 token 时间 |
| generation_ms | numeric | 生成耗时 |
| total_ms | numeric | 总耗时 |
| input_tokens | integer | 输入 token |
| output_tokens | integer | 输出 token |
| status | varchar(32) | ok / error / timeout |
| error | text | 错误信息 |
| metadata | jsonb | 引用文档、路由原因等 |
| created_at | timestamptz | 创建时间 |

索引：

- `(created_at desc)`
- `(endpoint_id, created_at desc)`
- `(target_pod, created_at desc)`
- `(status, created_at desc)`

### 7.2 metrics_samples

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | bigserial | 主键 |
| source | varchar(128) | 来源 |
| metrics | jsonb | 指标快照 |
| created_at | timestamptz | 采集时间 |

### 7.3 incidents

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| title | varchar(256) | 事件标题 |
| severity | varchar(32) | info / warning / critical |
| status | varchar(32) | open / investigating / resolved |
| related_service_id | uuid | 关联服务 |
| summary | text | 摘要 |
| diagnosis_id | uuid | 关联 AI 诊断 |
| created_at | timestamptz | 创建时间 |
| resolved_at | timestamptz | 解决时间 |

### 7.4 incident_events

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| incident_id | uuid | 事件 ID |
| event_type | varchar(64) | metric / log / config / action |
| payload | jsonb | 事件内容 |
| created_at | timestamptz | 创建时间 |

## 8. Knowledge / RAG 表组

### 8.1 knowledge_versions

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| version | varchar(128) | 主键 |
| description | text | 说明 |
| status | varchar(32) | active / archived |
| created_at | timestamptz | 创建时间 |

### 8.2 knowledge_documents

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| doc_id | varchar(128) | 业务文档 ID |
| title | varchar(256) | 标题 |
| content | text | 原文 |
| category | varchar(128) | 类别 |
| version | varchar(128) | 知识库版本 |
| source_uri | text | 来源 |
| metadata | jsonb | 扩展信息 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 8.3 knowledge_chunks

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| document_id | uuid | 文档 ID |
| chunk_index | integer | chunk 序号 |
| content | text | chunk 内容 |
| embedding_ref | text | 向量库引用或本地索引 ID |
| token_count | integer | token 数 |
| metadata | jsonb | 扩展信息 |
| created_at | timestamptz | 创建时间 |

## 9. Benchmarks / Evaluation 表组

### 9.1 benchmark_runs

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| run_id | varchar(128) | 压测 ID |
| endpoint_id | varchar(128) | endpoint |
| workload | varchar(128) | workload |
| routing_strategy | varchar(64) | 路由策略 |
| status | varchar(32) | queued / running / success / failed |
| config | jsonb | 压测配置 |
| summary | jsonb | 汇总结果 |
| report_path | text | 报告路径 |
| error | text | 错误 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 9.2 benchmark_samples

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | bigserial | 主键 |
| run_id | varchar(128) | 压测 ID |
| event_type | varchar(64) | 事件类型 |
| payload | jsonb | 样本或事件 |
| created_at | timestamptz | 创建时间 |

### 9.3 eval_runs

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| run_id | varchar(128) | 评测 ID |
| model_id | varchar(128) | 模型 |
| dataset | varchar(128) | 数据集 |
| status | varchar(32) | running / success / failed |
| metrics | jsonb | 评测指标 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

## 10. MVP 边界

- PostgreSQL 是目标设计；本地演示允许 SQLite。
- MVP 可先不实现外键强约束，但字段命名必须和目标模型一致。
- 向量数据不直接存 PostgreSQL，表中只保留 `embedding_ref`。
- 审计字段先记录 actor 和 action，不实现完整 RBAC。
- Customer Support 的业务表不纳入平台核心 schema，只作为 Demo Apps 独立表组。

## 11. 验收标准

- 表设计覆盖平台元数据、模型服务、Kubernetes、配置、观测、RAG、Benchmark、Incident、Audit。
- 当前原型中的关键数据：documents、service_instances、request_traces、benchmark_runs 都有目标迁移表。
- 数据模型支持 AI Ops 诊断所需证据链。
- PostgreSQL 与 SQLite MVP 降级关系清晰。
