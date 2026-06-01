#!/bin/bash
set -euo pipefail

echo "====================================="
echo "  GPU minikube 一键安装 / 启动"
echo "====================================="

MINIKUBE_CPUS="${MINIKUBE_CPUS:-12}"
MINIKUBE_MEMORY="${MINIKUBE_MEMORY:-24576}"
KUBECTL_MINOR="${KUBECTL_MINOR:-v1.31}"
NVIDIA_PLUGIN_VERSION="${NVIDIA_PLUGIN_VERSION:-v0.17.1}"
NVIDIA_PLUGIN_IMAGE="${NVIDIA_PLUGIN_IMAGE:-}"
MINIKUBE_IMAGE_REPOSITORY="${MINIKUBE_IMAGE_REPOSITORY:-}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] missing command: $1" >&2
    exit 1
  fi
}

# 1. 安装依赖
echo -e "\n[1/4] 安装依赖..."
DEPS=(apt-transport-https ca-certificates curl gnupg lsb-release)
MISSING_DEPS=()
for pkg in "${DEPS[@]}"; do
  if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
    MISSING_DEPS+=("${pkg}")
  fi
done

if [[ "${#MISSING_DEPS[@]}" -gt 0 ]]; then
  sudo apt update
  sudo apt install -y "${MISSING_DEPS[@]}"
else
  echo "[INFO] dependencies already installed, skip apt update"
fi

# 2. 安装 kubectl
echo -e "\n[2/4] 安装 kubectl..."
if command -v kubectl >/dev/null 2>&1; then
  echo "[INFO] kubectl already installed: $(kubectl version --client=true --short 2>/dev/null || kubectl version --client=true)"
else
  curl -fsSL "https://pkgs.k8s.io/core:/stable:/${KUBECTL_MINOR}/deb/Release.key" \
    | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/kubernetes-apt-keyring.gpg
  echo "deb [signed-by=/etc/apt/trusted.gpg.d/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${KUBECTL_MINOR}/deb/ /" \
    | sudo tee /etc/apt/sources.list.d/kubernetes.list
  sudo apt update
  sudo apt install -y kubectl
fi

# 3. 安装 minikube
echo -e "\n[3/4] 安装 minikube..."
if command -v minikube >/dev/null 2>&1; then
  echo "[INFO] minikube already installed: $(minikube version --short)"
else
  curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
  sudo install minikube-linux-amd64 /usr/local/bin/minikube
  rm -f minikube-linux-amd64
fi

echo -e "\n[3.5/4] 检查 Docker / NVIDIA..."
need_cmd docker
need_cmd nvidia-smi
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

if ! docker ps >/dev/null 2>&1; then
  echo "[ERROR] 当前用户无法访问 Docker daemon。请先执行以下命令后重新登录：" >&2
  echo "  sudo usermod -aG docker $USER" >&2
  exit 1
fi

# 4. 启动 GPU minikube
echo -e "\n[4/4] 启动 GPU minikube..."
MINIKUBE_START_ARGS=(
  --driver=docker \
  --container-runtime=docker \
  --gpus all \
  --cpus "${MINIKUBE_CPUS}" \
  --memory "${MINIKUBE_MEMORY}"
)

if [[ -n "${MINIKUBE_IMAGE_REPOSITORY}" ]]; then
  MINIKUBE_START_ARGS+=(--image-repository "${MINIKUBE_IMAGE_REPOSITORY}")
fi

for proxy_var in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  if [[ -n "${!proxy_var:-}" ]]; then
    MINIKUBE_START_ARGS+=(--docker-env "${proxy_var}=${!proxy_var}")
  fi
done

minikube start "${MINIKUBE_START_ARGS[@]}"

echo -e "\n[4.5/4] 安装 NVIDIA device plugin..."
kubectl delete ds -n kube-system nvidia-device-plugin-daemonset --ignore-not-found=true
kubectl apply -f "https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/${NVIDIA_PLUGIN_VERSION}/deployments/static/nvidia-device-plugin.yml"

if [[ -n "${NVIDIA_PLUGIN_IMAGE}" ]]; then
  echo "[INFO] override NVIDIA device plugin image: ${NVIDIA_PLUGIN_IMAGE}"
  kubectl -n kube-system set image ds/nvidia-device-plugin-daemonset \
    nvidia-device-plugin-ctr="${NVIDIA_PLUGIN_IMAGE}"
fi

echo "[INFO] waiting for NVIDIA device plugin pod..."
if ! kubectl -n kube-system rollout status ds/nvidia-device-plugin-daemonset --timeout=180s; then
  echo "[WARN] NVIDIA device plugin did not become ready within timeout."
  echo "[WARN] Recent events:"
  kubectl -n kube-system describe pod -l name=nvidia-device-plugin-ds | tail -n 80 || true
  DEVICE_PLUGIN_READY=false
else
  DEVICE_PLUGIN_READY=true
fi

echo
echo "[INFO] GPU resource check:"
kubectl get nodes
GPU_ALLOCATABLE="$(kubectl get node minikube -o jsonpath='{.status.allocatable.nvidia\.com/gpu}' 2>/dev/null || true)"
if ! kubectl describe node minikube | grep -i "nvidia.com/gpu" -A3; then
  echo "[WARN] nvidia.com/gpu is not registered yet."
  echo "[WARN] Check: kubectl -n kube-system describe pod -l name=nvidia-device-plugin-ds"
fi

if [[ "${DEVICE_PLUGIN_READY}" != "true" || -z "${GPU_ALLOCATABLE}" || "${GPU_ALLOCATABLE}" == "0" ]]; then
  echo
  echo "====================================="
  echo "  GPU minikube 未完全就绪 ❌"
  echo "====================================="
  echo "[ERROR] device plugin ready: ${DEVICE_PLUGIN_READY}"
  echo "[ERROR] allocatable nvidia.com/gpu: ${GPU_ALLOCATABLE:-missing}"
  echo "[ERROR] 如果卡在 nvcr.io 拉镜像，可重跑："
  echo "  NVIDIA_PLUGIN_IMAGE=ghcr.io/nvidia/k8s-device-plugin:e79cad2f bash kubectl.sh"
  exit 1
fi

echo -e "\n====================================="
echo "  安装成功 ✅ GPU minikube 已运行！"
echo "====================================="
