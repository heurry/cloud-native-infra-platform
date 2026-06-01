#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

cd "${ROOT_DIR}"
PYTHON_BIN="$(resolve_python_bin)"
CONFIG_PATH="${CONFIG_PATH:-configs/serve/aibrix_gateway.yaml}"

readarray -t CFG_LINES < <(CONFIG_PATH="${CONFIG_PATH}" "${PYTHON_BIN}" - <<'PY'
import os
import yaml

with open(os.environ["CONFIG_PATH"], "r", encoding="utf-8") as f:
    cfg = yaml.safe_load(f)

gateway = cfg["gateway"]
benchmark = cfg["benchmark"]
print(f"endpoint_label={gateway['endpoint_label']}")
print(f"base_url={gateway['base_url']}")
print(f"model={gateway['model']}")
print(f"tokenizer_path={gateway['tokenizer_path']}")
print(f"routing_strategy={gateway['request_headers'].get('routing-strategy', '')}")
print(f"user={gateway['request_headers'].get('user', 'benchmark')}")
print("target_pod_headers=" + ",".join(gateway.get("target_pod_headers", [])))
print("concurrency_levels=" + ",".join(str(item) for item in benchmark["concurrency_levels"]))
print(f"requests_per_level={benchmark['requests_per_level']}")
print(f"prompt_profile={benchmark['prompt_profile']}")
print(f"max_tokens={benchmark['max_tokens']}")
print(f"output_json={benchmark['output_json']}")
print(f"output_report={benchmark['output_report']}")
PY
)

for line in "${CFG_LINES[@]}"; do
  key="${line%%=*}"
  value="${line#*=}"
  case "${key}" in
    endpoint_label) ENDPOINT_LABEL="${value}" ;;
    base_url) BASE_URL="${value}" ;;
    model) MODEL="${value}" ;;
    tokenizer_path) TOKENIZER_PATH="${value}" ;;
    routing_strategy) ROUTING_STRATEGY="${value}" ;;
    user) USER_NAME="${value}" ;;
    target_pod_headers) TARGET_POD_HEADERS="${value}" ;;
    concurrency_levels) CONCURRENCY_LEVELS="${value}" ;;
    requests_per_level) REQUESTS_PER_LEVEL="${value}" ;;
    prompt_profile) PROMPT_PROFILE="${value}" ;;
    max_tokens) MAX_TOKENS="${value}" ;;
    output_json) OUTPUT_JSON="${value}" ;;
    output_report) OUTPUT_REPORT="${value}" ;;
  esac
done

TARGET_HEADER_ARGS=()
IFS=',' read -r -a TARGET_HEADER_ARRAY <<< "${TARGET_POD_HEADERS}"
for header in "${TARGET_HEADER_ARRAY[@]}"; do
  if [[ -n "${header}" ]]; then
    TARGET_HEADER_ARGS+=(--target_pod_header "${header}")
  fi
done

"${PYTHON_BIN}" scripts/11_benchmark_serving.py \
  --endpoint_label "${ENDPOINT_LABEL}" \
  --base_url "${BASE_URL}" \
  --model "${MODEL}" \
  --tokenizer_path "${TOKENIZER_PATH}" \
  --concurrency_levels "${CONCURRENCY_LEVELS}" \
  --requests_per_level "${REQUESTS_PER_LEVEL}" \
  --prompt_profile "${PROMPT_PROFILE}" \
  --max_tokens "${MAX_TOKENS}" \
  --routing_strategy "${ROUTING_STRATEGY}" \
  --user "${USER_NAME}" \
  --output_json "${OUTPUT_JSON}" \
  --output_report "${OUTPUT_REPORT}" \
  "${TARGET_HEADER_ARGS[@]}"
