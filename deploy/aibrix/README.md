# AIBrix / vLLM Deployment Notes

This directory contains the project-side serving template for the AIBrix path.
It does not vendor AIBrix itself. Install AIBrix, Envoy Gateway, the NVIDIA
device plugin, and cluster storage by following the upstream AIBrix deployment
guide for the target cluster.

## Role Split

- `configs/serve/model_registry.yaml` records model metadata and serving
  recommendations for the cloud-native platform.
- vLLM pods run the OpenAI-compatible inference engine.
- AIBrix Gateway routes traffic to vLLM pods and adds service-governance
  behavior such as routing strategy, rate control, and observability.

## Minimal Deployment Shape

1. Copy or mount model artifacts to the cluster PVC named `llm-model-store`. For a single-node local cluster, apply `local-model-pv.yaml` after confirming the host path exists.
2. Install AIBrix and Envoy Gateway in the cluster.
3. Apply `local-model-pv.yaml`, then `vllm-qwen3-deployment.yaml`.
4. Expose the AIBrix Gateway endpoint.
5. Run the benchmark via the Go control plane's in-process runner against the
   gateway endpoint:

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

For a direct vLLM baseline, submit the same body with `"endpoint_id": "vllm-direct"`
and `"routing_strategy": "direct"`. The comparison should focus on QPS, TTFT,
P95/P99 latency, decode tokens/s, error rate, and route distribution.

## Observability

The Go control plane's metrics endpoints read vLLM `/metrics` (scraped via
client-go), AIBrix/Kubernetes pod state, host GPU/CPU/memory/disk/network
counters (via the Go agent), and optional cAdvisor container metrics. The local
4B stack script enables cAdvisor by default and port-forwards it to:

```bash
http://127.0.0.1:18080/metrics
```

To start only the cAdvisor collector:

```bash
bash scripts/start_cadvisor_observability.sh
```

If cAdvisor is not running, the dashboard still shows vLLM, AIBrix, GPU, and
host-level metrics; only the container-level table is marked unavailable.

AIBrix also documents built-in Grafana dashboards for production observability.
The React dashboard in this repo is kept as a lightweight interview/demo panel
that works directly through FastAPI without requiring a Prometheus/Grafana stack.
