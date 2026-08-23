# Kubeflow 分布式训练落地方案 / KUBEFLOW TRAINING PLAN

> 目标读者：本项目（云原生 LLM 基础设施管理控制面）维护者。
> 本文是**设计文档（不含实现）**，沿用 `docs/ROADMAP.md` 的五要素约定（目标 → 做法 → 工作量 → 验收 → 风险）。
> 核对基线（2026-06-09）：仓库**零训练代码**（无 kubeflow/pytorchjob/torchrun/deepspeed/fsdp）；Go workspace = `agent` + `server`；`model/` 下有 Qwen3-1.7B / Qwen3.5-4B 本地权重；模型注册中心 C1 已实现且字段为训练产物预留。

---

## 0. 背景与目标

当前平台是「serving + 管理 + 观测 + AI 分析」的控制面，MLOps 链路**从"注册"开始**——模型产物凭空出现（手动上传到 C1）。本方案补上链路最前端的「训练」，形成完整闭环：

```
训练(Kubeflow Training Operator)
   → 注册(C1 模型注册中心：版本/血缘/LoRA/产物→MinIO)
   → 服务(vLLM/AIBrix)
   → 观测(D1 OTel/Prometheus)
   → 评测(E2 RAG/recall)
   → 灰度/回滚(A1 rollout / E3 canary)
```

**核心判断**：控制面编排层很好加（与现有 client-go CRD 读写、`deploy_runner` 异步轮询、`k8sWriteGuard` 安全模型、C1 产物落库**同款套路**）；真·分布式训练执行难点在**硬件/规模（GPU、多节点）**，不在平台代码。作品集策略 = 把真实编排做实 + 用小 LoRA 微调真跑通留证 + 诚实标注"规模化分布式受单节点/GPU 共享限制"。

---

## 1. 现状契合点（这功能往哪插）

| 复用的既有能力 | 文件锚点 | 在本方案的角色 |
|---|---|---|
| client-go CRD 读写模式 | `server/internal/k8s/client.go` | 新增 PyTorchJob 的 CRUD/watch 照此模式 |
| 异步执行 + 进度写 metadata + 轮询回写 | `server/internal/httpx/deploy_runner.go` | 训练 job 的 runner 直接镜像这套（相位/进度/成败回写 + 审计） |
| 双重安全写守卫（flag + 命名空间允许名单 + serving 硬禁） | `server/internal/httpx/k8s_write_handlers.go` `k8sWriteGuard` | 训练写操作复用同款守卫（新 `ALLOW_TRAINING` flag） |
| 模型注册中心（版本/血缘/LoRA/产物→MinIO/绑定） | `server/internal/httpx/model_registry_handlers.go` + `types/registry.ts` | 训练成功的天然 sink：自动注册新版本、血缘指回 base |
| 对象存储 Put/预签名 | `server/internal/blob/minio.go` | 数据集读入 / adapter 产物落库 |
| 发布流水线"实时相位+进度条"前端 | `apps/web/src/pages/PipelinesPage.tsx`（RolloutProgress） | 训练任务页的 live 进度 UX 直接照搬 |
| sqlc→store→dto 分层 + 迁移编号 | `server/internal/db/migrations/`（最后是 `000011_routing_policies`） | 新增 `000012_training_jobs` |

**结论**：C1 的字段 `base_model / lora_adapter / parent_version(血缘) / artifact_uri(MinIO) / tags` 正是训练产物的形状——集成点几乎是为它预留的。

---

## 2. 架构决策

1. **只装 Kubeflow Training Operator（standalone），不上全家桶**。CRD 用 `PyTorchJob`（`kubeflow.org/v1`）。避免 Istio + Pipelines + Katib 的重量，且不与现有 CI/CD(A1)、评测(E2/B2) 职责重叠。
2. **控制面用 dynamic client + unstructured 操作 PyTorchJob**（`k8s.io/client-go/dynamic`），不引入 training-operator 的大依赖树。在 `internal/training` 里做一层薄的 typed 映射（`TrainingJobSpec` / `TrainingJobStatus`），与 `k8s.Collector` 把资源映射成 `*Snapshot` 同理。
   - 备选：引入 `github.com/kubeflow/training-operator/pkg/apis` 用 typed client（类型更干净，但依赖重）。**推荐 dynamic**，demo 阶段更轻。
3. **新增 `internal/training` 包**（与 `internal/k8s`、`internal/serving` 平行），不污染 k8s 包。
4. **新 workload 类型，命名空间隔离**：训练跑在允许写的命名空间（如 `training`），serving 命名空间（aibrix/envoy/vllm/qwen）仍由 `guardNamespace` 的保护子串**硬禁**——训练永远碰不到推理栈。
5. **训练镜像**：Python 容器（HF Transformers + PEFT/LoRA + `torchrun` 入口），从 MinIO 拉数据集、把 LoRA adapter 写回 MinIO。可独立于 ai-service（职责分离）。
6. **GPU 争用是头号现实约束**：训练与 serving 抢同一批卡。demo 策略 = 训练前把某个 vLLM 副本 scale 到 0（复用 A2 的 `ScaleDeployment`）腾卡，训练完再扩回；或上 NVIDIA time-slicing。**单节点 minikube 上"分布式"= 单机多 worker**，真多节点 DDP/FSDP 需要现在没有的多节点集群。

---

## 3. 数据模型（新迁移 `000012_training_jobs`）

```
training_jobs
  id              uuid pk
  name            text
  framework       text            -- 'pytorch'（PyTorchJob）
  base_model      text            -- 如 Qwen3-1.7B（来自 model/ 或 C1）
  dataset_uri     text            -- MinIO key（指令微调数据集）
  workers         int             -- worker 副本数（>=1）
  gpus_per_worker int
  hyperparams     jsonb           -- lr / epochs / lora_rank / lora_alpha ...
  status          text            -- pending|running|succeeded|failed|cancelled
  k8s_job_ref     text            -- namespace/name 指向 PyTorchJob
  output_artifact_uri text        -- 成功后的 LoRA adapter MinIO key
  model_version_id    uuid null   -- 成功后回写 C1 注册的版本 id（FK 语义）
  metadata        jsonb           -- 相位/进度/replica 状态/事件日志（同 deployments.metadata）
  created_by      text
  created_at / updated_at
```
sqlc 查询：list / get / insert / update-status / set-progress / set-output。

---

## 4. 分阶段落地（每阶段可独立演示）

### T0 — Training Operator + 控制面 plumbing 【S-M】
- **目标**：集群装上 Training Operator；控制面能 CRUD/watch PyTorchJob。
- **做法**：`deploy/kubeflow/` 加 Training Operator 安装清单（standalone manifest 或 helm）；`internal/training/client.go`：dynamic client + `SubmitJob/GetJob/WatchJob/DeleteJob`，unstructured ↔ 薄 typed 映射；新 config `ALLOW_TRAINING`(默认关) + `TRAINING_NAMESPACES` 允许名单，复用 `guardNamespace` 逻辑。
- **工作量**：S-M。
- **验收**：`kubectl get pytorchjobs` 可见控制面创建的 job；集群不可达/operator 未装时优雅降级（不阻塞启动，同 k8s.Collector）。
- **风险**：Training Operator 镜像在受限网络拉不下来（同此前 metrics-server 的坑）——预拉/换源。

### T1 — 训练 job 生命周期 + DB（记录态可跑，无需 GPU）【M】
- **目标**：提交/列表/详情/日志/取消训练任务，状态真实回写。
- **做法**：迁移 `000012_training_jobs` + sqlc + store；`training_handlers.go`：`POST /api/training/jobs`、`GET /api/training/jobs`、`GET /api/training/jobs/{id}`、`GET /api/training/jobs/{id}/logs`、`DELETE /api/training/jobs/{id}`；`training_runner.go`（镜像 `deploy_runner.go`）：建 PyTorchJob → goroutine 轮询 status（Created→Running→Succeeded/Failed + replica 状态）→ 进度写 `metadata`；写操作过 `ALLOW_TRAINING` 守卫 + 审计（`training.submit/succeed/fail/cancel`）+ worker/gpu 上限校验（防打爆集群）。
- **工作量**：M。
- **验收**：提交假/轻量 job → 列表实时显示相位+进度；取消生效；成败真实回写；守卫 403（未开 flag / serving 命名空间）。
- **风险**：低（不依赖 GPU 即可演示编排）。

### T2 — 训练镜像 + 真实 LoRA 微调（GPU 约束）【M】
- **目标**：在真 GPU 上跑通一次 LoRA 微调。
- **做法**：`deploy/training/Dockerfile`（HF Transformers + PEFT + `torchrun` 入口，从 MinIO 拉数据集、写 adapter 回 MinIO）；准备一个小指令微调数据集（与客服/RAG 主题一致）；用 Qwen3-1.7B（本地有权重）跑单 GPU LoRA；若有第 2 张卡，跑 2-worker DDP。训练前 scale 掉一个 vLLM 副本腾卡（复用 A2 `ScaleDeployment`），训练后扩回。
- **工作量**：M（受 GPU 约束）。
- **验收**：PyTorchJob 真跑到 Succeeded，adapter 落 MinIO，留证到 `docs/e2e-evidence/`（沿用现有留证风格）。
- **风险**：GPU 争用 / 显存不足 / 数据集质量；单节点 = 非真多节点。

### T3 — 闭合到 C1（训练→注册自动化）【S】
- **目标**：训练成功自动注册成可服务的模型版本。
- **做法**：runner 在 Succeeded 时调 `RegisterModelVersion`（model_id、version、base_model、lora_adapter=产物、parent_version=base 形成血缘、artifact_uri=MinIO key、tags=["trained"]）+ 审计；回填 `training_jobs.model_version_id`。注册后该 adapter 即可被 E3 canary / A1 rollout 消费。
- **工作量**：S。
- **验收**：一次训练 → 模型注册页自动出现新版本（血缘指回 base、产物可预签名下载）→ 可直接拿去 serve/灰度。**全链路闭环 demo**。
- **风险**：低。

### T4 — 前端「模型训练」页【M】
- **目标**：露出训练能力（避免又"做了没露出"）。
- **做法**：新增导航项「模型训练」；提交抽屉（base model 选择器：本地权重 / C1 版本；数据集；workers/gpus；超参）；任务列表带 live 相位+进度条（轮询 `/training/jobs`，照搬 `PipelinesPage` 的 RolloutProgress）；日志面板；"完成→已注册版本"链接跳模型注册页。逻辑收敛到 `lib/useTraining.ts`，视图入 `components/training/`（遵循 elegant-structure 约定）。
- **工作量**：M。
- **验收**：前端提交真实训练 → 实时进度 → 完成后一键跳到注册的版本。
- **风险**：低。

### T5（衔接 GPU 故障）— 训练前 GPU 健康门禁【S-M，可选】
- **目标**：呼应"GPU 节点故障诊断/恢复"现状缺口——训练调度避开不健康的 GPU/节点。
- **做法**：提交前查节点 Ready + GPU 遥测（util/温度，来自 `agent/gpu.go` + `alerts.go`），对 NotReady/过热节点不调度并给出原因；（进阶）成功路径加 cordon/uncordon 真写，把"节点级恢复"从 0 补到有。
- **工作量**：S-M（基础门禁 S；真恢复写 M）。
- **风险**：cordon/drain 是高风险写，需同款 flag + 守卫。

---

## 5. 总工作量与执行建议

- **总体 L**（约 1.5–2 周专注工时）。其中 T0/T1/T3/T4 是你已熟的 client-go 编排 + 分层 + 前端，是"易"的大头；**T2（真 GPU 跑通）是唯一的硬骨头，且卡在硬件不在代码**。
- **推荐顺序**：T0 → T1（先把记录态闭环跑通，零 GPU 即可演示）→ T4（露出）→ T2（真跑，GPU 就绪时）→ T3（闭合）→ T5（可选加分）。
- 若只为作品集快速出彩：T0+T1+T3+T4 即可演示"提交训练→注册→可服务"的完整编排闭环（T2 用一次真跑留证锦上添花）。

---

## 6. 诚实边界（写进 README/ROADMAP 的口径）

与项目既有风格一致（如 ROADMAP 的 HPA-under-load 诚实边界）：
- **真实**：训练任务编排、状态轮询、产物落库、自动注册血缘、前端可演示——全 production-grade、与现有代码同构。
- **受限**：真·规模化分布式训练受**单节点 minikube + GPU 与 serving 共享**限制，演示为单节点 1–2 卡 LoRA 微调；多节点 DDP/FSDP 需要更大集群（基础设施约束，非平台能力缺失）。

---

## 7. 安全清单（所有写操作）

- `ALLOW_TRAINING`（默认关）+ `TRAINING_NAMESPACES` 允许名单 + serving 组件硬禁（复用 `guardNamespace` 保护子串）。
- worker 数 / gpus_per_worker 上限校验（防打爆集群，同 `maxScaleReplicas`）。
- 每个写操作落审计、绑真实操作者（`a.actor`）。
- 训练镜像与 serving 镜像隔离；数据集/产物经 MinIO，不进 PG。

---

## 8. 资源与显存划分（serving 瘦身 + 训练共置）

**问题**：当前 vLLM `--gpu-memory-utilization=0.90`，启动即预占 ~90% VRAM 做 KV cache，几乎吃满显卡，训练无卡可用。

**已先行调整（本方案落地前）**：
- vLLM 显存上限 **0.90 → 0.60**，改在 `deploy/aibrix/vllm-qwen35-4b-deployment.yaml` + `configs/serve/{qwen3_4b_vllm_replica0,replica1,awq}.yaml`、`configs/serve/vllm.yaml`、`configs/serve/model_registry.yaml` 与 `scripts/serve_vllm_replica.sh` fallback。当前 4B 取 0.60 是保守值（4B fp16 权重 ~8GB，过低会 OOM）。

**目标（配合模型瘦身，Phase F 内执行）**：
- **serving 与训练统一切到 Qwen3-1.7B**（本地 `model/Qwen3-1.7B` 已有权重；4B 显存占用过大，难与训练共置）。注意：本地**没有 1.4B**，按 1.7B 处理。
- 切 1.7B 后（权重 ~3.4GB，余量充足）目标按单卡划分：
  - **serving `--gpu-memory-utilization ≈ 0.40`**
  - **训练 ≈ 0.50**（LoRA 微调显存占用小，0.5 单卡通常够）
  - **缓冲 ≈ 0.10**
  - 具体数值按实际 GPU VRAM 实测微调（16GB/24GB 卡阈值不同）。
- 切 1.7B 还需同步改：`deploy/aibrix/qwen35-4b-model-pv.yaml`（PV 路径指向 `model/Qwen3-1.7B`）、部署清单 `--model` 路径与 `--served-model-name`、`configs/serve/*.yaml` 的 `model:` 字段；命名 `qwen3-4b-customer` 可保留或随之更名（影响 C1/路由策略里引用该名的地方）。

**共置时的腾卡策略**：训练任务启动前用 A2 的 `ScaleDeployment` 把某个 vLLM 副本缩到 0 腾出整卡，训练完成扩回；或上 NVIDIA time-slicing / MPS 做软共享。单节点 minikube 上仍是单机多卡，真多节点 DDP/FSDP 需更大集群。
