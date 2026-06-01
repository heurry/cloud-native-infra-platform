#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

cd "${ROOT_DIR}"

SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-qwen3-4b-customer}"
AIBRIX_PORT="${AIBRIX_PORT:-8010}"
API_PORT="${API_PORT:-8088}"
WEB_PORT="${WEB_PORT:-5173}"
CADVISOR_PORT="${CADVISOR_PORT:-18080}"
ENABLE_CADVISOR="${ENABLE_CADVISOR:-1}"
WEB_MODE="${WEB_MODE:-preview}"
SKIP_BUILD="${SKIP_BUILD:-0}"

UNITS=(
  llm-vllm-replica0.service
  llm-vllm-replica1.service
  llm-aibrix-gateway.service
  llm-cadvisor-forward.service
  llm-customer-api.service
  llm-customer-web.service
)

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing required command: $1"
    exit 127
  fi
}

wait_http() {
  local url="$1"
  local timeout="${2:-120}"
  local start
  start="$(date +%s)"
  until curl -fsS "${url}" >/dev/null 2>&1; do
    if (( "$(date +%s)" - start >= timeout )); then
      log "timeout waiting for ${url}"
      return 1
    fi
    sleep 2
  done
}

wait_port() {
  local port="$1"
  local timeout="${2:-60}"
  local start
  start="$(date +%s)"
  until ss -ltn 2>/dev/null | grep -q "127.0.0.1:${port}"; do
    if (( "$(date +%s)" - start >= timeout )); then
      log "timeout waiting for 127.0.0.1:${port}"
      return 1
    fi
    sleep 1
  done
}

start_unit() {
  local unit="$1"
  shift
  log "starting ${unit}: $*"
  systemd-run --user \
    --unit="${unit%.service}" \
    --collect \
    --property=Restart=always \
    --property=RestartSec=3 \
    --working-directory="${ROOT_DIR}" \
    "$@"
}

main() {
  need_cmd kubectl
  need_cmd systemd-run
  need_cmd systemctl
  need_cmd curl
  need_cmd ss

  log "stopping old local service units"
  systemctl --user stop "${UNITS[@]}" >/dev/null 2>&1 || true

  log "verifying backend deployment"
  kubectl rollout status "deployment/${SERVED_MODEL_NAME}" -n default --timeout=300s

  local pods=()
  mapfile -t pods < <(
    kubectl get pods -n default -l "app=${SERVED_MODEL_NAME}" \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort
  )
  if [[ "${#pods[@]}" -lt 2 ]]; then
    log "expected 2 backend pods for ${SERVED_MODEL_NAME}, found ${#pods[@]}"
    exit 2
  fi

  local envoy_service
  envoy_service="$(kubectl get svc -n envoy-gateway-system -o name | grep 'envoy-aibrix-system-aibrix-eg' | head -1)"
  if [[ -z "${envoy_service}" ]]; then
    log "AIBrix Envoy service not found"
    exit 2
  fi

  start_unit llm-vllm-replica0.service kubectl port-forward -n default "pod/${pods[0]}" "8000:8000"
  start_unit llm-vllm-replica1.service kubectl port-forward -n default "pod/${pods[1]}" "8001:8000"
  wait_http "http://127.0.0.1:8000/health" 120
  wait_http "http://127.0.0.1:8001/health" 120

  start_unit llm-aibrix-gateway.service kubectl port-forward -n envoy-gateway-system "${envoy_service}" "${AIBRIX_PORT}:80"
  wait_port "${AIBRIX_PORT}" 60

  if [[ "${ENABLE_CADVISOR}" = "1" ]]; then
    kubectl apply -f deploy/observability/cadvisor.yaml
    kubectl rollout status daemonset/cadvisor -n observability --timeout=120s
    start_unit llm-cadvisor-forward.service kubectl port-forward -n observability service/cadvisor "${CADVISOR_PORT}:8080"
    wait_http "http://127.0.0.1:${CADVISOR_PORT}/metrics" 120
  fi

  start_unit llm-customer-api.service env PORT="${API_PORT}" bash scripts/serve_api.sh
  wait_http "http://127.0.0.1:${API_PORT}/api/health" 180

  start_unit llm-customer-web.service env PORT="${WEB_PORT}" WEB_MODE="${WEB_MODE}" SKIP_BUILD="${SKIP_BUILD}" bash scripts/serve_web.sh
  wait_http "http://127.0.0.1:${WEB_PORT}" 240

  log "local services are ready"
  log "vLLM replica 0: http://127.0.0.1:8000"
  log "vLLM replica 1: http://127.0.0.1:8001"
  log "AIBrix Gateway: http://127.0.0.1:${AIBRIX_PORT}/v1"
  log "FastAPI: http://127.0.0.1:${API_PORT}"
  log "Web: http://127.0.0.1:${WEB_PORT}"
  log "cAdvisor: http://127.0.0.1:${CADVISOR_PORT}/metrics"
  log "logs: journalctl --user -u llm-customer-api -u llm-customer-web -f"
}

main "$@"
