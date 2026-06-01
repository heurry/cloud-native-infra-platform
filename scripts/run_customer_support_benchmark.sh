#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

cd "${ROOT_DIR}"
PYTHON_BIN="$(resolve_python_bin)"

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8088}"
ENDPOINT_ID="${ENDPOINT_ID:-aibrix-gateway}"
WORKLOAD="${WORKLOAD:-mixed_peak}"
ROUTING_STRATEGY="${ROUTING_STRATEGY:-least-request}"

"${PYTHON_BIN}" - <<'PY'
import json
import os
import urllib.request

api_base = os.environ.get("API_BASE_URL", "http://127.0.0.1:8088").rstrip("/")
payload = {
    "endpoint_id": os.environ.get("ENDPOINT_ID", "aibrix-gateway"),
    "workload": os.environ.get("WORKLOAD", "mixed_peak"),
    "routing_strategy": os.environ.get("ROUTING_STRATEGY", "least-request"),
    "concurrency_levels": [1, 2, 4, 8, 16, 32],
    "requests_per_level": 32,
    "max_tokens": 256,
}
request = urllib.request.Request(
    api_base + "/api/benchmarks/serving",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode("utf-8"))
PY
