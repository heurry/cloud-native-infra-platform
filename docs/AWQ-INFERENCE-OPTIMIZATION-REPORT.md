# Qwen3.6-27B AWQ W4A16 推理优化报告

## 1. 实验口径

- 日期：2026-08-09
- 硬件：单机双 RTX 3090 24GB，TP=2
- 服务：vLLM 0.19.1 OpenAI-Compatible API
- 模型：`/mnt/nvme-data/models/LLM_model/Qwen3.6-27B-AWQ-INT4`
- 数据：DianJin-CSC 固定中文客服切片，1K/2K 上下文
- 矩阵：并发 1/2/4/8/16，每场景 16 请求，最多输出 256 tokens
- 门禁：请求成功率 100%、输出质量门禁 100%、无截断和安全违规

压测通过 Go 控制面流式读取 SSE。TTFT 取首个非空 content delta，TPOT 按 `(E2E - TTFT) / (output_tokens - 1)` 计算；token 数来自 vLLM usage。

## 2. 质量回归与修复

初始 AWQ 服务可以正确回答客服问题，但部分样本会在答案后重复表情直到达到输出上限。未加约束的 1K/并发1 场景成功率为 100%，完整质量通过率仅 50%。

单独提高 `repetition_penalty` 或 `frequency_penalty` 不能稳定消除该退化。最终请求侧采用：

- `temperature=0`
- `frequency_penalty=1.0`
- 禁止客服回复中的常见表情 stop 序列
- 保留非空、UTF-8、`finish_reason=stop`、敏感凭据和参考答案重叠门禁

固定 16 个 1K 样本复测后，成功率与完整质量通过率均为 100%，截断率为 0。该约束是性能实验的前置条件，不能把截断输出带来的低延迟计作优化收益。

## 3. Prefix Cache 结果

正式 baseline 为 TP2、`max_num_seqs=8`、`max_num_batched_tokens=4096`、chunked prefill 开启、Prefix Cache 关闭：

- Baseline run：`9961414c-d1cd-41fa-93a1-afd3a1d35d82`
- 最终优化 run：`5f40b745-f679-4aef-a993-998721293a06`
- 两轮 160/160 请求成功，160/160 质量门禁通过
- 最终 run 查询 238,130 个 prefix tokens，命中 186,592 个，命中率约 78.4%

| 上下文 | 并发 | Baseline P95 TTFT | 优化后 | TTFT 降幅 | Baseline P95 TPOT | 优化后 | TPOT 降幅 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1K | 1 | 1179ms | 785ms | 33.4% | 33.5ms | 32.7ms | 2.3% |
| 1K | 2 | 2203ms | 595ms | 73.0% | 60.8ms | 40.8ms | 32.9% |
| 1K | 4 | 4340ms | 861ms | 80.2% | 114.7ms | 53.4ms | 53.5% |
| 1K | 8 | 8671ms | 1713ms | 80.2% | 199.2ms | 69.8ms | 65.0% |
| 1K | 16 | 19879ms | 6680ms | 66.4% | 198.5ms | 74.8ms | 62.3% |
| 2K | 1 | 2303ms | 791ms | 65.7% | 33.8ms | 32.9ms | 2.7% |
| 2K | 2 | 4543ms | 1088ms | 76.0% | 105.4ms | 52.5ms | 50.1% |
| 2K | 4 | 7373ms | 1603ms | 78.3% | 192.3ms | 68.2ms | 64.6% |
| 2K | 8 | 16290ms | 3951ms | 75.7% | 346.8ms | 117.5ms | 66.1% |
| 2K | 16 | 36757ms | 10660ms | 71.0% | 368.1ms | 115.0ms | 68.8% |

十个场景算术平均：P95 TTFT -70.0%、P95 TPOT -46.8%、端到端 P95 -53.9%、输出吞吐 +127.1%。

完整矩阵会在不同并发档重复固定问题，因此它代表共享客服前缀的暖缓存收益。冷启动后只跑并发1的保守对照中，1K/2K P95 TTFT 分别降低 30.4%/64.7%，TPOT 基本不变。简历和面试必须说明该口径，不能外推到无共享前缀流量。

## 4. 调度扫描与失败边界

| 候选 | 关键结果 | 决策 |
|---|---|---|
| `max_num_seqs=16,max_num_batched_tokens=8192` | C16 TTFT 约 -5%，吞吐 +2.7%/+7.4%，TPOT +35.9%/+45.7% | 淘汰 |
| 仅 `max_num_batched_tokens=8192` | 1K 略退化；2K TPOT -9.8%，TTFT/吞吐基本不变 | 不采纳 |
| 仅 `max_num_seqs=16` | C16 TTFT 约 -5.5%，吞吐 +3.9%/+8.6%，TPOT +51.4%/+46.5% | 淘汰 |
| TP1，无 offload | 初始化 `lm_head` 时 OOM | 不可用 |
| TP1，CPU offload 4GiB | 权重初始化通过，Inductor 编译仍差约 2.37GiB 显存 | 不可用 |

高并发瓶颈不是 KV 容量。`max_num_seqs=8` 时 C16 会排队，但让 16 个序列同时 decode 会稀释单请求算力，TTFT 小幅改善而 TPOT 显著恶化。最终保留 `8/4096`。

运行日志确认 AWQ 主线性层使用 Marlin WNA16，attention 使用 FlashAttention 2，GDN prefill 使用 Triton/FLA。Qwen3.6 混合 GDN/Mamba 架构的 Prefix Cache 使用 vLLM 实验性 `align` 模式，发布前仍需保留稳定性回归。

## 5. 最终配置

配置文件：`configs/serve/qwen36_27b_awq_vllm_tp2_optimized.yaml`

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

实验原始请求、事件与结果位于 `logs/inference/awq-experiments/`，正式报告同时归档到 MinIO 的 `benchmarks/<run_id>/report.json`。
