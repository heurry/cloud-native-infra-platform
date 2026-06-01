#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_DIR="${TARGET_DIR:-/mnt/nvme-data/containerd}"
SOURCE_DIR="${SOURCE_DIR:-/var/lib/containerd}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/containerd.bak.$(date +%Y%m%d_%H%M%S)}"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

run() {
  log "+ $*"
  "$@"
}

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

if [[ ! -d "${SOURCE_DIR}" && ! -L "${SOURCE_DIR}" ]]; then
  log "source does not exist: ${SOURCE_DIR}"
  exit 2
fi

if [[ -L "${SOURCE_DIR}" ]]; then
  log "${SOURCE_DIR} is already a symlink -> $(readlink -f "${SOURCE_DIR}")"
  exit 0
fi

if [[ -e "${BACKUP_DIR}" ]]; then
  log "backup path already exists: ${BACKUP_DIR}"
  exit 2
fi

if [[ "$(readlink -f "$(dirname "${TARGET_DIR}")")" == "/var/lib" ]]; then
  log "target must not live under /var/lib: ${TARGET_DIR}"
  exit 2
fi

log "source=${SOURCE_DIR}"
log "target=${TARGET_DIR}"
log "backup=${BACKUP_DIR}"
run df -hT / /mnt/nvme-data
run du -sh "${SOURCE_DIR}"

log "stopping Docker and containerd"
run systemctl stop docker
run systemctl stop containerd

log "copying containerd state to target"
run mkdir -p "${TARGET_DIR}"
run rsync -aHAX --info=progress2 "${SOURCE_DIR}/" "${TARGET_DIR}/"

log "switching ${SOURCE_DIR} to symlink"
run mv "${SOURCE_DIR}" "${BACKUP_DIR}"
run ln -s "${TARGET_DIR}" "${SOURCE_DIR}"

log "starting containerd and Docker"
run systemctl start containerd
run systemctl start docker

log "verification"
run systemctl is-active containerd
run systemctl is-active docker
run docker info --format '{{.DockerRootDir}}'
run docker ps
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]] && command -v minikube >/dev/null 2>&1; then
  run sudo -u "${SUDO_USER}" -H minikube status
fi
run df -hT / /mnt/nvme-data
run du -sh "${SOURCE_DIR}" "${TARGET_DIR}" "${BACKUP_DIR}"

log "migration completed. After verification, remove the backup with:"
log "  sudo rm -rf ${BACKUP_DIR}"
