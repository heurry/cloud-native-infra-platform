#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_python_bin() {
  if [ -x "${ROOT_DIR}/.venv/bin/python" ]; then
    echo "${ROOT_DIR}/.venv/bin/python"
  else
    echo "python"
  fi
}
