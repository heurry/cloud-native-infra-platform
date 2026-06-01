#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="model/Qwen3.5-4B"
MODEL_NAME="qwen3-4b-customer"
PORT=8000
BASE_URL="http://127.0.0.1:${PORT}/v1"
API_KEY="${API_KEY:-EMPTY}"

CONCURRENCY_LEVELS="1,2,4,8,16"
REQUESTS_PER_LEVEL=32
PROMPT_PROFILE="mixed"

mkdir -p runs/serve logs

SERVE_PID=""

stop_old_service() {
  echo "========== Stop old vLLM service on port ${PORT} =========="

  if [[ -n "${SERVE_PID}" ]] && kill -0 "${SERVE_PID}" 2>/dev/null; then
    echo "[INFO] stopping process group: ${SERVE_PID}"
    kill -TERM "-${SERVE_PID}" 2>/dev/null || true
    sleep 5
    kill -KILL "-${SERVE_PID}" 2>/dev/null || true
  fi

  if command -v lsof >/dev/null 2>&1; then
    OLD_PIDS=$(lsof -ti tcp:${PORT} || true)
    if [[ -n "${OLD_PIDS}" ]]; then
      echo "[INFO] killing existing pids on port ${PORT}: ${OLD_PIDS}"
      kill -TERM ${OLD_PIDS} 2>/dev/null || true
      sleep 5
      kill -KILL ${OLD_PIDS} 2>/dev/null || true
    fi
  elif command -v fuser >/dev/null 2>&1; then
    echo "[INFO] killing existing process using tcp/${PORT}"
    fuser -k ${PORT}/tcp 2>/dev/null || true
  else
    echo "[WARN] neither lsof nor fuser found, skip port cleanup"
  fi

  sleep 3
}

wait_for_server() {
  echo "========== Wait for vLLM server ready =========="

  local max_wait=600
  local waited=0

  until curl -fsS -H "Authorization: Bearer ${API_KEY}" "${BASE_URL}/models" >/dev/null 2>&1; do
    sleep 5
    waited=$((waited + 5))

    if [[ -n "${SERVE_PID}" ]] && ! kill -0 "${SERVE_PID}" 2>/dev/null; then
      echo "[ERROR] vLLM server process exited before readiness"
      echo "[ERROR] recent log:"
      tail -n 80 "${CURRENT_LOG_PATH:-/dev/null}" || true
      exit 1
    fi

    if [[ "${waited}" -ge "${max_wait}" ]]; then
      echo "[ERROR] vLLM server not ready after ${max_wait}s"
      echo "[ERROR] recent log:"
      tail -n 80 "${CURRENT_LOG_PATH:-/dev/null}" || true
      exit 1
    fi

    echo "[INFO] waiting... ${waited}s"
  done

  echo "[INFO] vLLM server is ready"
}

run_one_config() {
  local label="$1"
  local max_num_seqs="$2"
  local max_num_batched_tokens="$3"
  local enable_prefix_caching="$4"

  local json_path="runs/serve/${label}.json"
  local report_path="runs/serve/${label}.md"
  local log_path="logs/${label}.log"
  CURRENT_LOG_PATH="${log_path}"

  stop_old_service

  echo
  echo "============================================================"
  echo "Start config: ${label}"
  echo "max_num_seqs=${max_num_seqs}"
  echo "max_num_batched_tokens=${max_num_batched_tokens}"
  echo "enable_prefix_caching=${enable_prefix_caching}"
  echo "============================================================"

  local serve_cmd=(
    bash scripts/10_serve_vllm.sh
    "${MODEL_PATH}"
    --port "${PORT}"
    --served-model-name "${MODEL_NAME}"
    --max-num-seqs "${max_num_seqs}"
    --max-num-batched-tokens "${max_num_batched_tokens}"
  )

  if [[ "${enable_prefix_caching}" == "true" ]]; then
    serve_cmd+=(--enable-prefix-caching)
  fi

  CUDA_VISIBLE_DEVICES=0,1 setsid "${serve_cmd[@]}" > "${log_path}" 2>&1 &

  SERVE_PID=$!
  echo "[INFO] serve pid: ${SERVE_PID}"
  echo "[INFO] log file: ${log_path}"

  wait_for_server

  echo "========== Run benchmark: ${label} =========="

  python scripts/11_benchmark_serving.py \
    --endpoint_label "vllm-direct-${label}" \
    --base_url "${BASE_URL}" \
    --model "${MODEL_NAME}" \
    --concurrency_levels "${CONCURRENCY_LEVELS}" \
    --requests_per_level "${REQUESTS_PER_LEVEL}" \
    --prompt_profile "${PROMPT_PROFILE}" \
    --extra_header "Authorization=Bearer ${API_KEY}" \
    --output_json "${json_path}" \
    --output_report "${report_path}"

  echo "[INFO] benchmark done"
  echo "[INFO] json: ${json_path}"
  echo "[INFO] report: ${report_path}"
}

cleanup() {
  echo
  echo "========== Cleanup =========="
  stop_old_service
}

trap cleanup EXIT INT TERM

run_one_config "seqs8_tokens4096" 8 4096 false
run_one_config "seqs16_tokens8192" 16 8192 true
run_one_config "seqs32_tokens16384" 32 16384 true

echo
echo "============================================================"
echo "All vLLM parameter benchmarks finished."
echo "Reports:"
echo "  runs/serve/seqs8_tokens4096.md"
echo "  runs/serve/seqs16_tokens8192.md"
echo "  runs/serve/seqs32_tokens16384.md"
echo "============================================================"
