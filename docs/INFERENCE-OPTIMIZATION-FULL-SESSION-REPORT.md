# Qwen3.6-27B 推理优化全流程复盘

## 1. 文档范围与最终结论

本文汇总本次会话中围绕 `Qwen3.6-27B` 完成的全部推理优化工作，覆盖：

1. FP8 模型 baseline 建立与共享前缀缓存。
2. 连续批处理、调度预算、异步调度、显存和上下文参数扫描。
3. FP8 KV Cache、推测解码、优先级调度、Custom AllReduce 等失败边界验证。
4. PyTorch Profiler、vLLM iteration details 和 GPU 指标联合归因。
5. BF16 原始模型到 AWQ W4A16 的量化、质量回归和服务优化。
6. Tensor Parallel 2 与 Pipeline Parallel 2 的完整 A/B。
7. PP 层切分 `32/32 -> 35/29` 和 DBO microbatching 可行性验证。
8. 基于 PCIe 拓扑的 NCCL tests、Ring/channel/thread/buffer 扫描和端到端回归。
9. vLLM 0.19.1/0.26.0、Torch Compile、CUDA Graph、attention/norm kernel 的完整 A/B。
10. 两版计算通信重叠原型、FP8 KV、独立 draft 模型投机解码及失败根因分析。

最终结论不是“某一个开关解决全部问题”，而是形成了分层决策：

- **收益最大且已采纳**：面向固定客服系统提示词和政策文本的 Prefix Caching。
- **默认均衡档**：FP8、TP2、`max_num_seqs=8`、`max_num_batched_tokens=4096`，优先保证 TPOT 与端到端延迟。
- **高并发档**：`16/8192`，以 TPOT 回退换取更低 C16 TTFT 和更高吞吐。
- **量化发布候选**：AWQ W4A16 TP2，解决模型体积和量化链路问题，但在 RTX 3090 上没有获得显著推理速度提升。
- **并行拓扑决策**：无 NVLink 的双 3090 上继续使用 TP2。PP2 即使经过 `35/29` 分层优化，TPOT 和吞吐仍不如 TP2。
- **结构性瓶颈**：PCIe/NCCL 通信、3090 非原生 FP8 Marlin 路径，以及 PP 自回归 decode 的 stage 等待。
- **硬件感知通信优化**：根据 GPU1 PCIe 4.0 x4、无 P2P 的事实固定 Ring4 SHM，完整矩阵 P95 TTFT -2.72%、TPOT -1.55%、吞吐 +1.84%。
- **框架/Kernel 结论**：保留默认 FULL+PIECEWISE CUDA Graph；FlashInfer、强制 RMSNorm、FP8 KV 和两版自研 overlap 均未通过综合回归。

## 2. 实验环境与模型

| 项目 | 实际配置 |
|---|---|
| GPU | 单机双 NVIDIA RTX 3090 24GB |
| GPU 互联 | PCIe，无 NVLink，无可用 CUDA P2P |
| 推理框架 | vLLM 0.19.1/0.26.0，V1 engine |
| API | OpenAI-Compatible API，SSE 流式响应 |
| FP8 模型 | `/mnt/nvme-data/models/LLM_model/Qwen3.6-27B-FP8` |
| BF16 原始模型 | `/mnt/nvme-data/models/LLM_model/Qwen3.6-27B` |
| AWQ 模型 | `/mnt/nvme-data/models/LLM_model/Qwen3.6-27B-AWQ-INT4` |
| 实际模型架构 | `Qwen3_5ForConditionalGeneration`，64 层混合 GDN/Attention 架构 |
| 压测数据 | DianJin-CSC 中文客服固定切片 |
| 核心矩阵 | 1K/2K 上下文，C1/C2/C4/C8/C16 |

RTX 3090 是 Ampere SM86。它有 FP16/BF16 Tensor Core，但没有面向新一代 FP8 指令路径的原生 FP8 Tensor Core。因此 `Qwen3.6-27B-FP8` 在本机不是“原生 FP8 计算”，vLLM 实际使用 Marlin weight-only FP8 kernel，并以 BF16/FP16 参与激活计算。

### 2.1 推进过程

| 阶段 | 核心问题 | 执行动作 | 阶段结论 |
|---|---|---|---|
| FP8 baseline | 服务能否稳定运行，初始瓶颈在哪里 | 建立 TP2 保守配置和 1K/2K x C1--C16 矩阵 | 正确性通过，高并发 prefill 排队明显 |
| 缓存 | 客服共享前缀能否复用 | Prefix Cache off/on A/B | 命中率 78.4%，成为最大有效优化 |
| 调度 | TTFT、TPOT、吞吐如何取舍 | 扫描 seqs、batch tokens、async、priority、partial prefill | 固化 `8/4096` 与 `16/8192` 两档 |
| 显存/KV | 增加 KV 容量是否继续改善性能 | 扫描 memory utilization、model len、FP8 KV | 找到 OOM 和稳定边界，保留 0.90/4096/auto |
| Decode | 能否减少主模型 decode 次数 | N-gram speculation | 接受率过低，淘汰 |
| Profiling | 到底是 attention、GEMM 还是通信拖慢 | PyTorch Profiler + iteration details + GPU 指标 | 主瓶颈是 NCCL 与 Marlin，不是 FlashAttention |
| AWQ | INT4 能否降低显存并在 3090 上加速 | BF16 -> W4A16、质量回归、调度扫描 | 压缩成功，速度基本持平，继续需要 TP2 |
| 并行拓扑 | 无 NVLink 时 TP2 还是 PP2 更合适 | 完整 TP2/PP2 A/B + profiling | PP2 TTFT 局部更好，TPOT/吞吐更差 |
| PP 优化 | PP 空泡能否通过负载均衡缓解 | 32/32--36/28 分层和 DBO 冒烟 | `35/29` 小幅改善；DBO 被 DeepEP 依赖阻断 |

## 3. 压测与质量门禁

### 3.1 指标定义

- **TTFT**：请求发出到第一个非空 content delta 到达的时间，包含排队和 prefill。
- **TPOT**：`(端到端延迟 - TTFT) / (输出 token 数 - 1)`，反映首 token 之后的平均生成速度。
- **端到端延迟**：请求开始到流结束的总时间。
- **P95**：同一场景中 95 分位延迟，用于观察尾延迟和排队抖动。
- **生成吞吐**：场景总输出 token 数除以场景墙钟时间，单位 output tok/s。
- **成功率**：HTTP/SSE 完整返回且没有服务错误的请求比例。
- **输出有效率**：输出非空、UTF-8 合法且结构可解析的比例。
- **质量门禁**：成功、非空、无敏感凭据、无异常截断，并满足客服答案检查规则。
- **显存占用**：每个场景前后通过 `nvidia-smi` 采集两张卡的显存、利用率、温度和功耗。

### 3.2 实验控制

- 每轮服务启动时保存真实 vLLM launch config。
- benchmark 提交前，Go 控制面对请求参数和运行中配置做一致性校验；不一致返回 `409 inference_config_mismatch`。
- 训练与推理共用单机 GPU 实验通道，不要求同时运行，后端实施互斥。
- 正式结论使用独立冷启动或明确标记的 runtime 复用实验。
- PyTorch Profiler 会改变运行开销，因此 profile 只用于归因，不参与正式性能决策。
- 所有优化首先满足成功率和输出质量，再比较 TTFT、TPOT、P95 和吞吐。

## 4. FP8 初始基线

初始保守配置为：

```yaml
model: /mnt/nvme-data/models/LLM_model/Qwen3.6-27B-FP8
tensor_parallel_size: 2
pipeline_parallel_size: 1
dtype: auto
quantization: fp8
max_model_len: 4096
gpu_memory_utilization: 0.90
max_num_seqs: 8
max_num_batched_tokens: 4096
enable_prefix_caching: false
enable_chunked_prefill: true
disable_custom_all_reduce: true
kv_cache_dtype: auto
```

选择 TP2 是因为单张 24GB 3090 无法稳定容纳该模型及执行 workspace。初始 baseline 的作用是先建立可重复、正确的服务，不预设 FP8 在 3090 上一定更快。

### 4.1 vLLM 已有算法

以下能力由 vLLM runtime 提供，不是项目手写 CUDA 实现：

- **PagedAttention**：把 KV Cache 划分为固定大小 block，通过逻辑页映射避免为每条序列预留连续大块显存，降低碎片并支持动态批处理。
- **Continuous Batching**：每次调度迭代动态加入新请求、移除完成请求，而不是等待整个静态 batch 一起完成。
- **Chunked Prefill**：把过长 prompt 的 prefill 拆成受 token budget 限制的块，避免一次 prefill 独占整个 batch。
- **FlashAttention 2**：通过 tiled attention 降低显存读写；本模型 attention 层由 vLLM 自动选择对应 kernel。
- **CUDA Graph**：对稳定 decode shape 捕获并复用 GPU launch graph，减少 CPU launch overhead。
- **融合算子**：RMSNorm、Rotary、量化 GEMM 周边融合由 vLLM、TorchInductor、Triton 和 Marlin 提供。

这些能力构成 baseline。后续工作是根据本机硬件和客服 workload 调整它们的参数与组合，而不是重复实现底层算法。

## 5. 第一轮优化：Prefix Caching

### 5.1 算法机制

客服请求通常共享较长的 system prompt、服务政策和回答约束。Prefix Caching 对已经完成 prefill 的相同 token block 保存 KV 或等价中间状态；新请求命中相同前缀时，跳过这部分重复计算，只处理不同的用户问题。

它主要减少 prefill，因此直接改善 TTFT。高并发时，prefill 计算减少也会释放批处理预算和 GPU 时间，间接改善 TPOT 与吞吐。

### 5.2 实验结果

- Baseline run：`efdcc446-5d9a-4c01-8527-1b4d0405678f`。
- Prefix run：`966ed21f-4657-4b1e-a63f-6f126afd338f`。
- 两轮均为 160/160 请求成功、质量门禁 100%、无截断。
- 查询 238,130 个 prefix token，命中 186,592 个，命中率约 78.4%。
- 对每个场景分别计算变化后，十场景降幅的算术平均为 P95 TTFT -70.4%、P95 TPOT -44.4%，吞吐变化的算术平均为 +118.3%。

| 配置 | 平均 P95 TTFT | 平均 P95 TPOT | 平均 P95 E2E | 平均吞吐 |
|---|---:|---:|---:|---:|
| Prefix off | 10623ms | 160.4ms | 16161ms | 25.41 |
| Prefix on | 2827ms | 65.5ms | 6365ms | 56.45 |

该数字代表固定客服问题在完整矩阵中重复访问后的暖缓存收益。冷启动并发 1 的保守对照中，1K/2K P95 TTFT 分别降低约 30.9% 和 66.8%。因此不能把 70% 收益外推到没有共享前缀或完全冷缓存的流量。

**决策：采纳。** FP8 和 AWQ 的客服服务均开启 Prefix Caching。

## 6. 第二轮优化：调度与连续批处理

### 6.1 `max_num_seqs`

`max_num_seqs` 控制一次调度中最多同时处于 running 状态的序列数。

- 值较小：单请求分到的计算资源更多，TPOT 通常更稳，但高并发请求需要排队，TTFT 可能升高。
- 值较大：更多请求同时 decode，可降低排队并提高总吞吐，但每条请求的 token 生成间隔可能变长。

扫描 `8/12/16` 后，`8` 保持较低 TPOT；`16` 对 C16 TTFT 和吞吐有明显收益；`12` 不在 Pareto 前沿。

### 6.2 `max_num_batched_tokens`

该参数限制一次 scheduler iteration 可以处理的总 token 数，包含 prefill 和 decode token。

- 预算过小：长 prompt 被拆成更多轮，TTFT 增加。
- 预算过大：单轮 prefill 占用时间和 workspace 增大，也可能挤压 decode 或带来显存风险。

扫描 `2048/4096/8192` 后，`seqs=8` 时 `8192` 相对 `4096` 没有稳定收益；`8192` 只与 `seqs=16` 组成高并发档。

### 6.3 公平矩阵结果

固定 1K/2K、C8/C16、每场景 32 请求、128 输出 token：

| 配置 | 平均 P95 TTFT | 平均 P95 TPOT | 平均 P95 E2E | 输出吞吐 | 结论 |
|---|---:|---:|---:|---:|---|
| `8/4096` | 6063ms | 97.5ms | 11257ms | 80.4 | 默认均衡档 |
| `8/8192` | 6213ms | 97.1ms | 11187ms | 80.3 | 无稳定收益 |
| `12/8192` | 6096ms | 115.6ms | 12091ms | 85.3 | 非 Pareto 最优 |
| `16/8192` | 4883ms | 130.8ms | 11343ms | 92.3 | 高并发档 |

`16/8192` 相对 `8/4096`：P95 TTFT -19.5%、吞吐 +14.8%，但 P95 TPOT +34.1%，端到端 P95 +0.8%。它是明确的性能取舍，不是全指标同时优化。

### 6.4 其他调度参数

| 方向 | 结果 | 决策 |
|---|---|---|
| Async scheduling | on/off 差异约 1%--3%，开启时 E2E P95 略低 | 均衡档保持开启 |
| Priority scheduler | 1K TTFT +5.4%，2K TTFT +43.8%，长请求饥饿 | 淘汰，保持 FCFS |
| `scheduler_reserve_full_isl` | 关闭后局部改善，但完整矩阵 2K/C16 TPOT 恶化至 170ms | 保持开启 |
| Concurrent partial prefill | Qwen3.6 混合架构在 vLLM 0.19.1 启动时拒绝 | 固定 `1/1` |

## 7. 第三轮优化：显存、KV Cache 与上下文边界

### 7.1 `gpu_memory_utilization`

该参数决定 vLLM 为模型、KV Cache 等用途预留的 GPU 显存比例。它不是越高越好：执行 kernel 仍需要临时 workspace。

- `0.90`：稳定。
- `0.92`：Marlin GEMM 申请约 108MiB workspace 时 CUDA OOM。

**决策：FP8 保持 0.90，AWQ 保持更保守的 0.85。**

### 7.2 `max_model_len`

将 `4096` 降到 `3072` 没有带来预期收益：TTFT +2.0%、TPOT +10.2%，只有端到端 P95 -3.3%。减少最大长度能改变 KV 规划，但当前瓶颈不是单纯 KV 容量。

**决策：保持 4096。**

### 7.3 FP8 KV Cache

FP8 KV Cache 理论上可减少 KV block 显存，从而容纳更多并发或更长上下文。本次 checkpoint 没有 q/k/v/prob 的校准 scale，vLLM 只能使用 1.0；正式混合负载最终触发 CUDA OOM 和请求停滞。

**决策：淘汰，保持 `kv_cache_dtype=auto`。** 权重 FP8 与 KV Cache FP8 是两件事，不能因为模型权重是 FP8 就默认 KV Cache 也适合 FP8。

## 8. 第四轮优化：推测解码与通信路径

### 8.1 N-gram Speculative Decoding

N-gram 推测解码从 prompt 或已生成文本中预测未来多个 token，再由主模型一次验证。只有接受率足够高，减少的主模型迭代次数才能覆盖验证成本。

本次 3-token n-gram 的接受率为 `81/777=10.4%`，最终 TPOT +51.7%、吞吐 -28.0%。中文客服回答没有足够稳定的长 n-gram 重复，额外验证开销超过收益。

**决策：淘汰，`speculative_decoding=none`。**

### 8.2 Custom AllReduce

TP2 中每层需要对两张卡的部分结果做 collective communication。vLLM 的 Custom AllReduce 在合适 P2P 拓扑下可以减少 NCCL 开销，但本机双 3090 无法通过 P2P 自检，运行时自动回退 NCCL。

**决策：显式 `disable_custom_all_reduce=true`。** 这样避免配置看似开启、实际回退造成误判。

## 9. Profiling：从参数扫描转向瓶颈归因

### 9.1 Prefill 与 decode

C16、75% 1K + 25% 2K 的 mixed profile 显示：

- 4 个 prefill/mixed iteration 分别约 1602、911、1515、3405ms，合计约 7.43s。
- 稳态 16 路 decode 每轮约 55--63ms。
- 19,717 个 prompt token 中本地 prefix cache 命中 14,112，来源口径命中率约 71.6%。

因此高并发 TTFT 主要来自分批 prefill 和 scheduler queue；TPOT 则主要受每轮 decode GEMM 和跨卡同步影响。

### 9.2 GPU 算子

TP2 PyTorch Profiler 显示：

- NCCL BF16 ring all-reduce 占 Self CUDA 约 45%--61%。
- Marlin FP8 GEMM 占约 30%--42%。
- FlashAttention varlen forward 约 0.5%。
- GDN/Mamba kernel 有可见开销，但不是最高项。

这排除了“attention kernel 是主瓶颈”的假设。PagedAttention、FlashAttention、CUDA Graph 和已有融合已经启用，继续调整 attention 细节的收益上限较低。真正的限制是：

1. TP2 每层都要经过 PCIe/NCCL 同步。
2. RTX 3090 没有原生 FP8 Tensor Core，FP8 权重走 Marlin fallback。
3. 高并发下 prefill 与 decode 竞争 scheduler token budget。

## 10. 第五轮优化：AWQ W4A16 量化

### 10.1 为什么做 AWQ

FP8 Profiling 已证明 3090 并没有获得理想的原生 FP8 计算收益。AWQ 的目标是验证更适合 Ampere 的 INT4 weight-only 路径，并尝试降低模型体积、显存和跨卡部署压力。

AWQ 并不保证自动加速。速度是否提升取决于：

- 实际被量化的层比例。
- Marlin WNA16 kernel 的形状和 batch 效率。
- 仍以 FP16/BF16 计算的激活、GDN 和未量化模块。
- TP2 的 NCCL 通信是否仍占主导。

### 10.2 量化算法与配置

采用 LLM Compressor 的 activation-aware weight quantization：

```yaml
scheme: W4A16_ASYM
num_bits: 4
group_size: 128
symmetric: false
targets: [Linear]
duo_scaling: both
num_calibration_samples: 128
max_seq_length: 1024
pipeline: sequential
```

算法过程：

1. 从 DianJin 客服 SFT 训练集按固定 seed 42 做 reservoir sampling，生成 128 条校准样本。
2. 使用模型原生 chat template 构造校准文本，避免校准格式与真实推理格式不一致。
3. AWQ 根据激活分布搜索权重缩放，使量化误差更多落在不敏感通道。
4. Linear 权重按 group size 128 做非对称 INT4 量化，激活保持 FP16/BF16，即 W4A16。
5. 使用双 GPU、CPU sequential offload 和单样本 batch 完成 oneshot 校准。
6. 保留 `lm_head`、视觉塔和 `linear_attn` 为非 INT4。

`linear_attn` 不量化不是为了追求精度，而是因为 SM86 上 Marlin 在 TP2 分片后不能运行 Qwen3.6 GDN projection 的对应形状。视觉塔以 BF16 单独恢复，保证多模态 checkpoint 结构完整。

完整转换耗时 3396.6 秒，约 56.6 分钟。模型目录体积由 BF16 的约 52GB 降至约 26GB；FP8 checkpoint 约 29GB。AWQ 没有达到理论上的全模型 4-bit 体积，是因为大量 GDN `linear_attn`、`lm_head` 和视觉塔仍保持高精度。

### 10.3 输出质量修复

初始 AWQ 服务成功率为 100%，但部分答案在正文后重复表情直到 `max_tokens`，完整质量通过率只有 50%。如果直接用这些截断答案做性能对比，会得到虚假的低延迟或错误的 TPOT。

最终请求侧约束为：

```yaml
temperature: 0
frequency_penalty: 1.0
stop: [常见客服回复表情序列]
```

固定样本回归后，成功率、输出有效率和完整质量门禁均为 100%，截断率为 0。

### 10.4 AWQ 优化结果

AWQ 自身的 Prefix Cache 矩阵中：

- 160/160 请求成功且质量门禁通过。
- prefix token 命中率约 78.4%。
- 相对 AWQ prefix-off baseline，十场景平均 P95 TTFT -70.0%、P95 TPOT -46.8%、P95 E2E -53.9%、吞吐 +127.1%。

AWQ 调度扫描再次确认 `8/4096` 最稳：

- `16/8192` 的 C16 TTFT 约改善 5%，但 TPOT 回退约 36%--46%。
- 单独 `max_num_seqs=16` 的 TPOT 回退约 46%--51%。
- TP1 无 offload 在 `lm_head` 初始化时 OOM。
- TP1 + 4GiB CPU offload 虽通过权重初始化，TorchInductor 编译仍缺约 2.37GiB 显存。

因此 AWQ 最终仍采用 TP2。

### 10.5 AWQ 为什么没有明显快于 FP8

FP8 Prefix Cache 矩阵与 AWQ 最终矩阵的输入 token 总数相同，均为 238,130，但两轮 `max_tokens`、生成约束和输出 token 数不同，因此只能做方向性观察，不能作为严格量化 A/B：

| 指标 | FP8 Prefix | AWQ Final | 方向性变化 |
|---|---:|---:|---:|
| 平均 P95 TTFT | 2826.5ms | 2872.6ms | AWQ +1.6% |
| 平均 P95 TPOT | 65.48ms | 65.75ms | AWQ +0.4% |
| 平均吞吐 | 56.45 | 57.37 | AWQ +1.6% |
| 峰值显存 | 23099MiB | 22704MiB | AWQ -1.7% |

结果说明 AWQ 在当前实现中主要提供模型压缩和部署验证，没有形成显著速度优势。原因包括：

1. GDN `linear_attn` 大量保留高精度，INT4 覆盖率有限。
2. W4A16 只压缩权重，激活和 KV Cache 仍是高精度。
3. TP2 的 PCIe/NCCL 成本没有因为 INT4 权重自动消失。
4. 3090 上 Marlin INT4 的解包、缩放和小 batch kernel 开销抵消部分显存带宽收益。

## 11. 第六轮优化：TP2 与 PP2

### 11.1 两种并行算法

**Tensor Parallel 2** 将每层矩阵按列或行切到两张卡。两张卡同时计算同一层，但多数层需要 AllReduce/AllGather 聚合结果。优点是没有流水线 stage 空泡；缺点是每层都有跨卡通信。

**Pipeline Parallel 2** 将完整层分为两个连续 stage。请求先经过 GPU0 的前半模型，再把隐藏状态发送到 GPU1 的后半模型。优点是取消逐层 AllReduce；缺点是存在 stage 依赖、点对点 SendRecv 和流水线空泡。

vLLM 0.19.1 V1 PP runtime 在 PP2 下最多保持两个 scheduler batch in-flight，并使用非阻塞 `isend/irecv` 传递中间张量；当前没有 virtual pipeline 或 interleaved 1F1B 之类的更多虚拟 stage 调度。对自回归 decode 来说，每个 token 都必须再次串行穿过两个 stage，因此很难像训练 microbatch 那样把流水线完全填满。

### 11.2 完整 A/B

固定 1K/2K x C1/C2/C4/C8/C16、每场景 32 请求、128 输出 token：

| 拓扑 | 平均 P95 TTFT | 平均 P95 TPOT | 平均 P95 E2E | 吞吐 |
|---|---:|---:|---:|---:|
| TP2/PP1 | 2784.8ms | 72.2ms | 6776.5ms | 55.38 |
| TP1/PP2，默认 32/32 | 2653.6ms | 80.2ms | 7234.2ms | 50.17 |

PP2 相对 TP2：P95 TTFT -4.7%，P95 TPOT +11.1%，P95 E2E +6.8%，吞吐 -9.4%。两轮各 320 请求，成功率与质量门禁均为 100%。

### 11.3 Profiling 归因

| 拓扑/Rank | Marlin FP8 GEMM | NCCL AllReduce | NCCL SendRecv |
|---|---:|---:|---:|
| TP2 rank0 | 35.1% | 55.5% | 0% |
| TP2 rank1 | 50.0% | 37.5% | 0% |
| PP2 rank0 | 89.9% | 0% | 0.5% |
| PP2 rank1 | 71.6% | 0% | 12.7% |

PP2 的确消除了逐层 AllReduce，但 GPU0/GPU1 利用率约为 85%/99%，显存约 20.5/23.6GB。默认平均切层并不等于平均负载：末级还承担最终 norm、输出头、采样和更明显的接收等待。

**决策：TP2 继续作为默认拓扑。**

## 12. 第七轮优化：PP 层切分与 DBO

### 12.1 自定义层切分

模型共有 64 层。通过 `VLLM_PP_LAYER_PARTITION` 扫描：

- `32,32`
- `34,30`
- `35,29`
- `36,28`

核心思路是把更多 Transformer block 放到 GPU0，抵消 GPU1 上最终 norm、lm head、采样和通信等待的附加负载。

固定 1K/2K、C8/C16、32 请求/场景的筛选结果：

| 分层 | 平均 TTFT | 平均 TPOT | 平均 P95 TTFT | 平均 P95 E2E | 吞吐 |
|---|---:|---:|---:|---:|---:|
| 32/32 | 3460.8ms | 90.55ms | 5906.3ms | 11853.6ms | 73.01 |
| 34/30 | 3415.2ms | 90.06ms | 5924.3ms | 11684.4ms | 74.33 |
| 35/29 | 3466.9ms | 87.24ms | 5882.6ms | 11788.2ms | 74.63 |
| 36/28 | 3442.1ms | 87.56ms | 6086.9ms | 11566.5ms | 76.01 |

`36/28` 吞吐最高，但 P95 TTFT 相对 `32/32` 回退约 3.1%；`35/29` 在 TTFT 与 TPOT 间更均衡，因此进入完整矩阵。

### 12.2 `35/29` 完整回归

相对默认 `32/32` 的十场景平均变化：

- 平均 TTFT -3.22%，P95 TTFT -0.60%。
- 平均 TPOT -2.00%，P95 TPOT -1.85%。
- 平均 E2E -1.89%，P95 E2E -1.23%。
- 输出吞吐 +3.24%。
- 320/320 请求成功，输出有效率和质量门禁均为 100%。

Profiling 中，rank0 Marlin GEMM Self CUDA 从 2.352s 增至 2.535s，rank1 从 3.218s 降至 2.854s，证明三层计算确实从末级迁移到首级。但 rank1 仍存在显著 NCCL recv 等待，说明层切分只能调整计算分布，不能消除自回归 PP 的 stage 同步。

优化后的 PP2 相对 TP2 仍有约 9.0% 的 P95 TPOT 回退和约 6.5% 的吞吐回退，所以 `35/29` 只作为 PP 实验最佳候选，不替换 TP2。

### 12.3 DBO Microbatching

DBO 用 decode batch overlap/microbatching 将 batch 拆成更小单元，尝试让通信、不同 stage 或不同请求的计算重叠，以减少流水线空泡。扫描计划使用 decode threshold 4/8、prefill threshold 512。

vLLM 0.19.1 在配置校验阶段明确拒绝当前组合：microbatching 只支持 `deepep_low_latency` 或 `deepep_high_throughput` all-to-all backend。当前 3090 runtime 使用 `allgather_reducescatter`，镜像没有 DeepEP kernel。

**决策：不可用。** 控制面现在会在启动前返回 `409` 和明确的 DeepEP 依赖错误，不再等待容器启动后失败。没有为了跑通实验强制切换到不适配当前硬件的软件栈。

## 13. 机制与算法深度解析

### 13.1 一次推理请求如何拆成 TTFT 和 TPOT

LLM 在线推理不是一次完整 forward，而是两个性质不同的阶段。

**Prefill 阶段**一次处理整段 prompt，计算每一层的隐藏状态，并为后续 token 建立 attention KV Cache 或线性注意力状态。对 full attention 层，计算量会随上下文长度快速增长；对 Qwen3.6 的 GDN/linear attention 层，状态更新更接近线性复杂度。本模型 64 层中有 16 层 full attention、48 层 linear attention，所以它不是纯 Transformer 的统一二次复杂度。

**Decode 阶段**每轮通常为每条活跃序列生成一个 token。新 token 会查询已有 KV Cache 或递归状态，不再重算全部历史 token，但整套 64 层、跨卡通信、lm head 和采样仍需执行一次。生成 N 个 token 就需要约 N 次串行 decode iteration，同一请求的第 `t+1` 个 token 依赖第 `t` 个 token，不能在单请求内部并行完成。

可把两个核心指标近似拆为：

```text
TTFT = 网关/排队 + tokenize + prefill + 首次 decode + 首块网络传输

TPOT = decode forward + 跨卡同步 + scheduler 间隙 + sampling/streaming

E2E ~= TTFT + (output_tokens - 1) * TPOT
```

因此：

- Prefix Cache、chunked prefill 和排队策略首先影响 TTFT。
- GEMM、TP/PP 通信、decode batch 大小首先影响 TPOT。
- 增大并发可能降低排队 TTFT、提高总吞吐，却让单请求 TPOT 变差。
- 只看端到端延迟会把输出长度差异混入性能结论，所以必须同时记录 token 数与 TPOT。

### 13.2 PagedAttention 与 KV Cache 分页

传统实现会为每条请求预留一段连续 KV 显存。请求长度不同、生成长度未知时，容易产生外部碎片和过度预留。PagedAttention 借用了操作系统虚拟内存的思路：

1. 把 GPU KV Cache 切成固定 token 数的物理 block。
2. 每条序列维护逻辑 block table，将逻辑位置映射到任意物理 block。
3. 请求增长时按需分配新 block，不要求物理地址连续。
4. 请求结束或被抢占时，block 回到全局池供其他请求复用。
5. 多个共享前缀请求可以通过引用计数指向相同的只读 block。

对 full attention 层，单 token KV 的主要容量可近似理解为：

```text
KV bytes/token ~= 2 * attention_layers * kv_heads * head_dim * dtype_bytes
```

其中 2 分别代表 K 和 V。Qwen3.6 是 hybrid attention，linear attention 层维护不同形式的递归状态，vLLM 使用 hybrid KV cache coordinator 协调不同 cache spec，不能直接用纯 Transformer 公式估算整个模型。

PagedAttention 主要解决显存分配效率和动态服务能力。它不会减少 GEMM 本身，也不意味着 TTFT 自动下降。Profiler 中 FlashAttention/PagedAttention 相关 kernel 占比很低，说明本次系统已经越过“KV 管理算法没有启用”这一层瓶颈。

### 13.3 Prefix Caching 的 block hash 与最长前缀命中

Prefix Caching 建立在 PagedAttention block 上。vLLM V1 的主要过程是：

1. tokenizer 先把完整 prompt 转成 token id。
2. token 序列按 hash block size 切块，只有完整 block 才能成为稳定缓存单元。
3. 每个 block 的 hash 不只包含当前 token，还链入前一个 block hash，保证相同 token 只有在相同前缀顺序下才命中。
4. LoRA、multi-modal 输入和 cache group 等会作为额外 key，避免不同模型状态错误共享。
5. scheduler 从第一个 block 开始查找，只有连续命中的最长前缀可以复用；中间某块 miss 后，后续 block 即使 hash 存在也不能跳跃复用。
6. 命中的 block 增加引用，未命中的 suffix 才进入 prefill 计算。

可把实际 prefill token 数写成：

```text
prefill_tokens_to_compute = prompt_tokens - contiguous_cached_prefix_tokens
```

命中条件是 token 级完全一致，不是文本“语义类似”。空格、system template、工具定义、消息顺序或 tokenizer 版本变化都会改变 token 和 hash。因而客服系统提示词必须稳定放在 prompt 最前面，动态用户信息放在后面。

Qwen3.6 每 4 层中有 3 层 linear attention、1 层 full attention。递归状态必须与 cache block 边界一致，vLLM 为这类混合模型使用实验性的 `align` 协调模式。它解释了为什么 Prefix Cache 可以使用，但必须继续做版本升级与长稳回归。

### 13.4 Continuous Batching 与 token budget 调度

静态 batching 会等待整个 batch 中最慢请求结束，短请求完成后留下的计算槽不能立刻给新请求。Continuous Batching 在每个 iteration 重建运行集合：

1. 优先处理当前 running 请求。
2. 为 decode 请求通常分配一个新 token。
3. 为尚未完成 prefill 的请求分配 prompt chunk。
4. 在剩余 `token_budget` 和 `max_num_seqs` 范围内接纳 waiting 请求。
5. 请求结束后立即释放 slot 和可回收 KV block，下一轮可以加入新请求。

两个核心限制控制不同维度：

```text
running_request_count <= max_num_seqs
sum(scheduled_tokens_this_step) <= max_num_batched_tokens
```

`max_num_seqs=8` 时，C16 中最多 8 条同时 running，另外 8 条排队，所以后半请求 TTFT 较高；但每个 decode batch 较小，单请求 TPOT 更好。提升到 16 后，排队减少、吞吐上升，但 16 条请求竞争同一轮 GPU 和通信资源，TPOT 变差。

`max_num_batched_tokens` 同时约束 prefill 和 decode。预算过小时 prompt 被切成更多轮；预算过大时长 prefill 可能占据一整个 iteration，并需要更大的临时 workspace。参数必须和 workload 并发、上下文长度一起扫描，不能独立判断。

### 13.5 Chunked Prefill、Full ISL 预留与调度公平性

Chunked Prefill 将一个长 prompt 拆成多个 chunk。例如 2K prompt 不一定在一轮全部执行，而是根据本轮剩余 token budget 分段推进。这样可以在两个 prompt chunk 之间插入已有请求的 decode，降低长 prompt 对在线 token 的阻塞。

它带来的权衡是：

- chunk 小：单轮阻塞短，但需要更多 scheduler iteration 和 launch。
- chunk 大：prefill 效率高，但 decode 请求等待时间可能增加。
- 多个 partial prefill 并发：理论上提高公平性，但需要模型 cache 状态支持。

`scheduler_reserve_full_isl=true` 中的 ISL 是 Input Sequence Length。vLLM 在接纳新请求前检查完整输入序列能否放进 KV Cache，而不是只检查第一个 chunk。否则 scheduler 可能同时接纳很多“首块放得下、完整 prompt 放不下”的请求，随后反复 preempt/recompute，形成 KV thrashing。关闭该保护在短 profile 中可能看似提高利用率，却在正式 2K/C16 中造成 TPOT 恶化。

本模型不支持 concurrent partial prefill，因此 `max_num_partial_prefills=1`。这不是没有开启优化，而是根据 cache/state 兼容性主动固定稳定边界。

### 13.6 Async Scheduling 与流式输出

同步调度中，CPU 要等当前 GPU step 返回结果，更新请求状态后再准备下一轮，两个 kernel batch 之间可能出现空隙。Async Scheduling 允许 CPU 在 GPU 执行当前 step 时准备后续调度信息，目标是减少 host-side bubble。

本次只有约 1%--3% 差异，因为主耗时在 GPU GEMM 和 NCCL，而不是 CPU scheduler。它属于低风险小收益优化。

`stream_interval=1` 表示每生成一个 token 就向客户端发送。增大 interval 可以把多个 token 合并后再流式发送，减少 Python/HTTP/SSE 开销，但会恶化用户感知的 token 间隔。客服交互优先平滑输出，因此保持 1。

### 13.7 FP8 E4M3、动态激活与 Marlin fallback

当前 FP8 checkpoint 的量化配置是 E4M3、动态 activation scheme、`128x128` weight block。E4M3 用 1 位符号、4 位指数和 3 位尾数表示浮点数，比 FP16 范围和精度更低，但权重存储约减半。动态量化会根据当前输入范围计算或选择 scale，使高精度激活映射到 FP8 表示区间。

在支持原生 FP8 Tensor Core 的硬件上，量化输入和权重可以直接进入 FP8 GEMM。RTX 3090 SM86 没有这条原生硬件路径，运行日志显示 vLLM 选择 Marlin weight-only FP8：

1. FP8 权重以压缩形式存储和读取。
2. Marlin kernel 以适配 SM86 的 tile 加载、scale 和矩阵乘流程执行。
3. 激活及累加仍使用更高精度路径。

它能降低权重带宽和容量，却不能等价于新 GPU 上的原生 FP8 Tensor Core 吞吐。Profiler 中 Marlin GEMM 仍占 30%--42%，说明 kernel 本身是主要计算成本之一。

### 13.8 AWQ、Group Quantization 与 Marlin WNA16

普通 weight-only INT4 直接最小化权重误差，但权重误差对输出的影响与输入激活大小有关。AWQ 的核心是保护 activation-salient channel。对线性层：

```text
y = W x = (W * diag(s)) * (diag(s)^-1 * x)
```

在数学上插入缩放 `s` 不改变结果，但先根据校准激活选择 `s`，再量化缩放后的权重，可以让重要通道获得更合适的有效量化范围。随后对每 128 个权重一组执行非对称 INT4：

```text
q = clamp(round(w / scale) + zero_point, 0, 15)
w_hat = scale * (q - zero_point)
```

非对称量化同时保存 scale 和 zero point，能覆盖不以 0 为中心的权重分布。W4A16 表示权重 4bit、激活 16bit；KV Cache 并没有变成 INT4。

Marlin WNA16 在 GEMM 内部读取 packed INT4、执行解包和反量化，并尽量把反量化与矩阵乘融合，减少把完整 FP16 权重写回显存的成本。它在大矩阵和合适 batch 下更容易体现带宽收益；小 batch、特殊 shape、未量化层较多时，解包和 scale 开销会抵消收益。

本次只量化兼容的 Linear，保留 GDN `linear_attn`、`lm_head` 和视觉塔。于是整体延迟仍同时包含高精度 GDN、KV、TP collective 与 INT4 GEMM，解释了“模型体积减小，但速度基本持平”。

### 13.9 Tensor Parallel 的计算与通信

Tensor Parallel 常把线性层组合成 column-parallel 和 row-parallel 两步。简化表示：

```text
column parallel: Y_i = X * W_i
row parallel:    Z_i = Y_i * V_i
merge:           Z = AllReduce(sum_i Z_i)
```

每张卡只保存和计算部分权重，但层输出必须在进入后续依赖前聚合。通信时间可粗略拆为：

```text
T_collective ~= latency_term + message_bytes / effective_bandwidth
```

NVLink/P2P 可以提高有效带宽并降低绕行成本。本机无 NVLink 且 P2P 自检失败，NCCL 通过可用 PCIe 路径完成 collective。由于 TP collective 出现在许多层，单次通信不大也会被 64 层和多个 decode step 累积。Profiler 中 NCCL ring AllReduce 占 45%--61% 正是这一累积效应。

TP 的优势是两张卡始终处理同一层，不存在 stage0 等 stage1 的经典流水线空泡。只要通信没有压倒计算，它通常能提供更稳定的单 token 延迟。

### 13.10 Pipeline Parallel、microbatch 与空泡

PP2 将模型写成两个函数：

```text
h = stage0(tokens)
logits = stage1(send_recv(h))
```

理想训练流水线有 `p` 个 stage、`m` 个彼此独立的 microbatch，若每级耗时相同，经典流水线效率近似：

```text
efficiency ~= m / (m + p - 1)
bubble_fraction ~= (p - 1) / (m + p - 1)
```

增加 microbatch 能摊薄 warmup/drain 空泡。但在线自回归推理不完全满足这个模型：同一请求的下一个 token 必须等待上一个 token 采样结束，独立性主要来自不同请求。低并发时没有足够 batch 填流水；高并发时可以重叠不同请求，却仍受 scheduler、KV 状态和 stage 边界约束。

vLLM 0.19.1 的 PP2 最多保持两个 scheduler batch in-flight，使用非阻塞 `isend/irecv` 传隐藏状态，但没有 virtual pipeline/interleaved stage。吞吐由较慢 stage 决定：

```text
T_step >= max(T_stage0, T_stage1) + uncovered_communication
```

默认 `32/32` 中 stage1 还承担 final norm、lm head、sampling 和 recv，实际比 stage0 重。`35/29` 把三层移到 stage0，本质是让 `T_stage0` 和 `T_stage1` 更接近。它能减少负载失衡空泡，却不能消除每个 decode token 的跨 stage 依赖。

### 13.11 DBO 的双 microbatch 重叠

DBO 是 Dual Batch Overlap。vLLM 0.19.1 默认把满足阈值的大 batch 切成两个 microbatch：

- 纯 decode batch 的 token 数达到 `dbo_decode_token_threshold` 时切分。
- 含 prefill 的 batch 达到 `dbo_prefill_token_threshold` 时切分。
- 低于阈值时保持单 batch，避免 microbatch 管理开销。

实现中为两个 microbatch 建立独立 context，使用 compute stream、communication stream、CPU threading event 和 GPU event。理想执行类似：

```text
ubatch0: compute ---- communication
ubatch1:          compute ---- communication
```

当 ubatch0 进入通信时，ubatch1 可以使用 compute stream，从而隐藏一部分通信延迟。收益要求：batch 足够大、通信支持异步 overlap、两个 microbatch 的 workspace 可容纳，且额外切分和同步成本小于被隐藏的时间。

当前 vLLM 将这条 microbatch 通信路径限制在 DeepEP low-latency/high-throughput all-to-all backend。DeepEP 面向 expert/token dispatch 的高性能通信，需要对应 kernel 和支持的软件硬件环境。本机使用 `allgather_reducescatter` 且没有 DeepEP，因此 DBO 在配置校验阶段就失败，没有产生可计入的性能结果。

### 13.12 N-gram 推测解码的收益条件

标准 decode 每轮只确认一个 token。N-gram speculation 从 prompt 或历史输出匹配 n-gram，提出多个候选 token，再用主模型一次 forward 验证这些候选。若连续接受 `k` 个 token，就可能用一次主模型迭代推进多个位置。

粗略收益条件是：

```text
saved_decode_iterations > draft_lookup + verification + rejection_recovery
```

接受率低时，大部分候选被拒绝，主模型仍要正常生成，还多付出候选构造、额外 token 位置和验证成本。本次只有 10.4% 接受率，所以 TPOT 和吞吐同时退化。它更适合代码、模板化文本或高度重复输出，不适合直接假设客服自然语言也会受益。

### 13.13 FlashAttention、CUDA Graph 与算子融合为什么不是主优化点

FlashAttention 使用 SRAM/shared memory tile 和 online softmax，避免把完整 attention score matrix 反复写入 HBM。它显著降低 IO 和中间显存，但不会消除 full attention 的二次计算量。Qwen3.6 只有 16/64 层是 full attention，Profiler 中 FlashAttention 约 0.5%，继续调它不会解决 NCCL 和 GEMM 主耗时。

CUDA Graph 把固定 shape 的 kernel launch 序列捕获后重放，减少 Python/CUDA driver launch 开销。动态请求会映射到多个捕获 shape，并需要额外 graph memory。它优化的是 kernel 之间的空隙，不会缩短 kernel 内部的矩阵计算和通信。

融合 RMSNorm、Rotary、SILU/乘法与量化反解可以减少 kernel 数和 HBM 往返。本项目复用了 vLLM、TorchInductor、Triton、FlashAttention 和 Marlin 的现成融合，没有手写 CUDA kernel。原因是 profile 已显示 attention/小算子不是首要瓶颈，手写融合的风险和验证成本高于预期收益。

### 13.14 如何正确解读 Profiler

PyTorch Profiler 的几个字段不能混用：

- **Self CUDA**：算子自身 kernel 的 GPU 时间，不包含子调用。
- **CUDA total**：包含子调用，嵌套 region 之间可能重叠，不能简单相加当墙钟时间。
- **Calls**：调用次数；时间比例变化可能来自生成 token 数或 shape 变化，比较时必须控制 workload。
- **NCCL SendRecv/AllReduce**：包含通信 kernel 活跃时间，也可能体现等待和同步，需结合两张卡 trace 判断。
- **GPU utilization**：`nvidia-smi` 是采样值，不等于整个实验区间的平均利用率。

因此本次用同 token 数 profile 检查计算迁移，用无 profiler 的完整矩阵决定性能，用成功率和质量门禁决定结果是否有效。三类证据承担不同职责，避免把观测开销或单点采样误判成优化收益。

### 13.15 FP8 KV Cache 为什么省单元容量却仍可能 OOM

KV Cache 量化需要把高精度 K/V 映射到 FP8。简化过程是：

```text
q_k = clamp(round(k / scale_k), fp8_range)
q_v = clamp(round(v / scale_v), fp8_range)
k_hat = q_k * scale_k
v_hat = q_v * scale_v
```

scale 应来自校准或运行时统计。scale 太大时有效精度不足，太小时大值饱和。本次 checkpoint 没有 q/k/v/prob calibration scale，vLLM 回退到 1.0，因此除了稳定性，还存在数值质量风险。

FP8 让每个 KV 元素从约 2 byte 降到约 1 byte，vLLM 因而可以把 attention page 数从 784 提高到 1568。问题在于 `gpu_memory_utilization` 是总体显存预算：runtime 会把节省出的空间继续分给更多 KV block，而不是自动留给 Marlin 临时 workspace。正式负载触发更大的活动 KV/attention 工作集后，kernel 需要的临时空间无法满足，最终仍然 OOM。

所以“KV dtype 更小”只说明单位容量下降，不代表总显存水位一定下降。若目标是稳定性，应同时降低 `gpu_memory_utilization`、限制并发或显式保留 workspace，再配合有校准 scale 的模型复测。

### 13.16 生成约束与质量门禁的算法含义

AWQ 输出质量修复涉及 logits 后处理：

- `temperature=0` 采用确定性 greedy 选择，消除随机采样带来的 A/B 方差。
- Frequency penalty 根据 token 在已生成文本中的出现次数降低其 logit，减少重复循环，但过大也会伤害正常复述。
- Stop sequence 在流式 token 拼接命中指定序列时结束生成，阻止已知异常表情循环继续占用 decode step。

这些约束不能被当作模型 kernel 提速。它们的作用是让不同实验生成长度和结束条件可控，并阻止错误输出靠提前停止或异常截断获得虚假低延迟。正确顺序是先让质量门禁通过，再比较性能；否则更快的结果可能只是少生成了正确答案。

## 14. 最终推荐配置

### 14.1 FP8 默认均衡档

```yaml
tensor_parallel_size: 2
pipeline_parallel_size: 1
quantization: fp8
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
```

### 14.2 FP8 高并发 TTFT/吞吐档

在均衡档基础上只修改：

```yaml
max_num_seqs: 16
max_num_batched_tokens: 8192
```

该配置以约 34.1% 的 P95 TPOT 回退换取约 19.5% 的 P95 TTFT 改善和 14.8% 的吞吐提升。

### 14.3 AWQ 发布候选

```yaml
tensor_parallel_size: 2
dtype: float16
max_model_len: 4096
gpu_memory_utilization: 0.85
max_num_seqs: 8
max_num_batched_tokens: 4096
enable_prefix_caching: true
enable_chunked_prefill: true
disable_custom_all_reduce: true
```

同时固定 `NCCL_P2P_DISABLE=1`、`NCCL_SHM_DISABLE=0`、`NCCL_ALGO=Ring`、`NCCL_MIN_NCHANNELS=4` 和 `NCCL_MAX_NCHANNELS=4`。

请求侧同时固定 `temperature=0`、`frequency_penalty=1.0` 和客服表情 stop 序列。

### 14.4 PP2 实验候选

```yaml
tensor_parallel_size: 1
pipeline_parallel_size: 2
pipeline_layer_partition: "35,29"
max_num_seqs: 8
max_num_batched_tokens: 4096
enable_prefix_caching: true
enable_chunked_prefill: true
async_scheduling: false
enable_dbo: false
```

该配置用于复现和展示 PP 优化过程，不进入默认发布档。

## 15. 优化手段总表

| 优化手段 | 层级 | 机制 | 实测结论 | 状态 |
|---|---|---|---|---|
| Prefix Caching | KV/prefill | 复用共享客服前缀的计算结果 | 最大收益，暖缓存 TTFT/TPOT 明显下降 | 采纳 |
| PagedAttention | KV 管理 | block/page 化分配 KV | vLLM baseline 已启用，不是当前主瓶颈 | 保留 |
| Continuous Batching | 调度 | 每轮动态加入/移除序列 | vLLM baseline 已启用 | 保留 |
| Chunked Prefill | 调度/prefill | 长 prompt 按 token budget 分块 | Qwen3.6 必需，保持开启 | 采纳 |
| `max_num_seqs` | 调度 | 控制同时运行序列数 | 8 为均衡档，16 为高并发档 | 分档 |
| `max_num_batched_tokens` | 调度 | 控制单轮总 token budget | 4096 为均衡档，8192 配合 C16 | 分档 |
| Async Scheduling | 调度 | 减少 CPU/GPU 调度间隙 | 小幅收益 | 采纳 |
| Priority FCFS A/B | 调度 | 短请求优先 | 导致长请求饥饿 | 淘汰 |
| Concurrent Partial Prefill | 调度 | 多个长 prompt 交错 prefill | 当前模型/vLLM 不支持 | 不可用 |
| FP8 KV Cache | 显存 | 压缩 KV block | 无校准 scale，正式负载 OOM | 淘汰 |
| `gpu_memory_utilization=0.92` | 显存 | 增加 KV 预留 | 挤压 Marlin workspace 并 OOM | 淘汰 |
| `max_model_len=3072` | 显存 | 减少最大 KV 规划 | TTFT/TPOT 退化 | 淘汰 |
| N-gram speculation | decode | 草稿 token 后批量验证 | 接受率低，TPOT/吞吐退化 | 淘汰 |
| Custom AllReduce | 通信 | P2P 优化 collective | 无 P2P/NVLink，自动回退 | 不可用 |
| AWQ W4A16 | 权重量化 | activation-aware INT4 weight-only | 模型压缩成功，速度无显著提升 | 发布候选 |
| TP2 | 并行 | 层内切分 + collective | 当前双卡总体最优 | 默认 |
| PP2 | 并行 | 层间切分 + SendRecv | TTFT 局部改善，TPOT/吞吐退化 | 非默认 |
| PP `35/29` | 负载均衡 | 三层从末级迁至首级 | PP 内部吞吐 +3.2%，TPOT -2.0% | PP 候选 |
| DBO | microbatch | 尝试重叠 batch/stage 执行 | 依赖 DeepEP，3090 runtime 不支持 | 不可用 |
| 算子融合 | kernel | 减少 launch 和内存读写 | 使用 vLLM/Triton/Marlin 现有实现，未手写 kernel | 调研/复用 |
| NCCL Ring4 SHM | 通信 | 为 PCIe x4/无 P2P 拓扑固定 Ring 和 4 channel | TTFT -2.72%、TPOT -1.55%、吞吐 +1.84% | 采纳 |
| vLLM 0.26.0 | 框架 | 新编译器、kernel 和调度实现 | E2E 改善，TTFT/TPOT 无稳定领先 | 开发档 |
| FULL+PIECEWISE Graph | 框架 | decode 全图与动态 prefill 分段捕获 | 完整矩阵优于 PIECEWISE-only | 采纳 |
| `vllm_c` RMSNorm | kernel | 强制 native norm/fused norm backend | TPOT -0.69%，E2E +1.74%，无综合收益 | 不晋级 |
| FlashInfer attention | kernel | 替换 16 个 full-attention 层 backend | 平均 TPOT -0.49%，2K/C16 回退 | 可选 profile |
| TP-only UBatch overlap | 框架 | 双微批 compute/comm stream 重叠 | 混合 Attention/Mamba KV metadata 切分失败 | 原型失败 |
| RowParallel split overlap | kernel/框架 | GEMM(A)-AR(A) 与 GEMM(B) 重叠 | Marlin 小 M 利用率下降，TPOT 最多回退 19.7% | 淘汰 |
| AWQ + FP8 KV | KV/kernel | KV 元素压缩到 8bit | 可启动但 1K/C8 严重回退，scale/质量有风险 | 淘汰 |
| Qwen3.5-4B draft | decode | 独立小模型提出 3 个 token | 被解析为 MTP，5120/2560 隐藏维不匹配 | 不兼容 |

## 16. 可以如何表述本次优化

可以真实描述为：

> 基于 vLLM 0.19.1 在单机双 RTX 3090 上部署 Qwen3.6-27B FP8/AWQ OpenAI-Compatible 服务，构建 1K/2K、1--16 并发的中文客服压测矩阵和输出质量门禁；围绕 Prefix Caching、连续批处理、chunked prefill、调度 token budget、显存水位、KV Cache、推测解码及 TP/PP 拓扑开展 A/B，并结合 PyTorch Profiler 将瓶颈归因到 PCIe/NCCL 和 Marlin GEMM。共享前缀场景中 Prefix Cache 命中率约 78.4%，暖缓存平均 P95 TTFT 降低约 70%；完成 AWQ W4A16 量化与质量回归，并通过 PP `35/29` 分层使 PP 内部吞吐提升约 3.2%，最终依据 TPOT 和吞吐回归保留 TP2 作为默认拓扑。

不应写成：

- “3090 使用原生 FP8 Tensor Core 加速”，实际是 Marlin fallback。
- “实现了 PagedAttention/FlashAttention/算子融合”，这些是 vLLM 已有能力，本项目完成的是启用、验证和瓶颈归因。
- “AWQ 比 FP8 显著提速”，当前数据不支持。
- “PP2 优于 TP2”，PP2 仅 TTFT 有局部优势，TPOT 和吞吐整体更差。
- “实现 DBO 减少流水线空泡”，当前环境因 DeepEP 依赖未能启用。

## 17. 复现实验与证据

核心报告：

- `docs/INFERENCE-PROFILING-REPORT.md`
- `docs/AWQ-INFERENCE-OPTIMIZATION-REPORT.md`
- `docs/INFERENCE-PARALLELISM-AB-REPORT.md`

关键结果：

- `logs/inference/qwen36-prefix-cache/comparison.json`
- `logs/inference/scheduler-sweep/fair-32-summary.json`
- `logs/inference/parallel-ab/aggregate-summary.json`
- `logs/inference/pp-tuning/pp-l35-29-full-result.json`
- `logs/inference/pp-tuning/pp-l35-29-profile-c16-profiler/`
- `logs/inference/pp-tuning/dbo-smoke-failed.log`
- `logs/inference/awq-experiments/awq-tp2-optimized-final-result.json`
- `runs/quantization/qwen36-27b-awq/status.json`

关键配置与脚本：

- `configs/serve/qwen36_27b_fp8_vllm.yaml`
- `configs/serve/qwen36_27b_fp8_vllm_optimized.yaml`
- `configs/serve/qwen36_27b_awq_vllm_tp2_optimized.yaml`
- `configs/quantization/qwen36_27b_awq_w4a16.yaml`
- `scripts/run_qwen36_scheduler_sweep.sh`
- `scripts/run_qwen36_parallel_ab.sh`
- `scripts/run_qwen36_pp_tuning.sh`
- `scripts/run_qwen36_awq_quantization.sh`

## 18. 第八轮优化：依据双 3090 拓扑优化 NCCL

### 18.1 先测硬件，不从环境变量猜结论

实测拓扑为：GPU0 连接 PCIe 4.0 x16，GPU1 经芯片组连接 PCIe 4.0 x4；两卡同属 NUMA node 0，但 `nvidia-smi topo -m` 显示 GPU 间为 `NODE`，没有 NVLink。CUDA `canAccessPeer` 双向为 False，因此 CUDA runtime 不能为两张卡建立 peer mapping，NCCL 日志确认回退到 SHM/direct/direct。

CUDA Peer Access 为 False 不等于“两张卡完全不能交换数据”，而是不能直接执行 GPU load/store 或 peer DMA。通信仍能通过：

```text
GPU0 device memory -> host shared-memory staging -> GPU1 device memory
```

该路径多一次主机侧中转，并受 GPU1 PCIe x4、芯片组和内存系统共同限制。优化目标因此不是强行打开 P2P，而是减少 collective 数、提高每次 collective 的通道利用率，并避免过细消息。

### 18.2 NCCL 微基准

固定 NVIDIA `nccl-tests` commit，对 8KiB--64MiB AllReduce 扫描 auto、Ring/Tree、1/2/4 channels、1/8MiB buffer 和 512 threads。代表性 bus bandwidth：

| Profile | 1MiB | 8MiB | 64MiB |
|---|---:|---:|---:|
| Auto | 2.42 | 2.67 | 2.72 GB/s |
| Ring 1ch | 2.05 | 2.36 | 2.35 GB/s |
| Ring 2ch | 2.21 | 2.68 | 2.74 GB/s |
| Ring 4ch | 2.45 | 2.68 | 2.84 GB/s |
| Tree 2ch | 1.75 | 2.40 | 2.64 GB/s |

Ring4 在 1MiB 和 64MiB 都位于最优档。只看 NCCL 微基准仍不足以发布，因此又做了 320 请求端到端回归：

| 指标 | NCCL auto | Ring4 SHM | 变化 |
|---|---:|---:|---:|
| 平均 P95 TTFT | 2731.69ms | 2657.43ms | -2.72% |
| 平均 P95 TPOT | 70.60ms | 69.51ms | -1.55% |
| 平均 P95 E2E | 6540.14ms | 6349.64ms | -2.91% |
| 平均生成吞吐 | 56.69 | 57.74 tok/s | +1.84% |

两组均为 320/320 成功、输出有效率 100%。最终通信配置为：

```bash
NCCL_P2P_DISABLE=1
NCCL_SHM_DISABLE=0
NCCL_ALGO=Ring
NCCL_MIN_NCHANNELS=4
NCCL_MAX_NCHANNELS=4
```

`P2P_DISABLE=1` 在这里是显式表达已测硬件事实，避免 NCCL 每次启动探测并产生“配置打开但运行时回退”的歧义。`SHM_DISABLE=0` 保留同 NUMA 共享内存中转；Tree、1 channel、buffer/thread 改写没有进入最终配置，因为没有端到端收益。

## 19. 第九轮优化：vLLM 版本、编译器与 Kernel

### 19.1 vLLM 0.19.1 对 0.26.0

保持 AWQ、TP2、Ring4 和请求矩阵一致：

| 版本 | 平均 P95 TTFT | 平均 P95 TPOT | 平均 P95 E2E | 吞吐 |
|---|---:|---:|---:|---:|
| 0.19.1 Ring4 | 2657.43ms | 69.51ms | 6349.64ms | 57.74 |
| 0.26.0 Ring4 | 2663.89ms | 69.99ms | 6186.09ms | 57.46 |

0.26.0 的 E2E 更低，但 TTFT、TPOT 和吞吐没有超过 0.19.1，差异也接近运行波动。因此版本升级被定义为功能/维护升级，不虚构成性能提升；延迟严格档仍可使用 0.19.1，后续开发档使用 0.26.0。

SM86 上 0.26.0 的 SymmMem、Sequence Parallel、Async TP、QuickReduce 和 fused AllReduce-RMS 路径均未进入可执行状态。日志明确给出 `Device capability 8.6 not supported`，stock 实现面向更新架构。升级框架不会改变硬件能力。

### 19.2 Torch Compile 与 CUDA Graph

短矩阵中 compile-only 相对 eager 的 1K/C8 TTFT 从 1820ms 降到 1658ms，TPOT 从 55.87ms 降到 49.32ms，说明减少 Python/driver launch 和 Inductor 融合有效。但短样本中的 PIECEWISE-only 优势没有通过 full32：

| 完整矩阵 | 默认 FULL+PIECEWISE | PIECEWISE-only | 变化 |
|---|---:|---:|---:|
| P95 TTFT | 2663.89ms | 2696.89ms | +1.24% |
| P95 TPOT | 69.99ms | 70.26ms | +0.38% |
| P95 E2E | 6186.09ms | 6356.21ms | +2.75% |
| 吞吐 | 57.46 | 56.95 tok/s | -0.89% |

FULL graph 适合稳定 decode shape，PIECEWISE 处理动态 prefill/混合 shape。只保留 PIECEWISE 会失去部分 decode launch 合并，因此保留 vLLM 默认 `FULL_AND_PIECEWISE`。

### 19.3 Attention 和 norm kernel

强制 `vllm_c` RMSNorm/fused-add-RMS 后，完整矩阵 TPOT -0.69%、吞吐 +1.06%，但 E2E +1.74%、TTFT 基本不变。结果不满足 TTFT/TPOT/E2E 的综合晋级规则。

FlashInfer 相对 FlashAttention2 的平均 TTFT -0.17%、TPOT -0.49%、吞吐 +1.38%，但 E2E +0.24%，且 2K/C16 TPOT 回退约 3.95%。本模型 64 层中只有 16 层 full attention，另外 48 层走 Qwen GDN Triton/FLA；因此 attention backend 的理论影响范围有限。FlashInfer 保留为特定流量 profile，不进入统一默认档。

### 19.4 最新 kernel profile

在 0.26.0 AWQ TP2 的 2K/C8 请求上采集两张卡 trace：

| Rank | NCCL AllReduce | Marlin GEMM | `aten::mm` | FA2 | GDN core |
|---|---:|---:|---:|---:|---:|
| rank0 | 59.83% | 24.88% | 8.26% | 0.59% | 0.27% |
| rank1 | 45.35% | 33.76% | 11.59% | 0.79% | 0.42% |

NCCL + GEMM 在两卡均超过 84% Self CUDA，1548 次 AllReduce 说明“单次消息不大但层层同步”的累积成本。rank1 的 Marlin 为 1.929s，rank0 为 1.426s，反映 GPU1 x4/显示负载和频率差异造成的不对称。attention/norm/GDN 单项低于 1%，和 kernel A/B 的小收益互相印证。

## 20. 第十轮优化：自行实现计算通信重叠

### 20.1 为什么 stock overlap 不能直接开启

vLLM 的 Sequence Parallel、Async TP、SymmMem 和 fused GEMM-communication pass 依赖 SM90+ 或特定 communicator。DBO 又要求 DeepEP all-to-all backend。当前 SM86、无 P2P、dense Qwen3.5 模型不满足这些条件，所以实现了两版 TP-only 原型验证“能否借鉴思想自行重叠”。

### 20.2 原型一：整模型双微批

第一版复用 UBatch executor，把一个大 batch 拆为 A/B 两个 microbatch，并使用 compute/communication stream：

```text
ubatch A: GEMM -------- AllReduce
ubatch B:        GEMM -------- AllReduce
```

单请求 1540-token prefill 可以正确执行，但 C8 动态请求在 FlashAttention 报：

```text
block_table must have shape (batch_size, max_num_blocks_per_seq)
```

根因不是 CUDA stream，而是请求切分后只切了 hidden states，没有完整同步切分 hybrid Attention/Mamba 的 block table、slot mapping、sequence length 和 cache group metadata。stock DBO 的数据结构围绕 DP+EP 设计，不能直接改成 TP-only。该原型停止在正确性门禁，未生成性能收益。

### 20.3 原型二：RowParallel 层内切分

第二版不切请求和 attention metadata，只把大 RowParallel token 矩阵沿 M 维切为两半：

```text
compute stream: Marlin GEMM(A) ---------------- Marlin GEMM(B)
comm stream:                    AllReduce(A) ---------------- AllReduce(B)
```

实现、镜像和配置保存在 `patches/vllm-v0.26.0/dense-tp-overlap.patch`、`deploy/vllm/Dockerfile.dense-tp-overlap` 和 `configs/serve/qwen36_27b_awq_vllm_tp2_dense_overlap.yaml`。C8 正确性为 8/8 成功、输出有效率 100%，但端到端性能回退：

| 场景 | eager TTFT/TPOT | overlap TTFT/TPOT | 结果 |
|---|---:|---:|---:|
| 1K/C8 | 1820 / 55.87ms | 1827 / 66.86ms | TPOT +19.67% |
| 2K/C8 | 3913 / 55.31ms | 4005 / 56.20ms | TPOT +1.60% |

失败原因有三层：

1. Marlin 为完整 M 维选择的 tile/occupancy 被破坏，两次小 GEMM 的有效吞吐低于一次大 GEMM。
2. 每层从一次 collective 变成两次，增加 latency term、launch 和 event 同步。
3. 本机通信经 SHM，中间 host staging 对小消息更敏感；微基准中隐藏的 NCCL 时间不足以抵消真实模型的 GEMM 损失。

这是一个有价值的负结果：重叠比例变高不等于端到端更快。后续若继续，必须保持大 GEMM 形状，在 GEMM epilogue/分块完成粒度上触发单次 collective，或使用支持 SM86 的 persistent kernel，而不能简单二分 M。

## 21. 第十一轮优化：KV 与投机解码边界

### 21.1 AWQ + FP8 KV Cache 复测

旧 FP8 权重实验在 0.90/C16 下因 GPU1 只剩 153MiB 而 OOM。为排除显存水位干扰，AWQ 在 0.85/C8 下复测两轮。服务成功启动，KV capacity 达 106,951 tokens，但 vLLM 因 FP8 KV 改用 FlashInfer，且 checkpoint 没有校准 scale。

1K/C8 两次分别得到约 `7996/117.02ms` 和 `7977/113.73ms` TTFT/TPOT，而普通 KV 为 `1656/46.55ms`；2K/C8 有局部 TPOT 收益但波动大。1K 固定样本的 reference pass rate 从 0.625 降到 0.375。

结论：FP8 KV 可以换容量，但在本机不能换低延迟；`kv_cache_dtype=auto` 保持默认。

### 21.2 两类投机解码失败

N-gram 3-token 的接受率只有 10.4%，同一 C16 混合负载 TPOT 从 131.26ms 升到 199.09ms，吞吐从 89.70 降到 64.60 tok/s。中文客服自然语言缺少足够长的精确重复，验证成本大于减少的主模型迭代。

独立 Qwen3.5-4B draft 则在启动时失败。vLLM 0.26.0 将 Qwen3.5 draft 路径解析为 `Qwen3_5MTP`，目标模型隐藏维 5120，4B 模型隐藏维 2560，加载 embedding/projection 时发生 tensor size mismatch。它要求目标模型配套的 MTP/EAGLE 权重，不支持把任意同系列小模型直接当成单层 MTP。

## 22. 未执行或被环境阻塞的项目

| 项目 | 状态 | 为什么没有伪造结果 |
|---|---|---|
| 强制 CUDA P2P | 硬件不支持 | `canAccessPeer=False`，软件变量不能创造 peer mapping |
| GPU 锁频 A/B | 权限阻塞 | `nvidia-smi -lgc/-lmc` 需要 sudo，当前无免密权限 |
| 隔离 GPU1 桌面进程 | 未执行 | GPU1 驱动显示器且 Chrome 使用 GPU，不能终止用户会话换取结果 |
| SM86 自定义 AllReduce+RMS CUDA kernel | 未发布 | 正确性、数值误差、图捕获和 64 层集成成本高；stock path 明确要求更新架构 |
| Nsight 作为收益证据 | 未采用 | 工具已安装，但 Docker 多进程注入和显示卡负载会改变时间；已用低侵入 PyTorch CUDA trace 完成归因 |
| GDN kernel 重写 | 未执行 | profiler Self CUDA 仅 0.27%--0.42%，收益上限远低于 NCCL/GEMM |

这些项目不是“忘记测试”。前两项由硬件/权限阻塞，后三项在 profiler 后被证据降级。优化过程的原则是先测收益上限，再决定是否承担实现风险。

## 23. 最终发布决策与简历边界

以 TTFT/TPOT 为第一目标，最终 AWQ 延迟档使用 vLLM 0.19.1、TP2、Prefix Cache、Chunked Prefill、`8/4096` 和 Ring4 SHM；0.26.0 保留为功能开发档并使用默认 FULL+PIECEWISE Graph。高并发吞吐档可切 `16/8192`，但必须同时披露 TPOT 回退。

可以写入简历的真实结果包括：客服共享前缀缓存收益、NCCL Ring4 端到端收益、PP `35/29` 内部收益、AWQ 转换/质量回归、TP/PP 决策，以及用 profiler 把 84% 以上 Self CUDA 归因到 NCCL+GEMM。两版自研重叠应写成“实现原型并通过端到端回归淘汰”，不能写成已经获得正向性能收益。

本阶段新增证据：

- `docs/HARDWARE-AWARE-FRAMEWORK-KERNEL-OPTIMIZATION.md`
- `logs/inference/nccl-pcie-20260810/`
- `logs/inference/hardware-aware-20260810/`
- `logs/inference/framework-kernel-matrix-20260810/`
- `logs/inference/dense-tp-overlap-e2e-20260810/`
- `logs/profiles/qwen36-v026/`
- `logs/inference/framework-kernel-matrix-20260810/v026-speculative-startup.log`
