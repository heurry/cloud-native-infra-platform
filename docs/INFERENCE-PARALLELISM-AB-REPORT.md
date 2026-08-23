# Qwen3.6-27B-FP8 TP2 / PP2 A/B 报告

## 1. 结论

单机双 RTX 3090、无 NVLink 环境下，保留 `TP=2, PP=1` 作为默认拓扑，淘汰 `TP=1, PP=2`。

PP2 相对 TP2 的十场景平均结果为：

- P95 TTFT 降低 4.7%。
- P95 TPOT 增加 11.1%。
- P95 端到端延迟增加 6.8%。
- 输出吞吐下降 9.4%。
- 两轮各 320 请求，请求成功率与质量门禁均为 100%。

PP2 虽消除了逐层 AllReduce，但新增流水线 stage 传输、同步等待和负载不均。它只在部分低中并发场景改善 TTFT，没有满足“在正确性不退化的前提下同时降低 TTFT 和 TPOT”的主目标。

在此基础上继续完成 PP2 层切分优化。将默认 `32/32` 调整为 `35/29` 后，PP2 内部十场景平均 TTFT 降低 3.2%、TPOT 降低 2.0%、输出吞吐提升 3.2%，但优化后的 PP2 相对 TP2 仍有约 9.0% 的 P95 TPOT 回退。因此 `35/29` 作为 PP2 实验候选保留，不替换 TP2 默认拓扑。

## 2. 实验口径

| 参数 | 固定值 |
|---|---|
| 模型 | `Qwen3.6-27B-FP8` |
| vLLM | 0.19.1 |
| 硬件 | 双 RTX 3090 24GB，无 NVLink |
| 拓扑 | TP2/PP1 对比 TP1/PP2 |
| 数据集 | DianJin-CSC 固定中文客服切片 |
| 矩阵 | 1K/2K x C1/C2/C4/C8/C16 |
| 请求数 | 32/场景，320/拓扑 |
| 输出上限 | 128 token |
| 调度 | `max_num_seqs=8`、`max_num_batched_tokens=4096`、FCFS |
| 缓存 | Prefix caching 与 chunked prefill 开启 |
| 其他 | async scheduling 关闭，KV cache 为 auto |

两轮均由控制面冷启动独立容器。runtime 状态和 benchmark 报告同时记录 TP/PP 参数，并在提交压测前校验实际启动配置。

## 3. 完整矩阵

| 上下文/并发 | TP2 TTFT | PP2 TTFT | TP2 TPOT | PP2 TPOT | TP2 吞吐 | PP2 吞吐 |
|---|---:|---:|---:|---:|---:|---:|
| 1K/C1 | 289ms | 273ms | 37.5ms | 50.1ms | 23.6 | 18.5 |
| 1K/C2 | 567ms | 317ms | 46.0ms | 56.6ms | 40.2 | 32.9 |
| 1K/C4 | 734ms | 865ms | 58.2ms | 67.4ms | 66.1 | 56.4 |
| 1K/C8 | 1816ms | 1739ms | 85.2ms | 87.4ms | 94.5 | 89.2 |
| 1K/C16 | 6520ms | 6653ms | 85.4ms | 84.7ms | 93.9 | 87.5 |
| 2K/C1 | 545ms | 510ms | 37.7ms | 50.4ms | 21.6 | 17.2 |
| 2K/C2 | 770ms | 551ms | 53.7ms | 65.0ms | 34.0 | 29.0 |
| 2K/C4 | 2002ms | 1199ms | 77.4ms | 86.4ms | 50.3 | 45.7 |
| 2K/C8 | 3958ms | 3749ms | 120.0ms | 122.2ms | 64.2 | 64.2 |
| 2K/C16 | 10646ms | 10679ms | 121.3ms | 132.2ms | 65.5 | 61.0 |

吞吐单位为 output tok/s。完整原始结果位于：

- `logs/inference/parallel-ab/tp2-pp1-full-32-result.json`
- `logs/inference/parallel-ab/tp1-pp2-full-32-result.json`
- `logs/inference/parallel-ab/tp2-vs-pp2-comparison.json`
- `logs/inference/parallel-ab/aggregate-summary.json`

## 4. Profiling 归因

使用 C16、75% 1K + 25% 2K 的 mixed workload 分别采集两张卡的 PyTorch Profiler trace。

| 拓扑/Rank | Marlin FP8 GEMM | NCCL AllReduce | NCCL SendRecv | FlashAttention |
|---|---:|---:|---:|---:|
| TP2 rank0 | 35.1% | 55.5% | 0% | 1.1% |
| TP2 rank1 | 50.0% | 37.5% | 0% | 1.6% |
| PP2 rank0 | 89.9% | 0% | 0.5% | 1.8% |
| PP2 rank1 | 71.6% | 0% | 12.7% | 2.1% |

PP2 profile 中 GPU0/GPU1 峰值显存约为 20.5/23.6GB，利用率约为 85%/99%；TP2 对应约为 23.1/23.6GB、95%/98%。PP2 的末级包含输出相关模块，stage 负载和显存明显不均。减少 AllReduce 的收益被以下成本抵消：

1. 每个 decode step 的 PP stage 依赖和 SendRecv。
2. 自回归解码难以在两个 stage 间形成持续满载流水。
3. PP1 更重，PP0 存在等待，整条流水由较慢 stage 决定。
4. PCIe 上的 stage 传输仍然存在，只是由 AllReduce 变为点对点 SendRecv。

短 profile 使用 64 token 上限，出现截断并导致质量门禁低于 100%，因此仅用于算子归因，不参与最终质量和性能决策。正式 128-token 矩阵的质量门禁为 100%。

## 5. PP 层切分优化

### 5.1 候选筛选

固定 1K/2K、C8/C16、32 请求/场景，对 `32/32`、`34/30`、`35/29`、`36/28` 四种分层执行 A/B。四轮共 512 个请求，请求成功率、输出有效率和质量门禁均为 100%。

`36/28` 的吞吐最高，但 P95 TTFT 相对 `32/32` 回退 3.1%；`35/29` 在 TTFT 与 TPOT 间更均衡，因此进入完整矩阵回归。

### 5.2 完整矩阵

以下为默认 `32/32` 与候选 `35/29` 的 P95 指标对比：

| 上下文/并发 | 32/32 TTFT | 35/29 TTFT | 32/32 TPOT | 35/29 TPOT | 32/32 吞吐 | 35/29 吞吐 |
|---|---:|---:|---:|---:|---:|---:|
| 1K/C1 | 273ms | 268ms | 50.1ms | 48.9ms | 18.5 | 19.1 |
| 1K/C2 | 317ms | 447ms | 56.6ms | 56.3ms | 32.9 | 33.9 |
| 1K/C4 | 865ms | 735ms | 67.4ms | 69.7ms | 56.4 | 55.9 |
| 1K/C8 | 1739ms | 1468ms | 87.4ms | 83.6ms | 89.2 | 93.0 |
| 1K/C16 | 6653ms | 6555ms | 84.7ms | 86.3ms | 87.5 | 93.6 |
| 2K/C1 | 510ms | 506ms | 50.4ms | 49.3ms | 17.2 | 17.6 |
| 2K/C2 | 551ms | 943ms | 65.0ms | 61.0ms | 29.0 | 29.5 |
| 2K/C4 | 1199ms | 1884ms | 86.4ms | 81.6ms | 45.7 | 46.4 |
| 2K/C8 | 3749ms | 3711ms | 122.2ms | 116.6ms | 64.2 | 65.0 |
| 2K/C16 | 10679ms | 9860ms | 132.2ms | 134.2ms | 61.0 | 63.9 |

十场景平均变化如下：

- 平均 TTFT -3.22%，P95 TTFT -0.60%。
- 平均 TPOT -2.00%，P95 TPOT -1.85%。
- 平均端到端延迟 -1.89%，P95 端到端延迟 -1.23%。
- 输出吞吐 +3.24%。
- 320/320 请求成功，输出有效率和质量门禁均为 100%。

C2/C4 的 P95 TTFT 存在较大波动，因此层切分收益应表述为矩阵平均改善，不能承诺每个独立场景都单调提升。

### 5.3 Profiling 复核

使用相同 C16 mixed workload 对默认分层和 `35/29` 分层分别生成 919 个输出 token。短 profile 中：

- P95 TTFT 从 10219ms 降至 9679ms，P95 TPOT 从 97.2ms 降至 90.6ms。
- 吞吐从 61.6 提升至 69.3 output tok/s。
- rank0 的 Marlin GEMM Self CUDA 从 2.352s 增至 2.535s，rank1 从 3.218s 降至 2.854s，符合三层从末级移到首级后的计算迁移。
- rank1 仍有显著 NCCL recv 等待，说明自回归解码下的 stage 依赖和流水线空泡仍是结构性瓶颈。

profile 使用 64 token 输出上限，仅用于归因，不参与正式质量判定。

### 5.4 DBO 兼容性

vLLM 0.19.1 在启动校验阶段拒绝当前 DBO 配置：microbatching 仅支持 `deepep_low_latency` 或 `deepep_high_throughput` all-to-all backend。当前双 RTX 3090 镜像使用 `allgather_reducescatter` 且没有 DeepEP 内核，因此 DBO 不进入性能矩阵，控制面也会在启动前返回明确错误。

相关证据：

- `logs/inference/pp-tuning/pp-l35-29-full-result.json`
- `logs/inference/pp-tuning/pp-l35-29-profile-c16-result.json`
- `logs/inference/pp-tuning/pp-l35-29-profile-c16-profiler/`
- `logs/inference/pp-tuning/dbo-smoke-failed.log`

## 6. 决策与后续

- 默认生产/实验拓扑继续使用 TP2/PP1。
- PP2 使用 `35/29` 作为最佳实验候选，但不进入默认发布档位。
- PP 层切分已完成优化闭环；当前剩余限制是流水线同步和 stage 间等待，继续微调层数的边际收益有限。
- DBO 在当前 Ampere/DeepEP 依赖条件下不可用，不通过强行更换 backend 绕过启动校验。
- 下一优先级是提高单卡 INT4 量化覆盖率，或验证 Ampere 原生 INT8 路径；目标是取消跨卡并行，而不是在 PCIe 上切换另一种通信方式。
