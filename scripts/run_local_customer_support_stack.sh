#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

cat <<'EOF'
Start the local customer support stack in separate terminals:

1. vLLM replica 0
   CUDA_VISIBLE_DEVICES=0 CONFIG_PATH=configs/serve/qwen3_4b_vllm_replica0.yaml bash scripts/serve_vllm_replica.sh

2. vLLM replica 1
   CUDA_VISIBLE_DEVICES=1 CONFIG_PATH=configs/serve/qwen3_4b_vllm_replica1.yaml bash scripts/serve_vllm_replica.sh

3. FastAPI gateway
   bash scripts/serve_api.sh

4. React dashboard
   bash scripts/serve_web.sh

5. Demo data
   .venv/bin/python scripts/seed_customer_support_demo.py --run-eval

The API will still run without vLLM; chat requests will emit fallback events.
Use endpoint `direct-round-robin` to route through the FastAPI proxy across both local vLLM replicas.
EOF
