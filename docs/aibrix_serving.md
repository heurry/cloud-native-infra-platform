# AIBrix Serving Track

本项目的 AIBrix 扩展只进入推理服务治理层，不进入训练链路。

服务链路升级为：

```text
OpenAI-compatible client
  -> AIBrix Gateway / Envoy Gateway
  -> vLLM replicas
  -> Qwen3.5 4B serving model
```

## Why AIBrix Here

当前仓库已经有 vLLM 直连服务和最小 serving benchmark。AIBrix track 的目标不是重新实现 AIBrix，而是把项目从“单服务可调用”推进到“高并发推理服务治理可验证”：

- 多 vLLM replica 负载均衡
- model-aware routing
- routing strategy 对延迟和吞吐的影响
- request id、user、target pod 等观测字段
- gateway 路由开销和直连 vLLM baseline 对比

## Model Registry

`configs/serve/model_registry.yaml` 记录服务侧模型发布信息：

- base model: 本地基座模型、tokenizer、推荐 vLLM 参数
- served model: OpenAI-compatible model id、评测目录和压测报告

这个 registry 是控制面和 AIBrix/vLLM 服务侧之间的边界文件。服务部署只读取模型路径、运行时参数和压测建议。

## Benchmark Modes

直连 vLLM baseline：

```bash
python scripts/11_benchmark_serving.py \
  --endpoint_label vllm-direct \
  --base_url http://127.0.0.1:8000/v1 \
  --model qwen3-4b-customer \
  --concurrency_levels 1,2,4,8,16 \
  --requests_per_level 32 \
  --prompt_profile mixed \
  --output_json runs/serve/vllm_direct_benchmark.json \
  --output_report runs/serve/vllm_direct_benchmark.md
```

AIBrix Gateway benchmark：

```bash
bash scripts/17_benchmark_aibrix_gateway.sh
```

等价展开命令：

```bash
python scripts/11_benchmark_serving.py \
  --endpoint_label aibrix \
  --base_url http://127.0.0.1:8000/v1 \
  --model qwen3-4b-customer \
  --concurrency_levels 1,2,4,8,16 \
  --requests_per_level 32 \
  --routing_strategy least-request \
  --prompt_profile mixed \
  --output_json runs/serve/aibrix_gateway_benchmark.json \
  --output_report runs/serve/aibrix_gateway_benchmark.md
```

## Metrics

`scripts/11_benchmark_serving.py` 会输出 JSON 和 Markdown 报告，核心指标包括：

- QPS
- mean TTFT
- P50 / P95 / P99 latency
- decode tokens/s
- output tokens/s
- error rate
- target pod / upstream distribution

如果 AIBrix Gateway 返回 target pod 或 upstream header，报告会统计路由分布；如果没有返回，分布会显示为 `unknown`，不影响延迟和吞吐指标。

## Resume Wording

更稳妥的简历表述：

```latex
在 vLLM 服务化基础上引入 AIBrix 推理治理层，设计面向多模型版本的高并发推理服务架构，通过 Gateway 路由、多副本负载均衡和压测观测，分析不同并发数、上下文长度和路由策略下的 QPS、TTFT、P95/P99 延迟、tokens/s 与显存占用。
```

如果没有真实 Kubernetes 集群实跑，需要写成：

```latex
参考 AIBrix 的 LLM Gateway 与 model-aware routing 思路，设计本地化高并发推理服务架构，并通过 vLLM 多实例、统一网关、并发压测和 Profiling 验证推理吞吐与延迟瓶颈。
```
