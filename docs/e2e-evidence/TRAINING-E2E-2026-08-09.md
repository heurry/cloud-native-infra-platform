# Qwen3.5-4B Kubernetes Training E2E Evidence

Date: 2026-08-09

## Environment

- Host: single node, 2 x NVIDIA GeForce RTX 3090 (24 GiB each)
- Kubernetes: Minikube v1.38.1, Kubernetes v1.35.1, Docker runtime
- Training controller: Kubeflow Training Operator standalone v1.8.1 overlay
- Training image: `local/train:qwen35-v1`
- Base model: Qwen3.5-4B, 8.8 GiB node-local copy
- Dataset: DianJin-CSC-Data, 13,087 dialogues converted to 163,215 assistant-response SFT samples
- Artifact store: MinIO bucket `infra-artifacts`

## Single-GPU Control Test

- Platform job ID: `255a0107-3047-43d2-adf3-af9120e80222`
- PyTorchJob: `training/qwen35-lora-k8s-smoke-0809`
- Topology: Master 1, Worker 0, 1 GPU per replica
- Result: `Succeeded`; Master succeeded 1, failed 0, restart 0
- LoRA trainable parameters: 21,233,664 / 4,560,499,200 (0.4656%)
- Smoke loss: 3.469086 after one optimization step
- Registered version ID: `77c2921c-5da0-4e90-bedc-685fadae5951`
- Artifact prefix: `models/qwen35-4b-customer/lora-k8s-smoke-0809/adapter`

## Two-GPU Distributed Test

- Platform job ID: `73fef84a-36b9-4b89-92b0-55faa8a7a99e`
- PyTorchJob: `training/qwen35-lora-ddp-smoke-0809`
- Topology: Master 1 + Worker 1, 1 GPU per replica
- Runtime: cross-Pod `torchrun`, NCCL, PEFT LoRA, DeepSpeed ZeRO-2, BF16
- Result: `Succeeded`; Master succeeded 1, Worker succeeded 1, failed 0, restarts 0
- Smoke loss: 3.489964 after one distributed optimization step
- Registered version ID: `6fbb9f75-44c9-4cff-8a58-03350ae2ea63`
- Artifact prefix: `models/qwen35-4b-customer/lora-ddp-smoke-0809/adapter`

The MinIO prefix contains `adapter_model.safetensors` (84,972,248 bytes),
`adapter_config.json`, tokenizer files, chat template and model card.

## Verified Platform Flow

1. The Go control plane accepted the request and created a PostgreSQL training ledger record.
2. The runner submitted a real `kubeflow.org/v1` PyTorchJob.
3. Training Operator created GPU Master/Worker Pods and injected distributed rendezvous variables.
4. The control plane polled Created/Running/Succeeded and replica status into job metadata.
5. The training process saved a PEFT adapter and uploaded it to MinIO.
6. The runner registered a model version and linked it back to the training job.
7. The training page can expand the same row to show PyTorchJob, Pods, events and logs.

## Honest Boundary

These are minimal one-step GPU smoke runs intended to prove orchestration, distributed execution,
artifact archival and model registration. They are not a model-quality claim. A resume-quality full
experiment still needs a larger train/eval split, enough optimization steps, loss curves and held-out
customer-service quality regression.
