#!/usr/bin/env bash
# D4 混沌实验（真实栈）：逐个杀 Redis / MinIO / AI 服务，验证 go-server 仍对外服务（降级不崩）。
#
# 这是「真实容器编排」下的混沌验证；自动化的进程内降级回归见
# server/internal/httpx/chaos_test.go（CI 的 integration job 会跑）。
#
# 用法（仓库根目录，先起栈）：
#   docker compose -f deploy/compose/docker-compose.yml up -d
#   BASE_URL=http://localhost:8081 deploy/chaos/run-chaos.sh
#
# 预期：每杀掉一个依赖后，下列只读路径仍返回 200（缓存穿透 / 限流放行 / 对象层降级 / AI 兜底）。
set -uo pipefail

COMPOSE="docker compose -f deploy/compose/docker-compose.yml"
BASE="${BASE_URL:-http://localhost:8081}"
PATHS=(/api/health /api/platform/overview /api/service-instances)
FAIL=0

probe() { curl -fsS -o /dev/null -w "%{http_code}" "$BASE$1" 2>/dev/null || echo "000"; }

assert_up() {
  for p in "${PATHS[@]}"; do
    code=$(probe "$p")
    if [ "$code" = "200" ]; then
      echo "    ✓ $p → $code (degraded OK)"
    else
      echo "    ✗ $p → $code (expected 200)"
      FAIL=1
    fi
  done
}

echo "== baseline (all deps up) =="
assert_up

for dep in redis minio python-ai-service; do
  echo "== chaos: kill $dep =="
  $COMPOSE kill "$dep" >/dev/null 2>&1 || true
  sleep 2
  assert_up
  echo "== restore: $dep =="
  $COMPOSE up -d "$dep" >/dev/null 2>&1 || true
  sleep 3
done

if [ "$FAIL" = "0" ]; then
  echo "✅ chaos passed: 平台在每个依赖单独故障时均保持可用（降级路径生效）"
else
  echo "❌ chaos failed: 某依赖故障下平台未优雅降级（见上方 ✗）"
  exit 1
fi
