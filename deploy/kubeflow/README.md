# Kubeflow Training Operator（Phase F / F1）

控制面经 client-go **dynamic client** 管理 `PyTorchJob`（`kubeflow.org/v1`）做分布式 LoRA 微调。
本目录只装 **Training Operator（standalone）**——不上 Kubeflow 全家桶（Istio / Pipelines / Katib）。

完整方案见 [`docs/KUBEFLOW-TRAINING-PLAN.md`](../../docs/KUBEFLOW-TRAINING-PLAN.md)；F1 只做 plumbing（operator + 控制面 dynamic client + feature flag），**不含** job 生命周期 API / DB / 前端（F2 起）。

## 安装

```bash
kubectl apply --server-side -k deploy/kubeflow/
```

> 注：operator 镜像与 CRD 来自上游 standalone overlay（pin `v1.8.1`）。受限网络下镜像可能拉不下来，
> 需预拉或换源（同此前 metrics-server 的坑）。

## 校验

```bash
kubectl get crd pytorchjobs.kubeflow.org          # CRD 已注册
kubectl -n kubeflow get pods                       # training-operator 控制器 Running
kubectl get ns training                            # 训练任务命名空间
```

本地 overlay 只启用 `pytorchjob` controller，避免为未使用的 TF/MPI/MXNet/Paddle/XGBoost
任务建立额外 informer。若日志出现 `too many open files`，检查宿主机
`fs.inotify.max_user_instances`；建议至少为 `1024`。

```bash
docker run --rm --privileged alpine:3.20 \
  sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=524288
```

为避免 9p 在读取多 GB 权重时出现 I/O 错误，将训练素材同步到 Minikube 节点本地目录：

```bash
docker exec minikube mkdir -p /opt/twinforge/models /opt/twinforge/data /opt/twinforge/artifacts/training
docker cp /mnt/nvme-data/models/LLM_model/Qwen3.5-4B \
  minikube:/opt/twinforge/models/Qwen3.5-4B
docker cp data/cleaned/dianjin_csc_sft_train.jsonl \
  minikube:/opt/twinforge/data/dianjin_csc_sft_train.jsonl
```

训练产物上传到 Compose MinIO。首次安装时创建本地开发 Secret：

```bash
kubectl -n training create secret generic training-artifacts \
  --from-literal=S3_ENDPOINT=http://192.168.49.1:9000 \
  --from-literal=S3_ACCESS_KEY=minioadmin \
  --from-literal=S3_SECRET_KEY=minioadmin \
  --from-literal=S3_BUCKET=infra-artifacts
```

## 控制面接线（F1）

- Go 控制面启动时构造 `internal/training.Client`（dynamic client，in-cluster → kubeconfig 回退）；
  集群不可达 / CRD 未装时**优雅降级**（不阻塞启动）。
- 训练写操作（F2 接入）受双重约束，复用既有安全模型：
  - `ALLOW_TRAINING=true`（默认关）——总开关；
  - `TRAINING_NAMESPACES=training`（允许名单）——写操作只放行名单内命名空间；
  - serving 组件命名空间（`aibrix`/`envoy`/`vllm`/`qwen`）与系统命名空间经 `guardNamespace` **硬禁**。

## 资源 / 显存

训练与 serving 共享 GPU。serving 的 vLLM `--gpu-memory-utilization` 已降到 `0.60`（见
`docs/KUBEFLOW-TRAINING-PLAN.md` §8）；切到 Qwen3-1.7B 后目标按单卡划分 serving≈0.40 / 训练≈0.50。
训练前可用 A2 的 scale 把某 vLLM 副本缩到 0 腾卡。

## 卸载

```bash
kubectl delete -k deploy/kubeflow/
```
