#!/usr/bin/env bash

# 一键拉起 Go 架构（控制面单一入口）。
#
# 拓扑（见 deploy/compose/docker-compose.yml）：
#   前端(:5173, host npm dev) → go-server(:8081 单一入口) ──┬─ 原生 ops（PostgreSQL + Redis + MinIO）
#                                                            ├─ /api/ai/*    → python-ai-service(:8200)
#                                                            ├─ k8s 直读      → client-go（minikube，可降级）
#                                                            └─ host/gpu 采集 → go-agent(:8090)
#
# 全部 /api 均为 Go 原生（含知识库 pgvector RAG、压测 runner、流式 chat）；legacy Python 单体已于 6B 退役。
#
# 本脚本只负责 Go 应用层（compose）+ 前端。GPU/推理层（minikube + AIBrix + vLLM + cAdvisor）
# 由 scripts/run_aibrix_4b_stack.sh 负责；不启动时本栈以降级模式运行：
#   - AI 服务回退 stub（AI_STUB_MODE=auto）
#   - go-server 的 k8s 直读 / vLLM 指标抓取 / cAdvisor 不可达 → 对应面降级，不阻塞启动
#
# 用法：
#   bash scripts/run_full_stack.sh            # 构建并拉起（默认）
#   SKIP_BUILD=1 bash scripts/run_full_stack.sh
#   SKIP_WEB=1   bash scripts/run_full_stack.sh
#   ALLOW_MINIKUBE_DOWN=1 bash scripts/run_full_stack.sh  # 明知 minikube 未运行仍降级启动
#   bash scripts/run_full_stack.sh down       # 停掉本栈（保留数据卷）+ 关前端
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

cd "${ROOT_DIR}"

if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  printf '[INFO] Do not run this stack script with sudo. Re-executing as %s.\n' "${SUDO_USER}" >&2
  exec sudo -u "${SUDO_USER}" -H bash "$0" "$@"
fi

ACTION="${1:-up}"

TS="$(date +%Y%m%d_%H%M%S)"
LOG_DIR="${LOG_DIR:-logs/full_stack/${TS}}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/run.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose/docker-compose.yml}"
SERVER_PORT="${SERVER_PORT:-8081}"
AI_PORT="${AI_PORT:-8200}"
AGENT_PORT="${AGENT_PORT:-8090}"
PG_PORT="${PG_PORT:-5432}"
WEB_PORT="${WEB_PORT:-5173}"
GATEWAY_PORT="${GATEWAY_PORT:-8010}"

SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_WEB="${SKIP_WEB:-0}"
RESTART_WEB="${RESTART_WEB:-1}"
WEB_MODE="${WEB_MODE:-dev}"
REGEN_KUBECONFIG="${REGEN_KUBECONFIG:-0}"
# minikube 容器存在但未运行时默认快速失败（避免 go-server 抢占 192.168.49.2）；
# 置 1 可在明知降级的前提下强行启动。
ALLOW_MINIKUBE_DOWN="${ALLOW_MINIKUBE_DOWN:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
KUBECONFIG_SECRET="${KUBECONFIG_SECRET:-deploy/compose/.secrets/kubeconfig}"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

run() {
  log "+ $*"
  "$@"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing command: $1"
    exit 127
  fi
}

# docker compose v2（插件）；不支持 v1 docker-compose。
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

capture_diagnostics() {
  local status="${1:-unknown}"
  log "capturing diagnostics, status=${status}, log_dir=${LOG_DIR}"
  "${COMPOSE[@]}" ps > "${LOG_DIR}/compose_ps.txt" 2>&1 || true
  "${COMPOSE[@]}" logs --no-color --tail=300 > "${LOG_DIR}/compose_logs.txt" 2>&1 || true
  ss -ltnp > "${LOG_DIR}/listening_ports.txt" 2>&1 || true
  docker ps > "${LOG_DIR}/docker_ps.txt" 2>&1 || true
}

on_error() {
  local status=$?
  log "failed with exit code ${status}"
  capture_diagnostics "${status}"
  exit "${status}"
}
trap on_error ERR

wait_http() {
  local url="$1"
  local timeout="${2:-180}"
  local start
  start="$(date +%s)"
  until curl -fsS "${url}" >/dev/null 2>&1; do
    if (( "$(date +%s)" - start > timeout )); then
      log "timeout waiting for ${url}"
      return 1
    fi
    sleep 2
  done
}

kill_port() {
  local port="$1"
  local pids
  pids="$(ss -ltnp 2>/dev/null | sed -n "s/.*127\\.0\\.0\\.1:${port}.*pid=\\([0-9][0-9]*\\).*/\\1/p" | sort -u || true)"
  [[ -z "${pids}" ]] && return 0
  for pid in ${pids}; do
    log "stopping pid ${pid} on 127.0.0.1:${port}"
    kill "${pid}" 2>/dev/null || true
  done
  sleep 2
}

stack_down() {
  log "stopping Go stack (compose down, keep volumes)"
  run "${COMPOSE[@]}" down --remove-orphans || true
  kill_port "${WEB_PORT}"
  log "Go stack stopped. Data volume (pgdata) preserved; add -v to drop it."
}

preflight() {
  need_cmd docker
  need_cmd curl
  need_cmd ss
  [[ "${SKIP_WEB}" = "1" ]] || need_cmd npm

  if ! docker compose version >/dev/null 2>&1; then
    log "docker compose v2 plugin is required (got none). Install Docker Compose v2."
    exit 127
  fi
  if ! docker ps >/dev/null 2>&1; then
    log "current user cannot access the Docker daemon."
    log "  sudo usermod -aG docker ${USER}   # then re-login"
    exit 1
  fi
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    log "compose file not found: ${COMPOSE_FILE}"
    exit 2
  fi

  # compose 把 minikube 声明为 external 网络；不存在则 up 会直接失败。
  if ! docker network ls --format '{{.Name}}' | grep -qx minikube; then
    log "external docker network 'minikube' not found."
    log "  start minikube first (scripts/run_aibrix_4b_stack.sh), or create a placeholder:"
    log "    docker network create minikube"
    exit 1
  fi

  # 加固：minikube 网络存在、但 minikube 容器未运行 → 快速失败。
  # 此时 .2（minikube 保留的控制面 IP）无人认领，拉起 Go 栈会让 Docker 把它分给
  # go-server，之后 `minikube start` 必撞 "Address already in use"（启动顺序坑）。
  if docker inspect minikube >/dev/null 2>&1; then
    local mk_status holder
    mk_status="$(docker inspect -f '{{.State.Status}}' minikube 2>/dev/null || echo unknown)"
    if [[ "${mk_status}" != "running" ]]; then
      if [[ "${ALLOW_MINIKUBE_DOWN}" = "1" ]]; then
        log "[WARN] minikube container is '${mk_status}' (ALLOW_MINIKUBE_DOWN=1): proceeding in degraded mode;"
        log "        go-server may grab 192.168.49.2 and later block 'minikube start'."
      else
        log "[FATAL] minikube container exists but is '${mk_status}', not running."
        log "        Starting the Go stack now lets Docker assign minikube's reserved IP"
        log "        192.168.49.2 to go-server; 'minikube start' then fails with 'Address already in use'."
        holder="$(docker network inspect minikube \
          -f '{{range .Containers}}{{if eq .IPv4Address "192.168.49.2/24"}}{{.Name}} {{end}}{{end}}' 2>/dev/null || true)"
        if [[ -n "${holder// /}" && "${holder// /}" != "minikube" ]]; then
          log "        192.168.49.2 is currently held by: ${holder% }"
          log "        Release it first:  docker compose -f ${COMPOSE_FILE} down"
        fi
        log "        Fix — bring up the inference layer FIRST, then re-run this script:"
        log "          bash scripts/run_aibrix_4b_stack.sh"
        log "          bash scripts/run_full_stack.sh"
        log "        Or run the Go stack standalone on purpose: ALLOW_MINIKUBE_DOWN=1 bash scripts/run_full_stack.sh"
        exit 1
      fi
    fi
  fi

  # minikube 停止 → k8s 直读 / vLLM 指标 / cAdvisor 不可达，go-server 降级（不阻塞）。
  if command -v minikube >/dev/null 2>&1; then
    if minikube status >/dev/null 2>&1; then
      log "minikube is running (live cluster/GPU metrics available)"
    else
      log "[WARN] minikube is not running — Go stack will start in DEGRADED mode:"
      log "        AI service → stub, k8s/serving/cAdvisor metrics unavailable."
      log "        For live mode run: bash scripts/run_aibrix_4b_stack.sh"
    fi
  fi

  if [[ ! -f "${KUBECONFIG_SECRET}" ]]; then
    log "[WARN] kubeconfig secret missing: ${KUBECONFIG_SECRET}"
    log "        go-server k8s direct-read will be disabled (degraded)."
  fi
}

regen_kubeconfig() {
  [[ "${REGEN_KUBECONFIG}" = "1" ]] || return 0
  if ! command -v minikube >/dev/null 2>&1 || ! minikube status >/dev/null 2>&1; then
    log "[WARN] REGEN_KUBECONFIG=1 but minikube is not running; keeping existing secret."
    return 0
  fi
  need_cmd kubectl
  mkdir -p "$(dirname "${KUBECONFIG_SECRET}")"
  log "regenerating embedded-cert kubeconfig from current minikube → ${KUBECONFIG_SECRET}"
  kubectl config view --minify --flatten > "${KUBECONFIG_SECRET}"
}

compose_up() {
  local args=(up -d)
  [[ "${SKIP_BUILD}" = "1" ]] || args+=(--build)
  log "bringing up Go stack via compose (this builds go-server/go-agent/ai-service on first run)"
  run "${COMPOSE[@]}" "${args[@]}"
  "${COMPOSE[@]}" ps
}

wait_health() {
  log "waiting for python-ai-service http://127.0.0.1:${AI_PORT}/internal/health"
  wait_http "http://127.0.0.1:${AI_PORT}/internal/health" "${HEALTH_TIMEOUT}"
  log "waiting for go-server (single entry) http://127.0.0.1:${SERVER_PORT}/api/health"
  wait_http "http://127.0.0.1:${SERVER_PORT}/api/health" "${HEALTH_TIMEOUT}"
}

start_web() {
  if [[ "${SKIP_WEB}" = "1" ]]; then
    log "SKIP_WEB=1, not starting React dashboard"
    return 0
  fi
  [[ "${RESTART_WEB}" = "1" ]] && kill_port "${WEB_PORT}"
  if ss -ltnp 2>/dev/null | grep -q "127.0.0.1:${WEB_PORT}\|:::${WEB_PORT}\|0.0.0.0:${WEB_PORT}"; then
    log "web is already listening on ${WEB_PORT}"
  else
    log "starting React dashboard (${WEB_MODE}) on ${WEB_PORT}, proxy → go-server :${SERVER_PORT}"
    WEB_MODE="${WEB_MODE}" \
    PORT="${WEB_PORT}" \
    VITE_PROXY_TARGET="http://127.0.0.1:${SERVER_PORT}" \
      nohup bash scripts/serve_web.sh > "${LOG_DIR}/web.log" 2>&1 &
    echo "$!" > "${LOG_DIR}/web.pid"
  fi
  wait_http "http://127.0.0.1:${WEB_PORT}" 240
}

smoke_test() {
  log "smoke: go-server native health"
  run curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/health" | tee "${LOG_DIR}/health.json"; echo
  log "smoke: go-server native ops (Postgres-backed service registry)"
  curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/service-instances" >/dev/null \
    && log "  /api/service-instances OK" \
    || log "  [WARN] /api/service-instances not OK"
  log "smoke: go-server native metrics (vLLM scraper + cAdvisor, degrades gracefully)"
  curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/metrics/current" >/dev/null \
    && log "  /api/metrics/current OK" \
    || log "  [WARN] /api/metrics/current not OK"
}

summary() {
  local serving_state="degraded (stub AI, no live cluster metrics)"
  curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/v1/models" >/dev/null 2>&1 && serving_state="live (AIBrix gateway reachable)"
  log "================ Go full stack is up ================"
  log "Dashboard (single entry):  http://127.0.0.1:${WEB_PORT}"
  log "go-server (control plane):  http://127.0.0.1:${SERVER_PORT}/api/health"
  log "python-ai-service:          http://127.0.0.1:${AI_PORT}/internal/health"
  log "go-agent (node collector):  http://127.0.0.1:${AGENT_PORT}/healthz"
  log "PostgreSQL:                 127.0.0.1:${PG_PORT} (infra/infra, db=infra_platform)"
  log "Serving/LLM layer:          ${serving_state}"
  log "Logs:                       ${LOG_DIR}"
  log "Tear down:                  bash scripts/run_full_stack.sh down"
  log "====================================================="
}

main() {
  if [[ "${ACTION}" == "down" || "${ACTION}" == "stop" ]]; then
    need_cmd docker
    stack_down
    exit 0
  fi

  log "log_dir=${LOG_DIR}"
  log "compose_file=${COMPOSE_FILE}"

  preflight
  regen_kubeconfig
  compose_up
  wait_health
  start_web
  smoke_test
  capture_diagnostics "success"
  summary
}

main "$@"
