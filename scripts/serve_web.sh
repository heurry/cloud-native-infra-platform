#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/apps/web"

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm is required to run the React dashboard." >&2
  exit 127
fi

if [ ! -d node_modules ]; then
  echo "[INFO] installing frontend dependencies with npm install"
  npm install
fi

PORT="${PORT:-5173}"
WEB_MODE="${WEB_MODE:-preview}"

if [ "${WEB_MODE}" = "dev" ]; then
  export CHOKIDAR_USEPOLLING="${CHOKIDAR_USEPOLLING:-true}"
  exec npm run dev -- --host 0.0.0.0 --port "${PORT}"
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build
elif [ ! -d dist ]; then
  npm run build
fi

exec npm run preview -- --host 0.0.0.0 --port "${PORT}"
