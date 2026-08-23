# Qwen3.6-27B-FP8 推理优化与 Profiling 报告

## 1. 实验口径

- 日期：2026-08-08
- 硬件：单机双 RTX 3090 24GB，PCIe 拓扑，无可用 GPU P2P/NVLink
- 服务：vLLM 0.19.1，OpenAI-Compatible API，TP=2
- 模型：`/mnt/nvme-data/models/LLM_model/Qwen3.6-27B-FP8`
- 实际架构：`Qwen3_5ForConditionalGeneration`
- 数据：DianJin-CSC 中文客服固定切片，1K/2K 上下文
- 主门禁：请求成功率 100%、质量门禁 100%、无 CUDA OOM
- 主目标：降低 P95 TTFT 和 P95 TPOT；吞吐与端到端 P95 为辅助指标

所有调度实验均通过 `scripts/run_qwen36_scheduler_sweep.sh` 冷启动独立容器。控制面在提交压测前核对报告参数与 Agent 返回的真实 launch config，参数不一致时返回 `409 inference_config_mismatch`。

## 2. 参数扫描结论

| 方向 | 候选 | 结果 | 决策 |
|---|---|---|---|
| Prefix caching | 开启 | 固定共享前缀矩阵中 prefix hit 78.4%，平均 TTFT -70.4%、TPOT -44.4%、吞吐 +118.3% | 采纳 |
| `max_num_seqs` | 8 / 12 / 16 | 8 的 TPOT/端到端更稳；16 在 C16 显著降低 TTFT 并提高吞吐，但会抬高 TPOT；12 不在 Pareto 前沿 | 固化 8/16 两档 |
| `max_num_batched_tokens` | 2048 / 4096 / 8192 | `seqs=8` 时 8192 相对 4096 没有稳定收益；8192 只用于 `seqs=16` 高并发档 | 按档位配置 |
| Async scheduler | on / off | 单次 A/B 差异约 1%--3%，开启时端到端 P95 略低 | 保持开启 |
| Concurrent partial prefill | 4/1 | vLLM 启动时报 `Concurrent Partial Prefill is not supported` | 不可用，固定为 1/1 |
| Priority scheduler | 短上下文优先 | 1K TTFT +5.4%，2K TTFT +43.8%，出现长请求饥饿 | 淘汰 |
| Reserve full ISL | on / off | 关闭后混合负载略有改善，但完整矩阵的 2K/C16 TPOT 恶化至 170 ms | 保持开启 |
| Custom all-reduce | 启用请求 | P2P 自检失败，vLLM 自动回退 NCCL | 不可用，显式关闭以消除歧义 |
| FP8 KV cache | `fp8` | 缺少校准 scale，attention page 784 -> 1568；正式负载触发 CUDA OOM 和停滞 | 淘汰 |
| N-gram speculation | 3 tokens | 接受率 81/777=10.4%；TPOT +51.7%、吞吐 -28.0% | 淘汰 |
| `max_model_len` | 4096 -> 3072 | TTFT +2.0%、TPOT +10.2%，仅端到端 P95 -3.3% | 保持 4096 |
| GPU memory utilization | 0.90 -> 0.92 | Marlin GEMM 申请 108 MiB 时 CUDA OOM | 保持 0.90 |

### 2.1 最终公平矩阵

最终决策只使用 1K/2K x C8/C16、每场景 32 请求、128 输出 tokens 的冷启动独立实验。聚合值是四个场景 P95 指标的算术平均，用于配置间对比，不代替单场景 SLO。

| 配置 | 平均 P95 TTFT | 平均 P95 TPOT | 平均 P95 E2E | 平均输出吞吐 | 成功率/质量门禁 |
|---|---:|---:|---:|---:|---:|
| `seqs=8,tokens=4096` | 6063ms | 97.5ms | 11257ms | 80.4 tok/s | 100% / 100% |
| `seqs=8,tokens=8192` | 6213ms | 97.1ms | 11187ms | 80.3 tok/s | 100% / 100% |
| `seqs=12,tokens=8192` | 6096ms | 115.6ms | 12091ms | 85.3 tok/s | 100% / 100% |
| `seqs=16,tokens=8192` | 4883ms | 130.8ms | 11343ms | 92.3 tok/s | 100% / 100% |

相对 `8/4096`，`16/8192` 的平均 P95 TTFT 降低 19.5%、吞吐提高 14.8%，但 P95 TPOT 增加 34.1%，端到端 P95 基本持平（+0.8%）。因此它是高并发首字/吞吐档，不是全指标同时最优。`8/4096` 保留为默认均衡档。原始聚合文件为 `logs/inference/scheduler-sweep/fair-32-summary.json`。

### 2.2 TP2 / PP2 A/B

在相同 1K/2K x C1/C2/C4/C8/C16、每场景 32 请求的完整矩阵中，PP2 相对 TP2 的平均 P95 TTFT 降低 4.7%，但 P95 TPOT 增加 11.1%、端到端 P95 增加 6.8%、吞吐下降 9.4%。两轮请求成功率与质量门禁均为 100%。因此继续使用 TP2，PP2 不进入发布档位。完整数据和算子归因见 `docs/INFERENCE-PARALLELISM-AB-REPORT.md`。

## 3. Profiling 归因

Profiling 使用 vLLM iteration details、MFU、CUDA Graph/KV 指标和 PyTorch Profiler。观测开销与正式基准隔离，原始文件位于：

- `logs/inference/scheduler-sweep/profiling-mixed-c16-vllm.log`
- `logs/inference/scheduler-sweep/profiling-mixed-c16-metrics.prom`
- `logs/inference/scheduler-sweep/profiling-mixed-c16-profiler/`

### 3.1 Prefill 与 decode

一次 16 并发、75% 1K + 25% 2K 的短输出 profile 中：

- 4 个 prefill/mixed 迭代约为 1602、911、1515、3405 ms，合计约 7.43 s。
- 稳态 16 路 decode 每迭代约 55--63 ms。
- prompt token 19,717，其中本地 prefix cache hit 14,112，按来源计算命中率约 71.6%。
- vLLM 周期日志报告 prefix cache hit rate 72.5%。

结论：高并发首字延迟主要由 prefill 分批执行和调度等待构成，decode 单步明显更短。Prefix caching 已经减少大部分共享前缀计算，但无法消除每个请求的非共享输入和跨卡执行成本。

### 3.2 GPU 算子

PyTorch Profiler 的两张卡汇总显示：

- NCCL BF16 ring all-reduce 占 Self CUDA 约 45%--61%。
- Marlin FP8 GEMM 占 Self CUDA 约 30%--42%。
- FlashAttention varlen forward 约 0.5%。
- GDN/Mamba kernel 有可见开销，但不是最高 Self CUDA 项。

结论：当前瓶颈不是 PagedAttention/FlashAttention 内核。主要限制是双卡 PCIe 通信，以及 RTX 3090 缺少原生 FP8 计算后使用 Marlin weight-only FP8 kernel。继续微调 attention 参数的收益上限较低；更大的结构性收益需要支持原生 FP8 的 GPU、可用 P2P/NVLink，或为 3090 准备经过质量校验的 INT4/AWQ 权重。

## 4. 失败实验与稳定性边界

### FP8 KV cache

启动日志提示 checkpoint 没有 q/k/v/prob 校准 scale，并使用 1.0；正式混合负载触发 CUDA OOM，运行请求停滞。原始证据：

- `logs/inference/scheduler-sweep/mixed-kv-fp8-vllm.log`
- `logs/inference/scheduler-sweep/mixed-kv-fp8-result.json`

### GPU memory utilization 0.92

提高 KV 预留后，Marlin GEMM workspace 申请 108 MiB 时 OOM。说明 `gpu_memory_utilization` 不是“越高越快”，它会挤压模型执行 workspace。原始证据：

- `logs/inference/scheduler-sweep/mixed-gpu-util092-vllm.log`
- `logs/inference/scheduler-sweep/mixed-gpu-util092-result.json`

### Custom all-reduce

当前拓扑无法通过 GPU P2P 自检，vLLM 自动禁用 custom all-reduce。该轮性能变化属于重复实验噪声，不能归因为 custom all-reduce 收益。

## 5. 当前推荐配置

### 5.1 默认均衡档

```yaml
tensor_parallel_size: 2
max_model_len: 4096
gpu_memory_utilization: 0.90
max_num_seqs: 8
max_num_batched_tokens: 4096
enable_prefix_caching: true
enable_chunked_prefill: true
async_scheduling: true
scheduling_policy: fcfs
max_num_partial_prefills: 1
max_long_partial_prefills: 1
scheduler_reserve_full_isl: true
disable_custom_all_reduce: true
kv_cache_dtype: auto
speculative_decoding: none
stream_interval: 1
```

### 5.2 高并发 TTFT/吞吐档

仅将 `max_num_seqs` 调为 16、`max_num_batched_tokens` 调为 8192，其余参数与均衡档一致。该档位适合首字和吞吐优先的 C16 场景，不能宣称同时优化 TPOT。

Profiling 参数只在诊断运行中开启，不进入正式压测配置。FP8 KV、0.92 显存比例、优先级调度、并发 partial prefill 和 N-gram speculation 均不得进入默认配置。
