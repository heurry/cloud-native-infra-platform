#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

cd "${ROOT_DIR}"
PYTHON_BIN="$(resolve_python_bin)"
CONFIG_PATH="${CONFIG_PATH:-configs/app/customer_support_api.yaml}"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8088}"
RELOAD="${RELOAD:-0}"

export CUSTOMER_SUPPORT_API_CONFIG="${CONFIG_PATH}"
export SERVICE_INSTANCES_CONFIG="${SERVICE_INSTANCES_CONFIG:-configs/app/service_instances.yaml}"

if ! "${PYTHON_BIN}" - <<'PY' >/dev/null 2>&1
import importlib.util
raise SystemExit(0 if importlib.util.find_spec("fastapi") and importlib.util.find_spec("uvicorn") else 1)
PY
then
  echo "[ERROR] FastAPI API dependencies are missing. Install requirements first." >&2
  echo "  .venv/bin/pip install -r requirements.txt" >&2
  exit 127
fi

if [ "${RELOAD}" = "1" ]; then
  exec "${PYTHON_BIN}" -m uvicorn src.api.main:app --host "${HOST}" --port "${PORT}" --reload
fi

exec "${PYTHON_BIN}" -m uvicorn src.api.main:app --host "${HOST}" --port "${PORT}"
