#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

cd "${ROOT_DIR}"
PYTHON_BIN="$(resolve_python_bin)"
CONFIG_PATH="${CONFIG_PATH:-configs/serve/qwen3_4b_vllm_replica0.yaml}"

readarray -t CFG_LINES < <(CONFIG_PATH="${CONFIG_PATH}" "${PYTHON_BIN}" - <<'PY'
import os
import yaml

with open(os.environ["CONFIG_PATH"], "r", encoding="utf-8") as f:
    cfg = yaml.safe_load(f)

for key, default in [
    ("model", ""),
    ("served_model_name", "qwen3-4b-customer"),
    ("tensor_parallel_size", 1),
    ("dtype", "float16"),
    ("quantization", ""),
    ("max_model_len", 4096),
    ("gpu_memory_utilization", 0.90),
    ("max_num_seqs", 64),
    ("max_num_batched_tokens", 8192),
    ("enable_prefix_caching", False),
    ("trust_remote_code", False),
    ("host", "0.0.0.0"),
    ("port", 8000),
    ("api_key", "EMPTY"),
]:
    print(f"{key}={cfg.get(key, default)}")
PY
)

for line in "${CFG_LINES[@]}"; do
  key="${line%%=*}"
  value="${line#*=}"
  case "${key}" in
    model) MODEL_PATH="${value}" ;;
    served_model_name) SERVED_MODEL_NAME="${value}" ;;
    tensor_parallel_size) TP_SIZE="${value}" ;;
    dtype) DTYPE="${value}" ;;
    quantization) QUANTIZATION="${value}" ;;
    max_model_len) MAX_MODEL_LEN="${value}" ;;
    gpu_memory_utilization) GPU_MEMORY_UTILIZATION="${value}" ;;
    max_num_seqs) MAX_NUM_SEQS="${value}" ;;
    max_num_batched_tokens) MAX_NUM_BATCHED_TOKENS="${value}" ;;
    enable_prefix_caching) ENABLE_PREFIX_CACHING="${value}" ;;
    trust_remote_code) TRUST_REMOTE_CODE="${value}" ;;
    host) HOST="${value}" ;;
    port) PORT="${value}" ;;
    api_key) API_KEY="${value}" ;;
  esac
done

EXTRA_ARGS=()
if [[ "${ENABLE_PREFIX_CACHING}" == "True" || "${ENABLE_PREFIX_CACHING}" == "true" ]]; then
  EXTRA_ARGS+=(--enable-prefix-caching)
fi
if [[ -n "${QUANTIZATION}" && "${QUANTIZATION}" != "None" ]]; then
  EXTRA_ARGS+=(--quantization "${QUANTIZATION}")
fi
if [[ "${TRUST_REMOTE_CODE}" == "True" || "${TRUST_REMOTE_CODE}" == "true" ]]; then
  EXTRA_ARGS+=(--trust-remote-code)
fi

echo "[INFO] serving ${MODEL_PATH} as ${SERVED_MODEL_NAME} on ${HOST}:${PORT}"
echo "[INFO] CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-unset}"

if [[ -x "${ROOT_DIR}/.venv/bin/vllm" ]]; then
  exec "${ROOT_DIR}/.venv/bin/vllm" serve "${MODEL_PATH}" \
    --served-model-name "${SERVED_MODEL_NAME}" \
    --tensor-parallel-size "${TP_SIZE}" \
    --dtype "${DTYPE}" \
    --max-model-len "${MAX_MODEL_LEN}" \
    --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
    --max-num-seqs "${MAX_NUM_SEQS}" \
    --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --api-key "${API_KEY}" \
    "${EXTRA_ARGS[@]}"
fi

exec "${PYTHON_BIN}" -m vllm.entrypoints.openai.api_server \
  --model "${MODEL_PATH}" \
  --served-model-name "${SERVED_MODEL_NAME}" \
  --tensor-parallel-size "${TP_SIZE}" \
  --dtype "${DTYPE}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
  --max-num-seqs "${MAX_NUM_SEQS}" \
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --api-key "${API_KEY}" \
  "${EXTRA_ARGS[@]}"
