# Customer Support AI Infra Platform

This document describes the first runnable customer-support workload used to validate the cloud-native platform API, RAG, serving, evaluation, and benchmark flows.

## Runtime Shape

```text
React / Vite dashboard
  -> FastAPI application gateway
  -> SQLite state store + lexical RAG retriever
  -> AIBrix Gateway or direct vLLM replicas
  -> Qwen 4B customer support model
```

The FastAPI process does not load model weights. It owns customer support workflow state, RAG prompt assembly, SSE streaming, health checks, benchmark jobs, and dashboard metrics. vLLM remains the inference engine; AIBrix remains the multi-replica routing layer.

## Local Startup

```bash
# Seed demo knowledge after API starts:
python scripts/seed_customer_support_demo.py --run-eval

# Terminal 1
CUDA_VISIBLE_DEVICES=0 CONFIG_PATH=configs/serve/qwen3_4b_vllm_replica0.yaml bash scripts/serve_vllm_replica.sh

# Terminal 2
CUDA_VISIBLE_DEVICES=1 CONFIG_PATH=configs/serve/qwen3_4b_vllm_replica1.yaml bash scripts/serve_vllm_replica.sh

# Terminal 3
bash scripts/serve_api.sh

# Terminal 4
bash scripts/serve_web.sh
```

The API can run without vLLM. In that mode chat requests still perform retrieval and then emit a fallback response, which keeps the UI usable for demos while the model layer is offline.

`scripts/serve_web.sh` defaults to Vite preview over the built `dist/` directory to avoid exhausting Linux inotify watchers on large workspaces. Use `WEB_MODE=dev bash scripts/serve_web.sh` when hot reload is needed.

## Serving Paths

- `vllm-replica-0`: direct OpenAI-compatible call to GPU 0.
- `vllm-replica-1`: direct OpenAI-compatible call to GPU 1.
- `direct-round-robin`: FastAPI client-side round-robin across both vLLM replicas. Chat traces record the selected replica in `target_pod`.
- `aibrix-gateway`: OpenAI-compatible call through AIBrix Gateway for routing policy experiments.

For serving benchmarks, `direct-round-robin` uses the FastAPI OpenAI-compatible proxy endpoint:

```text
/api/proxy/direct-round-robin/v1/chat/completions
```

## Main Interfaces

- `POST /api/chat/sessions`
- `POST /api/chat/sessions/{session_id}/messages:stream`
- `POST /api/knowledge/documents`
- `GET /api/knowledge/search`
- `GET /api/service-instances`
- `POST /api/service-instances/{id}/healthcheck`
- `POST /api/chat/messages/{message_id}/feedback`
- `POST /api/benchmarks/serving`
- `GET /api/metrics/current`
- `GET /api/metrics/stream`

## V1 Boundaries

- Retrieval uses a SQLite-backed lexical scorer by default. The API response shape is stable so FAISS or an embedding retriever can replace it later.
- Benchmark jobs wrap `scripts/11_benchmark_serving.py` instead of duplicating benchmark logic.
- The React dashboard is an operator/demo UI, not a production access-control system.
- Deployment remains script-driven; the API observes and orchestrates the serving side only.

## Demo Dataset

- Knowledge base: `data/customer_support/knowledge_base.jsonl`
- Retrieval eval samples: `data/customer_support/eval_qa.jsonl`

The demo set covers normal FAQ, delayed shipping, invoice rules, member account risk, and prompt-injection style unsafe requests.
