# 双 RTX 3090 推理框架与 Kernel 优化执行矩阵

## 1. 目标与验收规则

目标模型为 `Qwen3.6-27B-AWQ-INT4`，服务基于 vLLM OpenAI-Compatible API。测试覆盖 1K/2K 上下文、1/2/4/8/16 并发，主要优化 TTFT 和 TPOT，同时要求：

- 请求成功率为 100%；
- 输出非空且格式有效；
- 不以降低输出长度、关闭质量检查或减少请求数换取性能；
- 候选与 baseline 使用相同模型、数据、并发、输出长度和缓存状态；
- 只把完整矩阵中可复现的收益写入最终配置和简历。

## 2. 硬件约束

| 项目 | 实测结论 | 优化含义 |
|---|---|---|
| GPU | 2 x RTX 3090 24 GiB，SM86 | 无原生 FP8 Tensor Core 路径 |
| GPU0 | PCIe 4.0 x16 | 主计算卡 |
| GPU1 | 芯片组 PCIe 4.0 x4 | 双卡通信上限受 x4 链路约束 |
| NVLink | 无 | 不能使用 NVLink AllReduce |
| CUDA Peer Access | 双向 False | 不能做 GPU Direct P2P |
| NCCL 路径 | SHM/direct/direct | 数据经主机共享内存中转 |
| NUMA | 两卡同一 NUMA node | 无跨 NUMA 迁移问题，仍需控制 CPU 亲和性 |

因此，优化原则是保留大 GEMM 的计算效率、减少或隐藏 TP AllReduce，并避免增加细粒度 collective。

## 3. 已完成实验

### 3.1 NCCL 与 PCIe

使用 NVIDIA `nccl-tests` 对 Ring/Tree、1/2/4 channel、P2P/SHM、buffer 和 thread 参数进行扫描。最终采用：

```bash
NCCL_P2P_DISABLE=1
NCCL_SHM_DISABLE=0
NCCL_ALGO=Ring
NCCL_MIN_NCHANNELS=4
NCCL_MAX_NCHANNELS=4
```

在 320 请求完整矩阵中，相比 NCCL auto：

| 指标 | auto | Ring4 SHM | 变化 |
|---|---:|---:|---:|
| 平均 P95 TTFT | 2731.69 ms | 2657.43 ms | -2.72% |
| 平均 P95 TPOT | 70.60 ms | 69.51 ms | -1.55% |
| 平均 P95 E2E | 6540.14 ms | 6349.64 ms | -2.91% |
| 生成吞吐 | 56.69 tok/s | 57.74 tok/s | +1.84% |

结论：`Ring + 4 channels + SHM` 已晋级最终候选配置。

### 3.2 vLLM 版本升级

对比 vLLM 0.19.1 与 0.26.0，保持模型和 Ring4 参数一致。0.26.0 的 E2E 下降约 2.58%，但 TTFT、TPOT 和吞吐没有稳定改善。SM86 上 Sequence Parallel、Async TP、SymmMem 和 fused AllReduce-RMS 路径均不可用。

结论：版本升级可用于后续开发，但不能单独作为性能提升项。

### 3.3 整模型双微批重叠

第一版复用 vLLM UBatch executor：在 RowParallel GEMM 后切换 compute/comm stream，使微批 A 的 NCCL 与微批 B 的计算重叠。

- 单请求 1540-token prefill 可正确完成；
- 并发 8 时 Qwen3.5 混合注意力抛出 `block_table must have shape`；
- 原因是 stock DBO 面向 DP+EP，TP-only 动态切分没有完整处理混合 Attention/Mamba 的 KV metadata。

结论：当前实现淘汰。后续若继续该方向，必须先实现 request-boundary-aware 切分和混合 KV metadata 单测，不能绕过错误继续压测。

### 3.4 RowParallel 层内 GEMM/AllReduce 重叠

第二版不切 attention，在每个大 RowParallel 输入上执行：

```text
compute stream: Marlin GEMM(A) ---------------- Marlin GEMM(B)
comm stream:                    AllReduce(A) ---------------- AllReduce(B)
```

只在 token 数不小于 1024 时启用，decode 保留单 GEMM、单 AllReduce。实现保存在：

- `patches/vllm-v0.26.0/dense-tp-overlap.patch`
- `deploy/vllm/Dockerfile.dense-tp-overlap`
- `configs/serve/qwen36_27b_awq_vllm_tp2_dense_overlap.yaml`

端到端 A/B 结果：

| 场景 | 指标 | eager baseline | overlap | 结论 |
|---|---|---:|---:|---|
| 1K/C8 | P95 TTFT | 1820 ms | 1827 ms | -0.38% |
| 1K/C8 | P95 TPOT | 55.87 ms | 66.86 ms | -19.67% |
| 2K/C8 | P95 TTFT | 3913 ms | 4005 ms | -2.35% |
| 2K/C8 | P95 TPOT | 55.31 ms | 56.20 ms | -1.60% |

两组成功率和输出有效率均为 100%。微基准能隐藏部分 NCCL 时间，但真实 Marlin kernel 被拆成两个较小 M 维后，GEMM 利用率损失、额外 launch 和第二次 collective 的代价更大。

结论：该配置明确标记为 `rejected`，不进入生产和简历收益数据。

### 3.5 编译与 CUDA Graph 模式

对 vLLM 0.26.0 拆分测试 eager、compile-only、PIECEWISE Graph 和默认 FULL+PIECEWISE Graph。8 请求短矩阵一度显示 PIECEWISE 在 2K/C8 更优，但 320 请求完整矩阵没有复现该优势。

| 完整矩阵平均值 | 默认 FULL+PIECEWISE | PIECEWISE-only | PIECEWISE 变化 |
|---|---:|---:|---:|
| P95 TTFT | 2663.89 ms | 2696.89 ms | +1.24% |
| P95 TPOT | 69.99 ms | 70.26 ms | +0.38% |
| P95 E2E | 6186.09 ms | 6356.21 ms | +2.75% |
| 生成吞吐 | 57.46 tok/s | 56.95 tok/s | -0.89% |

两组均为 320/320 请求成功、输出有效率 100%。compile-only 相比 eager 在 1K/C8 可改善 TTFT、TPOT 和吞吐，说明 Inductor/launch 合并本身有效；默认混合图在多数场景进一步降低 TPOT。PIECEWISE-only 的短样本优势属于尾延迟随机波动，完整矩阵后淘汰。

结论：保留 vLLM 默认 `FULL_AND_PIECEWISE`，不覆盖 `cudagraph_mode`。

### 3.6 RMSNorm 与 Attention Kernel

强制 `vllm_c` RMSNorm/`fused_add_rms_norm` 并锁定 Marlin linear backend 后，完整矩阵平均 TPOT 改善 0.69%、吞吐提高 1.06%，但 E2E 回退 1.74%，TTFT 基本持平。短矩阵中 2K/C8 的异常大收益没有在 full32 复现，因此不晋级。

将 full-attention backend 从 FlashAttention2 改为 FlashInfer 后：

| 指标 | FlashAttention2 | FlashInfer | 变化 |
|---|---:|---:|---:|
| 平均 P95 TTFT | 2663.89 ms | 2659.46 ms | -0.17% |
| 平均 P95 TPOT | 69.99 ms | 69.65 ms | -0.49% |
| 平均 P95 E2E | 6186.09 ms | 6201.22 ms | +0.24% |
| 生成吞吐 | 57.46 tok/s | 58.26 tok/s | +1.38% |

FlashInfer 在 1K/C16 有收益，但 2K/C16 TPOT 回退。Qwen3.6-27B 的 64 层中只有 16 层使用 full attention，另外 48 层仍由 Qwen GDN Triton/FLA kernel 执行，因此更换 full-attention backend 的整体影响有限。

结论：两项都保留为可选实验 profile，不进入统一默认配置。

### 3.7 Torch Profiler 定量归因

在 vLLM 0.26.0、AWQ TP2、2K/C8 场景下采集两张卡的 CPU/CUDA trace。原始 trace 和算子表位于 `logs/profiles/qwen36-v026/`。

| Rank | NCCL AllReduce Self CUDA | Marlin GEMM | `aten::mm` | FlashAttention2 | Qwen GDN core |
|---|---:|---:|---:|---:|---:|
| GPU0/rank0 | 3.429s，59.83% | 1.426s，24.88% | 473ms，8.26% | 34ms，0.59% | 15ms，0.27% |
| GPU1/rank1 | 2.591s，45.35% | 1.929s，33.76% | 662ms，11.59% | 45ms，0.79% | 24ms，0.42% |

一次 profile 内有 1548 次 NCCL AllReduce kernel。两张卡的 NCCL 与 GEMM 合计均超过 Self CUDA 的 84%，而 attention、GDN 和 norm 单项均低于 1%。GPU1 的 Marlin 和 FP16 GEMM 明显慢于 GPU0，和其芯片组 PCIe x4、桌面显示负载及运行时频率差异一致。

结论：后续优化优先级应为通信路径和大 GEMM，不能继续把主要精力投入 attention/norm 小算子。PyTorch Profiler 已给出 kernel 级占比；Nsight Systems/Compute 已安装，但在线服务运行在 Docker 多进程边界内，且 GPU1 同时承担桌面显示。为避免 profiler 注入和显示进程干扰正式 A/B，本轮不把 Nsight 采集结果作为收益证据。

### 3.8 KV Cache FP8

旧 FP8 权重服务在 `gpu_memory_utilization=0.90`、C16 下测试 FP8 KV 时，GPU1 仅剩约 153MiB，Marlin 申请 136MiB workspace 后 OOM。为区分“技术不可用”和“显存预算过高”，又在 AWQ、0.85、C8 基线下复测两次。

| 场景 | 普通 KV TTFT/TPOT | FP8 KV 第一次 | FP8 KV 重复 |
|---|---:|---:|---:|
| 1K/C8 | 1656ms / 46.55ms | 7996ms / 117.02ms | 7977ms / 113.73ms |
| 2K/C8 | 3752ms / 91.57ms | 3716ms / 80.54ms | 3660ms / 46.31ms |

FP8 KV 可正常启动，并将静态服务显存降低约 0.5--0.8GiB，但 1K/C8 两次均严重回退。该模式还迫使 full-attention backend 从 FlashAttention2 切换为 FlashInfer；checkpoint 没有 KV calibration scale，vLLM 使用默认 scale，1K 样本参考答案通过率从 0.625 降到 0.375。2K 的局部收益不足以覆盖稳定性和质量风险。

结论：作为更长上下文/更高并发的容量实验保留，延迟默认档保持 `kv_cache_dtype=auto`。

### 3.9 投机解码

已验证两类投机解码：

- N-gram 3-token：接受率 `81/777=10.4%`，同一 C16 混合负载的 TPOT 从约 131.26ms 升到 199.09ms，吞吐从 89.70 降到 64.60 tok/s，淘汰。
- 独立 Qwen3.5-4B draft：vLLM 0.26.0 将该路径解析为 Qwen3.5 MTP，加载时目标隐藏维 5120 与 draft 隐藏维 2560 不匹配，报 `The size of tensor a (5120) must match ... b (2560)`。这不是显存不足，而是独立小模型权重不满足目标模型配套 MTP 层的结构约束。

结论：当前模型没有兼容的 MTP/EAGLE draft checkpoint，不能通过参数调整修复。以后只有取得与目标模型隐藏维、词表和 MTP 结构匹配的 draft 权重后才值得重测。

## 4. 完整实验矩阵与状态

| 层级 | 实验项 | 状态 | 晋级条件 |
|---|---|---|---|
| 通信 | Ring/Tree、channel、protocol、buffer、threads | 已完成 | 完整矩阵 TTFT/TPOT 改善 |
| 通信 | CPU affinity、NUMA、SHM buffer 路径 profiling | 已完成拓扑判断 | 单 NUMA，无跨 NUMA 迁移；Ring4 SHM 晋级 |
| 框架 | Prefix Cache、Chunked Prefill、连续批处理 | 已完成基础 A/B | 按 cache hit/miss 分层报告 |
| 框架 | `max_num_batched_tokens`、`max_num_seqs`、调度策略 | 已完成基础扫描 | 找到 1K/2K、C1-C16 Pareto 前沿 |
| 框架 | TP2/PP2、PP 32/32 与 35/29 | 已完成 | PP 只作为显存方案，TP2 保持性能主线 |
| 框架 | TP-only 整模型双微批 | 已尝试/失败 | 修复混合 KV metadata 后重测 |
| 框架 | CUDA Graph NONE/PIECEWISE/FULL | 已完成 | 默认 FULL+PIECEWISE 晋级 |
| 框架 | 编译 pass 与 capture size | 已完成主体 | compile 有效，保留默认 capture 策略 |
| Kernel | Marlin 大 GEMM 层内切分 | 已尝试/回退 | 拆 M 降低 GEMM 利用率，淘汰 |
| Kernel | `fused_add_rms_norm` backend A/B | 已完成 | 完整矩阵无稳定综合收益 |
| Kernel | AllReduce + RMSNorm 融合 | 架构不支持 stock 实现 | 仅在 SM86 自定义实现可验证时继续 |
| Kernel | FlashAttention2/FlashInfer attention backend | 已完成 | FlashInfer 仅局部收益，不晋级 |
| Kernel | Qwen GDN Triton warmup/shape cache | 已归因 | Self CUDA < 0.5%，不是优先瓶颈 |
| 量化 | AWQ W4A16、FP8、BF16 对比 | 已完成主体 | 同时报告显存、质量和性能 |
| 量化 | KV Cache FP8 | 已完成/回退 | 1K/C8 延迟和质量回退，淘汰 |
| 解码 | N-gram speculative decoding | 已完成/回退 | 接受率低，TPOT +51.7% |
| 解码 | Qwen3.5-4B draft | 已完成/启动失败 | 隐藏维与 MTP 结构不匹配 |
| 观测 | PyTorch CUDA trace | 已完成 | NCCL + GEMM 占比超过 84% |
| 观测 | Nsight Systems/Compute | 工具可用，未作为 A/B | Docker 注入与显示卡负载会污染正式结果 |
| 系统 | GPU 锁频/桌面负载隔离 | 权限阻塞 | 需要 sudo；不能终止用户桌面进程 |

## 5. 最终默认配置

严格以 TTFT/TPOT 为主时，保留 vLLM 0.19.1 + AWQ TP2 + Ring4 SHM：

```yaml
tensor_parallel_size: 2
pipeline_parallel_size: 1
dtype: float16
max_model_len: 4096
gpu_memory_utilization: 0.85
max_num_seqs: 8
max_num_batched_tokens: 4096
enable_prefix_caching: true
enable_chunked_prefill: true
disable_custom_all_reduce: true
kv_cache_dtype: auto
```

```bash
NCCL_P2P_DISABLE=1
NCCL_SHM_DISABLE=0
NCCL_ALGO=Ring
NCCL_MIN_NCHANNELS=4
NCCL_MAX_NCHANNELS=4
```

vLLM 0.26.0 可作为功能开发档：其完整矩阵 E2E 更低，但 TTFT/TPOT 没有超过 0.19.1 Ring4。两档都保留默认 `FULL_AND_PIECEWISE` CUDA Graph 策略。

## 6. 当前可用于简历的真实优化

当前可量化、可复现的自研与调优内容是：硬件拓扑归因、NCCL 通信扫描、TP/PP A/B、PP 层负载均衡、AWQ 转换与质量回归、完整服务压测和失败重叠方案的设计验证。自研 GEMM/NCCL 重叠目前属于“完成原型与瓶颈验证，但未晋级生产”，在取得正收益前不能写成性能提升。
