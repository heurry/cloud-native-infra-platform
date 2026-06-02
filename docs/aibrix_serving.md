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

压测由 Go 控制面**进程内 runner** 驱动（取代历史的 `scripts/11_benchmark_serving.py` 子进程），统一经服务实例路由到直连 vLLM 或 AIBrix Gateway。提交后通过 SSE 实时回传分级进度，结果落库并归档到 MinIO。

直连 vLLM baseline：

```bash
curl -fsS -X POST http://127.0.0.1:8081/api/benchmarks/serving \
  -H 'Content-Type: application/json' \
  -d '{
        "endpoint_id": "vllm-direct",
        "workload": "mixed",
        "routing_strategy": "direct",
        "concurrency_levels": [1,2,4,8,16],
        "requests_per_level": 32,
        "max_tokens": 128
      }'
```

AIBrix Gateway benchmark（model-aware routing）：

```bash
curl -fsS -X POST http://127.0.0.1:8081/api/benchmarks/serving \
  -H 'Content-Type: application/json' \
  -d '{
        "endpoint_id": "aibrix-gateway",
        "workload": "mixed",
        "routing_strategy": "least-request",
        "concurrency_levels": [1,2,4,8,16],
        "requests_per_level": 32,
        "max_tokens": 128
      }'
```

进度与结果：

```bash
curl -N http://127.0.0.1:8081/api/benchmarks/<run_id>/events   # SSE 分级进度
curl    http://127.0.0.1:8081/api/benchmarks/<run_id>          # 最终报告
```

## Metrics

每次 run 都会输出结构化报告（落库 + MinIO 归档），核心指标包括：

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
