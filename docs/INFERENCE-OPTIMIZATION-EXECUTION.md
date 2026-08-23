# 云原生 LLM 推理优化执行文档

> 目标：把当前项目从“云原生基础设施控制台”推进成“云原生平台下的大模型训练微调、推理优化与 AIOps 实验平台”。近期最重要的工作是做实 **vLLM 本地推理服务的压测、Profiling、瓶颈归因和优化迭代闭环**，并让该能力能在简历、README、前端页面和真实代码中互相对得上。

---

## 1. 项目定位

本项目后续定位为：

```text
云原生平台下的大模型训练微调、推理优化与 AIOps 实验平台
```

平台覆盖三条主线：

1. **训练微调控制面**
   - 基于 Kubernetes / Kubeflow Training Operator 管理 `PyTorchJob`。
   - 支持训练任务创建、参数配置、镜像下发、状态跟踪、日志查看。
   - 训练成功后自动注册模型版本，形成“训练产物 → 模型注册中心”的闭环。

2. **推理优化工作台**
   - 基于 vLLM / AIBrix 提供 OpenAI-Compatible 推理服务。
   - 面向 1--16 并发、1K/2K 上下文长度执行压测。
   - 采集 TTFT、TPOT、端到端延迟、P95、生成吞吐、请求成功率、输出有效性、显存占用。
   - 基于 Profiling 结果归因 prefill、decode、KV cache、调度和显存瓶颈，指导下一轮 vLLM 参数优化。

3. **AIOps 诊断**
   - 聚合指标、日志、配置变更、部署事件、Kubernetes 状态和历史压测结果。
   - 近期先以规则归因 + agentic diagnosis 为主，生成故障原因、影响范围、证据链和处理建议。
   - 现有 RAG / 检索评测能力保留，但不作为本轮推理优化主线依赖。

---

## 2. 模型与数据集口径

### 2.1 模型分工

后续实现按两个模型分工推进，避免训练和推理优化目标混在一起：

| 方向 | 主模型 | 本地路径 | 用途 |
|---|---|---|---|
| 训练微调 | Qwen3.5-4B | `/mnt/nvme-data/LLM/llm_train_platform_miniv2/model/Qwen3.5-4B` | 客服场景 LoRA / SFT 微调，训练产物注册进模型中心 |
| 推理优化 | Qwen3.6-27B-FP8 | `/mnt/nvme-data/models/LLM_model/Qwen3.6-27B-FP8` | vLLM 本地推理服务压测、Profiling、瓶颈归因和参数优化 |

说明：

- `model/Qwen3.5-4B` 是项目内软链接，实际指向 `/mnt/nvme-data/models/LLM_model/Qwen3.5-4B`，本地约 8.8G。
- `Qwen3.6-27B-FP8` 本地目录存在，约 29G。推理优化阶段需要单独补 vLLM/AIBrix serving 配置，避免继续沿用 `qwen3-4b-customer` 的旧命名造成误解。
- 该资产的发布名和本地 README 是 `Qwen3.6-27B-FP8`，但当前 `config.json` 仍声明 `Qwen3_5ForConditionalGeneration` / `model_type=qwen3_5`。实验报告必须同时记录发布名、配置架构和配置文件哈希，避免只凭目录名识别模型。
- 训练微调和推理优化可以同属客服场景，但模型、目标和验收不同：训练看“客服能力适配与产物注册”，推理优化看“TTFT/TPOT/吞吐/显存的迭代改善”。

### 2.2 本机运行环境

当前目标环境：

| 资源 | 状态 | 对实现的影响 |
|---|---|---|
| GPU | 单机双卡 RTX 3090，每卡 24GB | 推理优化以单机双卡 vLLM 为主，优先验证 tensor parallel / 双副本两种部署形态 |
| Kubernetes | 本机已有 K8s / minikube 类环境 | 训练任务、vLLM 服务、Agent、Prometheus 等优先纳入 K8s 控制面 |
| 训练模型 | Qwen3.5-4B | LoRA/SFT 可在单卡或双卡上做小规模客服微调 |
| 推理模型 | Qwen3.6-27B-FP8 | 需要先完成 vLLM 启动 smoke，确认 3090 上的 FP8 权重加载、算子兼容和显存余量 |

2026-08-08 实机检查结果：

- GPU：`2 x NVIDIA GeForce RTX 3090 24GB`，compute capability `8.6`。
- Driver：`580.173.02`，NVIDIA-SMI 显示 CUDA `13.0`。
- 模型目录和 tokenizer 可读取。
- 项目 Python 环境仍不能作为有效 vLLM runtime；真实推理使用隔离镜像 `local/vllm-openai:qwen35-v0.19.1`，内含 vLLM 0.19.1、PyTorch 2.10.0 和 CUDA 12.8。
- `scripts/serve_qwen36_27b_fp8.sh` 从 YAML 启动双卡 Docker 服务，并将编译缓存持久化到 `.cache/vllm/qwen36-27b-fp8`。
- `kubectl` 当前 context 是 `minikube`；`minikube` 暂停时不阻塞推理性能实验。27B-FP8 性能矩阵使用 Node Agent 管理的本机 Docker workload，避免把 minikube 虚拟化和模型挂载差异混入基线。
- 推理页已通过 `GET/POST/DELETE /api/inference/runtime` 展示状态并启动/停止固定白名单 vLLM workload；实测启动后能从 `starting` 转为 `ready`，停止后容器删除、双卡显存释放。

重要约束：

- 单机双卡只设置一个 GPU 实验通道，训练微调和推理服务/压测不同时运行。
- 推荐顺序为：停止推理服务并释放显存 → 从前端提交/取消训练 → 训练结束 → 从前端启动推理服务 → 启动/停止压测 → 停止推理服务。
- “停止压测”只取消负载请求；“停止推理服务”负责删除或缩容 vLLM workload 并释放显存，两者是不同生命周期。

- RTX 3090 单卡 24GB，27B-FP8 虽然权重目录约 29G，但还需要 KV cache、CUDA graph、runtime workspace 和框架开销；必须先做最小 `max_model_len=2048`、低并发 smoke。
- 27B-FP8 在 3090 上的实际 FP8 加速能力需要实测确认。若 vLLM / GPU 对 FP8 权重或相关 kernel 支持不理想，应把它作为“FP8 权重量化 serving 兼容性验证”，不能直接写成“利用 FP8 Tensor Core 加速”。
- 训练和 27B 推理不建议同时抢双卡。训练微调和推理优化实验应错峰：训练跑 4B LoRA，推理优化跑 27B-FP8。
- K8s 的作用是统一部署、观测和实验编排；性能极限测试仍要关注容器化引入的网络、挂载和 GPU runtime 开销。

### 2.3 数据集现状

当前数据集状态需要诚实区分：

| 数据集类型 | 当前状态 | 后续动作 |
|---|---|---|
| 客服训练数据集 | 尚未形成最终 SFT/LoRA 训练集 | 后续从 DianJin 对话抽取多轮 messages，并做隐私、长度、重复和策略标签清洗；训练集与推理留出集必须隔离 |
| 推理优化压测数据集 | 已接入 `DianJin/DianJin-CSC-Data` | 原始 train split 13,087 条；已生成固定 seed 的 1K/2K 共享前缀压测切片 |
| RAG/检索评测数据集 | 代码里已有“对话反馈 -> 回流数据集 -> recall@k 评测”机制 | 本轮不依赖，先降级为可选能力，避免推理优化主线被 RAG 复杂度拖住 |

当前落地结果：

- 数据源：Hugging Face `DianJin/DianJin-CSC-Data`，MIT License，单一 train split，共 13,087 条中文客服对话。
- 构建脚本：`scripts/prepare_dianjin_csc.py`。
- 原始数据：`data/raw/dianjin_csc_train.parquet`，约 28MB，Git 忽略。
- 固定压测集：`data/cleaned/dianjin_csc_benchmark.jsonl`，128 条，1024/2048 两档各 64 条，Git 忽略。
- 复现清单：`data/manifests/dianjin_csc_benchmark.json`，记录数据哈希、输出哈希、seed、tokenizer 路径和行数。
- 实际 prompt token 分布：1K 档约 942--983 token，2K 档约 1966--2007 token；聊天模板会带来少量额外 token，最终以 vLLM usage 的 `prompt_tokens` 为准。
- 共享前缀与留出问题来自不同源对话，避免把参考答案泄漏进 prefix caching 场景。

建议数据目录：

```text
data/
  raw/
    dianjin_csc_train.parquet
  cleaned/
    dianjin_csc_benchmark.jsonl
  manifests/
    dianjin_csc_benchmark.json
  training/
    customer_support_sft.jsonl
```

推理压测样本建议字段：

```json
{
  "id": "cs-2k-shared-prefix-001",
  "scenario": "shared_prefix",
  "context_length": 2048,
  "messages": [
    {"role": "system", "content": "你是企业客服助手..."},
    {"role": "user", "content": "长上下文工单与知识片段..."}
  ],
  "expected_keywords": ["退款", "工单", "人工客服"],
  "shared_prefix_id": "dianjin-csc-shared-2048-v1",
  "reference_answer": "来自原始对话中该客户问题之后的客服回复"
}
```

注意：这里的 `shared_prefix` 是为了验证 vLLM prefix caching / KV cache 复用，不等同于 RAG。样本可以直接内嵌客服政策、工单和历史对话，不需要接入检索系统。

质量门禁分两层：硬门禁要求 HTTP/SSE 正常、最终 `content` 非空且 UTF-8 有效、以 `stop` 正常结束，并且不出现直接索取密码或验证码的高风险措辞；生成答复与真实下一轮客服回复的字符二元组 F1 只保留为诊断指标。开放式客服问题允许多种正确表达，因此参考重合度不能单独判错，正式结论还需要固定样本人工抽检或模型评审。

---

## 3. 云原生在本项目中的作用

这里的“云原生”不是装饰词，而是 LLM 训练、推理和运维实验的底座。

| 云原生能力 | 在本项目中的作用 |
|---|---|
| Kubernetes Workload | 承载 vLLM 推理服务、训练 Job、控制面服务和采集 Agent |
| Kubeflow PyTorchJob | 把训练微调任务变成可调度、可观测、可取消的分布式任务 |
| Service / Gateway | 管理 vLLM 多副本入口，支持 OpenAI-Compatible API、路由、灰度和影子流量 |
| HPA / Scale | 做推理服务容量调节和训练/推理资源错峰 |
| Prometheus / OTel / cAdvisor | 采集请求、延迟、吞吐、资源、GPU 和调用链指标 |
| MinIO / PostgreSQL / Redis | 保存模型产物、压测报告、运行事件、客服数据集、缓存和幂等状态 |
| RBAC / 审计 | 控制训练、扩缩容、发布、归档等写操作，记录操作者与影响范围 |

`Workload` 是 K8s 对“需要运行的程序”的统称，不是一种新的模型算法。本项目中主要对应：

- 训练：`PyTorchJob` 创建 Master/Worker Pods，负责下发、重试、状态和日志；停止时删除该 Job 并释放 GPU。
- 推理生产形态：`Deployment` 创建 vLLM Pod，`Service` 暴露 OpenAI-Compatible API；启动/停止对应副本数 `1/0`。当前单机性能实验由 Node Agent 通过 Docker Engine API 管理等价的固定 vLLM workload，后续再切换为 K8s runtime adapter。
- 压测：由控制面后台任务发请求，不额外占 GPU；停止压测只取消请求，不会自动停止 vLLM。

单机双卡采用串行资源模型，不做训练和推理共置。控制面将其视为一个互斥的 `GPU experiment lane`：训练页提供 PyTorchJob 提交/取消，推理压测页分别提供 vLLM 服务启动/停止与 benchmark 启动/停止；后端拒绝训练与推理任务同时占用 GPU，并禁止在压测运行时直接停止 vLLM。

因此，平台目标不是单独写一个训练脚本或压测脚本，而是把这些实验动作纳入统一控制面：

```text
实验配置 -> 云原生执行 -> 指标采集 -> 瓶颈归因 -> 优化建议 -> 参数迭代 -> 报告归档
```

---

## 4. 推理优化目标

### 4.1 优化目标

在保证请求成功率和输出正确性的前提下，尽可能降低：

- **TTFT**：Time To First Token，首 token 延迟，主要受 prefill、排队、调度和 KV cache 状态影响。
- **TPOT**：Time Per Output Token，生成阶段平均每 token 耗时，主要受 decode、batching、显存压力和算子效率影响。

同时监控：

- 端到端延迟
- P95 / P99 延迟
- 生成吞吐 tokens/s
- QPS
- 请求成功率
- 输出非空率 / 输出有效性
- GPU 显存占用
- GPU 利用率
- vLLM runtime 参数

### 4.2 测试矩阵

默认测试矩阵：

| 维度 | 默认值 |
|---|---|
| 并发数 | `1, 2, 4, 8, 16` |
| 上下文长度 | `1024, 2048` |
| max_tokens | `128` 或 `256` |
| 请求数 | 每档 `16` 或 `32` |
| 模型 | `Qwen3.6-27B-FP8` |
| API | vLLM OpenAI-Compatible `/v1/chat/completions` |
| 流式输出 | 开启，用于测 TTFT |

双 3090 环境下的执行顺序：

1. **启动 smoke**：`context_lengths=[512]`、`concurrency=[1]`、`max_tokens=32`，只验证 27B-FP8 能否在 vLLM 上稳定返回非空输出。
2. **短矩阵 smoke**：`context_lengths=[1024,2048]`、`concurrency=[1,2]`、`max_tokens=64`，确认 TTFT/TPOT 采集和显存余量。
3. **正式矩阵**：`context_lengths=[1024,2048]`、`concurrency=[1,2,4,8,16]`、`max_tokens=128/256`。
4. **参数 sweep**：只在 smoke 稳定后再调 `max_num_batched_tokens`、`max_num_seqs`、`gpu_memory_utilization`、`max_model_len` 和 prefix caching。Qwen3.6 在 vLLM 0.19.1 下保持 chunked prefill 开启。

场景需要支持：

- 短问答基线：低上下文、低 prefill 压力。
- 1K 长上下文：中等 prefill 压力。
- 2K 长上下文：高 prefill 压力。
- 共享前缀客服政策场景：用于验证 prefix caching / KV cache 复用收益。
- 多并发峰值场景：用于观察调度、连续批处理和显存压力。

---

## 5. 当前基线与缺口

### 5.1 已有能力

当前项目已经具备：

- Go 控制面统一 `/api` 入口。
- vLLM / AIBrix serving 配置。
- OpenAI-Compatible proxy。
- Go 原生 serving benchmark runner。
- TTFT、P95、P99、吞吐、错误率等基础压测指标。
- GPU / host / cAdvisor / Kubernetes 指标聚合。
- 模型注册中心、路由策略、影子流量、AIOps 诊断。
- Kubeflow `PyTorchJob` 训练任务编排雏形。

### 5.2 推理优化完成项与剩余边界

本轮已补齐：

- Qwen3.6-27B-FP8 的独立 vLLM 配置、模型注册信息和 endpoint 迁移。
- 压测请求支持 `context_lengths`。
- DianJin 数据构建脚本和固定 1K/2K 长上下文 workload。
- 显式计算 TPOT。
- 区分 reasoning token 与最终答复，记录输出有效性、输出哈希和参考质量门禁。
- 每个场景绑定 GPU 显存快照。
- 把 vLLM 参数作为实验配置记录到报告。
- 自动归因 prefill-bound / decode-bound / memory-pressure / scheduler-saturation。
- 输出下一轮优化建议。
- 前端支持 context × concurrency 矩阵、TPOT、质量门禁和 vLLM 实验参数。
- 前端和 Node Agent 支持固定 Qwen3.6 vLLM workload 的真实启动、状态轮询和停止，服务停止后释放双卡显存。
- 发布页将 Qwen3.6 模型版本、参数完全匹配的压测 run 和固定生产档位绑定；控制面执行发布门禁、vLLM 冷启动、健康检查、状态回写和受控下线。
- baseline 与 prefix caching 的完整 160 请求矩阵、MinIO 报告和 vLLM Prometheus 快照。
- `max_num_seqs`、`max_num_batched_tokens`、显存、调度策略、异步调度和 prefill 参数的控制变量实验。
- PyTorch Profiler、vLLM iteration/MFU/KV/CUDA Graph 指标归档和 kernel 级瓶颈归因。
- FP8 KV、N-gram speculation、custom all-reduce 和量化/算子路径的可行性边界验证。
- vLLM 运行日志签名进入 AIOps 推理证据链。

仍需补齐：

- 将 Node Agent 的 Docker runtime adapter 扩展为 K8s Deployment/Service adapter；不复用失效的项目虚拟环境入口。
- 更强的客服语义质量评测；当前质量门禁覆盖非空、截断、安全规则、输出哈希和参考重叠。
- 在有 INT4/AWQ 权重或原生 FP8/P2P 硬件后复测量化与跨卡通信收益。

---

## 6. 后端执行方案

### 6.1 API 契约

扩展 `POST /api/benchmarks/serving` 请求：

```json
{
  "endpoint_id": "qwen36-27b-fp8-vllm",
  "dataset": "DianJin/DianJin-CSC-Data",
  "workload": "customer_support_shared_prefix",
  "routing_strategy": "least-request",
  "context_lengths": [1024, 2048],
  "concurrency_levels": [1, 2, 4, 8, 16],
  "requests_per_level": 16,
  "max_tokens": 256,
  "vllm": {
    "max_num_seqs": 8,
    "max_num_batched_tokens": 4096,
    "gpu_memory_utilization": 0.9,
    "max_model_len": 4096,
    "prefix_caching": false,
    "chunked_prefill": true,
    "quantization": "fp8",
    "scheduler": "default"
  }
}
```

`vllm` 字段当前是实验参数快照，不是热更新接口。每轮实验必须先用对应 YAML 启动或重启 vLLM，再提交相同参数的 benchmark run；后续接入 K8s Deployment patch/rollout 后，才由平台自动应用启动参数。

### 6.2 事件模型

继续复用 `benchmark_samples`，不新增表。

新增或扩展事件：

| event_type | 用途 |
|---|---|
| `started` | 记录 endpoint、workload、数据集加载状态 |
| `scenario_start` | 记录 context_length、concurrency、requests |
| `request` | 单请求 TTFT、TPOT、total_ms、tokens、输出有效性、输出哈希、参考重合度 |
| `scenario_summary` | 单场景 P95、吞吐、成功率、显存、瓶颈归因 |
| `optimization_report` | 汇总测试矩阵、vLLM 参数快照和最优场景 |
| `process_exit` | 压测结束 |

### 6.3 指标计算

单请求：

```text
TTFT = first content or reasoning delta timestamp - request start
TPOT = (total_latency - TTFT) / max(output_tokens - 1, 1)
total_latency = response done timestamp - request start
output_valid = trimmed final content != "" and valid UTF-8
reference_overlap = character-bigram F1(generated content, held-out agent reply)
```

场景汇总：

```text
success_rate = successful_requests / total_requests
error_rate = failed_requests / total_requests
p95_ttft_ms = percentile(TTFT, 95)
p95_tpot_ms = percentile(TPOT, 95)
p95_latency_ms = percentile(total_latency, 95)
output_tokens_per_second = total_output_tokens / wall_time
```

### 6.4 GPU 快照

每个场景运行前后采集：

- GPU memory used
- GPU memory total
- GPU utilization
- temperature
- power

数据来源优先级：

1. Go Agent `/api/gpu`
2. cAdvisor / Kubernetes metrics
3. 不可用时返回 `available=false`，但不阻断压测

### 6.5 vLLM Profiling 指标

优先从 vLLM Prometheus `/metrics` 抓取：

- KV cache usage
- running requests
- waiting requests
- prompt tokens
- generation tokens
- scheduler queue
- batch tokens

如果当前 vLLM 指标字段不稳定，第一阶段只做 best-effort 抓取和原始指标归档，不在 UI 中强依赖。

---

## 7. 瓶颈归因规则

先采用规则化归因，后续再接 AIOps agent。

| 归因 | 判断依据 | 可能原因 | 建议 |
|---|---|---|---|
| `prefill-bound` | 1K/2K 下 TTFT 随上下文显著上升，TPOT 变化较小 | prefill 计算压力、长上下文、prefix cache 未命中 | 开启 prefix caching、保持 chunked prefill 并调整 batch token 预算、减少重复 prompt |
| `decode-bound` | TPOT 高、输出 tokens/s 低，TTFT 不高 | decode 阶段吞吐不足、batch 太小或算子效率低 | 调整 max_num_seqs、增大 batch tokens、调研量化和算子融合 |
| `memory-pressure` | 显存占用高、错误率/OOM/延迟抖动增加 | KV cache 压力、gpu_memory_utilization 过高、max_model_len 过大 | 降低 max_model_len、降低 max_num_seqs、使用量化、缩小并发 |
| `scheduler-saturation` | 并发升高后 P95/TTFT 急剧上升，成功率下降 | 等待队列堆积、连续批处理参数不合理 | 调整 max_num_batched_tokens、max_num_seqs、路由策略或扩副本 |
| `stability-risk` | 成功率低或输出为空 | 上游错误、超时、服务不稳定 | 降并发、查看 vLLM 日志、回滚参数 |

归因输出示例：

```json
{
  "bottleneck": {
    "type": "prefill-bound",
    "confidence": 0.78,
    "evidence": [
      "context_length=2048 时 p95_ttft_ms 比 1024 高 62%",
      "p95_tpot_ms 基本稳定"
    ]
  },
  "recommendations": [
    "开启或验证 prefix caching 命中率",
    "保持 chunked prefill，并对 max_num_batched_tokens 做参数扫描",
    "将 max_model_len 从 4096 降到 2048 做对比实验"
  ]
}
```

---

## 8. 优化迭代流程

每一轮优化必须留下配置、指标和结论。

### Round 0：Baseline

目的：建立默认 vLLM 参数下的 1K/2K × 1--16 并发基线。

记录：

- vLLM 参数
- GPU 型号与显存
- 模型 ID / quantization
- 每档 TTFT、TPOT、P95、吞吐、成功率
- 最差场景和主要瓶颈

### Round 1：Prefix Caching / KV Cache 复用

目的：验证共享前缀场景下 TTFT 是否下降。

实验：

- `prefix_caching=false`
- `prefix_caching=true`

重点看：

- 共享前缀 workload 的 TTFT 下降幅度
- 显存占用变化
- 成功率是否保持

### Round 0/1 实测结果（2026-08-08）

- Baseline run：`efdcc446-5d9a-4c01-8527-1b4d0405678f`。
- Prefix caching run：`966ed21f-4657-4b1e-a63f-6f126afd338f`。
- 两轮均为 160/160 请求成功、160/160 输出质量门禁通过、0 截断、0 安全违规。
- prefix cache 查询 238,130 tokens，命中 186,592 tokens，命中率约 78.4%。
- 十个场景 P95 TTFT 均改善，降幅 30.9%--80.6%，平均 70.4%；九个场景 TPOT 改善，平均降幅 44.4%，1K/并发 1 的 TPOT 回退约 2%。

| 上下文 | 并发 | Baseline TTFT | Prefix TTFT | TTFT 降幅 | Baseline TPOT | Prefix TPOT | TPOT 降幅 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1K | 1 | 1125ms | 778ms | 30.9% | 35.9ms | 36.6ms | -2.0% |
| 1K | 2 | 2179ms | 591ms | 72.9% | 65.6ms | 44.0ms | 33.0% |
| 1K | 4 | 4291ms | 886ms | 79.4% | 102.4ms | 54.9ms | 46.4% |
| 1K | 8 | 8303ms | 1728ms | 79.2% | 179.4ms | 69.9ms | 61.1% |
| 1K | 16 | 19687ms | 6491ms | 67.0% | 189.2ms | 79.5ms | 58.0% |
| 2K | 1 | 2267ms | 753ms | 66.8% | 36.8ms | 35.9ms | 2.6% |
| 2K | 2 | 4439ms | 978ms | 78.0% | 90.8ms | 49.9ms | 45.1% |
| 2K | 4 | 8895ms | 1930ms | 78.3% | 161.9ms | 68.3ms | 57.8% |
| 2K | 8 | 17923ms | 3479ms | 80.6% | 357.8ms | 104.9ms | 70.7% |
| 2K | 16 | 37121ms | 10652ms | 71.3% | 384.2ms | 111.0ms | 71.1% |

结论：共享客服政策前缀下，prefix caching 是有效优化；高并发仍出现 GPU 100%、`max_num_seqs=8` 排队和 2K/16 的 10.7s P95 TTFT。报告分别归档在 MinIO `benchmarks/<run_id>/report.json`，本机原始事件和 Prometheus 快照位于忽略提交的 `logs/inference/qwen36-*`。

### Round 2：调度参数

目的：寻找吞吐和 TTFT/TPOT 的平衡点。

实验变量：

- `max_num_batched_tokens`
- `max_num_seqs`

重点看：

- 高并发下 P95 TTFT
- TPOT
- tokens/s
- waiting/running request 指标

实测结论：完成 `seqs=8/12/16` 与 `tokens=2048/4096/8192` 扫描，并用每场景 32 请求做最终公平复测。默认 `8/4096` 保持较低 TPOT；`16/8192` 相对它平均 TTFT -19.5%、吞吐 +14.8%，但 TPOT +34.1%，因此只作为高并发 TTFT/吞吐档。`12/8192` 不在 Pareto 前沿。

### Round 3：显存参数

目的：找到稳定显存水位。

实验变量：

- `gpu_memory_utilization`
- `max_model_len`

重点看：

- OOM / error rate
- GPU memory used
- P95 抖动

实测结论：`gpu_memory_utilization=0.92` 挤压 Marlin workspace 并触发 CUDA OOM；`max_model_len=3072` 未改善 TTFT/TPOT。稳定边界保持 0.90 和 4096。

### Round 4：Chunked Prefill 预算 / Quantization

目的：验证长上下文和显存压力下的进一步优化。

实验变量：

- 保持 `chunked_prefill=true`，扫描 `max_num_batched_tokens`
- AWQ / GPTQ / fp16 等服务配置

重点看：

- 2K context 下 TTFT
- TPOT
- 输出正确性
- 显存下降幅度

实测结论：chunked prefill 保持开启；并发 partial prefill 不受当前 Qwen3.6 混合架构支持。FP8 KV 虽增加 KV block 数，但缺少校准 scale，正式负载 OOM；当前 27B FP8 权重在 RTX 3090 上走 Marlin fallback。仓库没有经质量校验的 INT4/AWQ 产物，故只记录后续验证条件，不虚构量化收益。

### Round 5：算子融合策略调研

目的：作为报告与简历中的“优化调研”部分，说明 vLLM/PyTorch/CUDA 层可继续优化方向。

要求：

- 不在当前项目中强行手写 CUDA kernel。
- 记录调研结论：FlashAttention、PagedAttention、CUDA Graph、fused RMSNorm/Rotary/MLP、量化 kernel 等。
- 如果没有真实改动，只能写“调研与参数侧验证”，不能写“实现算子融合”。

实测结论：Profiler 显示 NCCL BF16 ring all-reduce 占 Self CUDA 约 45%--61%，Marlin FP8 GEMM 约 30%--42%，FlashAttention 约 0.5%。PagedAttention、连续批处理、FlashAttention、CUDA Graph 和已有 norm/quant 融合均由 vLLM 运行时启用；当前主要瓶颈是双卡 PCIe 通信和 3090 非原生 FP8 GEMM，而不是 attention kernel。详见 `docs/INFERENCE-PROFILING-REPORT.md`。

---

## 9. 前端执行方案

将“压测验证”页升级为“推理优化工作台”。

### 9.1 页面区域

1. **实验配置**
   - endpoint
   - workload
   - context length
   - concurrency
   - max tokens
   - vLLM 参数

2. **核心指标**
   - P95 TTFT
   - P95 TPOT
   - P95 latency
   - tokens/s
   - success rate
   - GPU memory

3. **矩阵结果表**
   - 行：context length + concurrency
   - 列：TTFT、TPOT、P95、吞吐、成功率、显存、瓶颈类型

4. **瓶颈归因**
   - 当前主瓶颈
   - 证据
   - 置信度

5. **优化建议**
   - 下一轮参数建议
   - 风险提示
   - 预期改善指标

6. **实验报告**
   - run_id
   - vLLM 参数快照
   - MinIO 报告链接
   - 历史对比

7. **生命周期控制**
   - 推理压测页：启动/停止 vLLM workload；停止后释放双卡。
   - 训练页：提交/取消 PyTorchJob。
   - 压测页：启动/停止 benchmark run；停止仅取消在途和排队请求。
   - 后端统一执行单机 GPU 通道互斥检查，不依赖前端按钮是否被绕过。

### 9.2 UI 约束

- 不做营销式 landing page。
- 页面应像工程控制台：信息密度高、便于对比、适合反复实验。
- 指标卡和矩阵表优先，不使用大段解释性文本。
- 所有结果来自 API，不做硬编码假数据。

---

## 10. 训练微调执行方向

训练侧近期不抢推理优化主线，但需要和简历定位对齐。

### 10.1 当前可落地口径

可以诚实写：

```text
基于 Kubeflow Training Operator 设计训练任务编排能力，支持训练任务创建、镜像下发、worker/GPU 参数配置、状态跟踪、日志查看和训练成功后模型版本自动注册。
```

### 10.2 双 3090 下的训练路线

训练微调以 `Qwen3.5-4B` 为主，先做小规模客服 LoRA：

1. **单卡 LoRA smoke**
   - `workers=0`
   - `gpus_per_worker=1`
   - 小样本客服 SFT 数据集
   - 目标：验证训练镜像、数据读取、日志、adapter 输出。

2. **双卡 DDP / DeepSpeed smoke**
   - `workers=1` 或按 Training Operator Master + Worker 拆分。
   - 每副本 1 GPU。
   - 目标：验证多卡调度、显存记录、训练状态回写。

3. **产物注册**
   - adapter 上传 MinIO。
   - `training_runner` 成功后注册模型版本。
   - 模型版本带 `trained`、`lora`、`customer-support` 标签。

4. **服务化验证**
   - 训练产物不直接影响 27B 推理优化主线。
   - 可另起 4B + LoRA 的小模型 serving smoke，验证“训练 -> 注册 -> 服务”的闭环。

### 10.3 后续补强

后续再补：

- `deploy/training/Dockerfile`
- `train_lora.py`
- Transformers + PEFT + LoRA
- DeepSpeed ZeRO 配置
- bf16/fp16
- gradient checkpointing
- MinIO 数据集读取与 adapter 上传
- 训练成功后真实 adapter 注册

验收标准：

- 能跑一个小 LoRA job。
- 训练日志能在前端查看。
- adapter 产物落 MinIO。
- 模型注册中心出现 trained/lora 版本。

---

## 11. AIOps 执行方向

AIOps 同时承接推理优化和训练微调故障诊断，两条工作负载互不要求同时运行。

### 11.1 近期边界

本轮不把 RAG / 检索评测作为必需功能。AIOps 先服务于推理与训练两个运行闭环：

- 根据 benchmark report、GPU 指标、vLLM 指标、K8s 事件和配置变更做诊断。
- 输出“为什么 TTFT/TPOT 变差、瓶颈在哪里、下一轮调什么参数”。
- 根据训练任务台账、PyTorchJob 状态/conditions、Master Pod 日志、GPU 快照和 adapter 产物状态做诊断。
- 区分训练 OOM、NCCL/torchrun 通信、DianJin 数据格式/tokenization、checkpoint/MinIO 归档和集群提交异常。
- 现有客服 RAG、反馈回流、recall@k 代码保留，但不进入近期验收。

### 11.2 输入证据

- benchmark report
- request traces
- vLLM metrics
- GPU metrics
- Kubernetes pod/deployment 状态
- 配置中心变更记录
- 发布/回滚事件
- 历史优化结论
- 训练任务状态、超参数和基础模型
- PyTorchJob phase、reason、message 和 replica 状态
- 训练 Pod 日志尾部与 LoRA adapter 产物 URI

### 11.3 输出

- 故障原因
- 影响范围
- 证据链
- 处理建议
- 下一轮优化实验建议
- 自动创建或复用 warning/critical Incident，并记录诊断关联事件

### 11.4 当前实现（2026-08-09）

- `GET /api/ai/inference/evidence`：读取最新或指定已完成 benchmark、可比 baseline、vLLM runtime 和双卡 GPU 快照。
- `GET /api/ai/training/evidence`：读取最新或指定训练台账、实时 PyTorchJob、Master/Worker Pod 日志尾部和 GPU 快照。
- `POST /api/ai/diagnose` 支持 `scope=inference|training`，分类与严重性连同证据链持久化。
- 推理规则先执行成功率与输出正确性硬门禁，再归因 scheduler、显存、decode 和 prefill。
- Agent 采集 vLLM 日志并识别 Marlin FP8 回退、GPU P2P 不可用、未校准 FP8 KV、partial prefill 不支持和 CUDA OOM；日志签名进入诊断证据与动作建议。
- 训练规则覆盖 OOM、分布式通信、数据处理、产物归档、进行中/取消/成功状态。
- AIOps 前端提供推理/训练分栏、真实证据快照、根因、证据链、动作建议与 Incident 状态操作；已删除写死演示指标。
- 已用真实数据库完成专项诊断联调：推理最新矩阵归因为调度排队；历史训练任务归因为 Minikube API 提交失败。

### 11.5 后续增强

把推理优化归因接入 `/api/ai/diagnose:agent`，让 agent 可以主动调用：

- `recent_benchmark_runs`
- `benchmark_events`
- `vllm_metrics`
- `gpu_snapshot`
- `kubernetes_pods`
- `config_changes`

---

## 12. 阶段计划

截至 2026-08-09：Phase 0--4 已完成。真实 27B smoke、baseline、prefix caching、调度/显存/推测解码实验、PyTorch Profiler 归因、前端服务/压测启停和 AIOps 推理/训练双侧诊断均已验证。当前推理侧只保留 K8s runtime adapter、增强语义质量评测和新硬件/新量化产物复测；Phase 5 训练侧真实 Qwen3.5-4B LoRA 尚未开始。

### Phase 0：环境与数据准备

交付：

- `Qwen3.6-27B-FP8` 的 vLLM serving 配置。
- 独立 endpoint / service instance：`qwen36-27b-fp8-vllm`。
- DianJin 客服推理压测集：`data/cleaned/dianjin_csc_benchmark.jsonl`。
- 训练侧客服 SFT 样例：`data/training/customer_support_sft_sample.jsonl`。
- 双 3090 环境记录：GPU 型号、显存、驱动、CUDA、vLLM 版本、K8s runtime。

验收：

- vLLM 能加载 `Qwen3.6-27B-FP8` 并返回非空输出。
- smoke 参数和显存水位写入文档或 benchmark report。
- 推理优化不依赖 RAG / 检索评测即可启动。

### Phase 1：推理优化后端闭环

交付：

- `context_lengths` 请求参数。
- 1K/2K prompt 生成。
- TTFT / TPOT / P95 / 吞吐 / 成功率。
- GPU before/after 快照。
- `scenario_summary` 输出瓶颈归因和建议。
- `reference_pass_rate` 和 `mean_reference_overlap` 输出质量回归门禁。

验收：

- 无 vLLM 时 mock SSE 单测通过。
- 有 vLLM 时能跑 27B-FP8 的 1K/2K × 1/2 并发 smoke。
- benchmark report 中包含 optimization profile。

### Phase 2：前端推理优化工作台

交付：

- 新建实验抽屉支持 context length 和 vLLM 参数。
- KPI 卡展示 TTFT / TPOT / success rate。
- 矩阵表展示 context × concurrency。
- 瓶颈归因和建议卡片。

验收：

- 前端 build 通过。
- 发起实验后能轮询展示真实结果。

### Phase 3：Profiling 深化

交付：

- vLLM Prometheus 指标抓取归档。
- KV cache / scheduler 指标 best-effort 展示。
- 与 GPU 快照共同参与归因。
- PyTorch Profiler trace、iteration details、MFU 和 CUDA Graph 指标归档。

验收：

- vLLM 指标可用时报告包含 raw metrics。
- vLLM 指标不可用时页面降级但压测仍可完成。
- 报告能区分 prefill/decode、通信、GEMM 与 attention kernel 开销。

### Phase 4：优化实验留证

交付：

- baseline 报告。
- prefix caching 对比报告。
- max_num_batched_tokens / max_num_seqs sweep 报告。
- gpu_memory_utilization / max_model_len 对比报告。

验收：

- 每轮实验有 run_id、参数、指标、结论。
- README 和面试文档能引用真实结果。

### Phase 5：训练侧真实 LoRA 补强

交付：

- 训练镜像。
- LoRA 训练脚本。
- DeepSpeed 配置。
- 小数据集端到端训练证据。

验收：

- `PyTorchJob` 真跑成功。
- adapter 落 MinIO。
- 模型注册中心自动出现版本。

---

## 13. 测试计划

### 后端单测

- TPOT 计算。
- percentile 计算。
- 长上下文 prompt 长度生成。
- 归因规则。
- 空输出判失败。
- mock SSE benchmark contract。

### 前端验证

- `npm run build`
- 空状态
- running 状态
- completed 状态
- failed 状态
- 长文本不溢出

### 真栈验证

最低验证：

```text
model=/mnt/nvme-data/models/LLM_model/Qwen3.6-27B-FP8
context_lengths=[512]
concurrency_levels=[1]
requests_per_level=2
max_tokens=32
```

短矩阵验证：

```text
context_lengths=[1024,2048]
concurrency_levels=[1,2]
requests_per_level=4
max_tokens=64
```

完整验证：

```text
context_lengths=[1024,2048]
concurrency_levels=[1,2,4,8,16]
requests_per_level=16
max_tokens=128/256
```

---

## 14. 简历口径

实现完成后可写：

```latex
\item \key{推理压测与性能优化：}基于 vLLM / AIBrix 搭建 OpenAI-Compatible 本地推理服务，设计 1--16 并发与 1K/2K 上下文长度的压测矩阵，采集 TTFT、TPOT、P95 延迟、生成吞吐、请求成功率、输出有效性和 GPU 显存占用；结合 vLLM 参数快照与运行指标对 prefill、decode、KV Cache、调度队列和显存瓶颈进行归因，围绕 prefix caching、max\_num\_batched\_tokens、max\_num\_seqs、gpu\_memory\_utilization、max\_model\_len、chunked prefill 和量化策略开展迭代优化，降低长上下文场景下首字延迟与单 token 生成耗时。
```

如果某些优化只完成调研，没有真实实验结果，必须降级写成：

```text
调研并评估 PagedAttention、chunked prefill、量化与算子融合等优化方向，结合实验指标形成参数调优建议。
```

不要写成已经实现算子融合。

---

## 15. 完成定义

推理优化主线完成时，项目应满足：

- 能从前端发起 1K/2K × 1--16 并发推理优化实验。
- 后端真实请求 vLLM OpenAI-Compatible API。
- 每个 run 记录参数、事件、指标、显存和报告。
- 报告能给出瓶颈归因和下一轮优化建议。
- README / ROADMAP / 面试文档和真实功能一致。
- 简历描述能经得起代码和演示核查。
