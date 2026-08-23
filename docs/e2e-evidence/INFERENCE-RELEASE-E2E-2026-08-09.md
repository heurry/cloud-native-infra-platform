# Qwen3.6-27B-FP8 inference release E2E evidence

Date: 2026-08-09

## Scope

This validates the single-node, dual-GPU production release path:

```text
registered model version
  -> parameter-matched benchmark evidence
  -> release gate
  -> controlled vLLM runtime start
  -> OpenAI-compatible readiness
  -> model/service status update
  -> controlled stop and GPU release
```

The runtime is managed by the Node Agent through a fixed Docker workload. Kubernetes remains the
platform control plane for training and general workloads; moving this 29GB model runtime to a K8s
Deployment/Service adapter still requires syncing the model into the Minikube node.

## Release contract

- Model version ID: `11824fb8-16d7-4c91-ab04-13f7fe7ffb94`
- Model ID: `qwen36-27b-fp8`
- Endpoint: `qwen36-27b-fp8-vllm`
- Production profile: `balanced`
- Runtime profile: `prefix_cache`
- `max_num_seqs`: `8`
- `max_num_batched_tokens`: `4096`
- Prefix caching: enabled
- Chunked prefill: enabled
- Tensor parallel size: `2`

The balanced profile is bound to benchmark run
`966ed21f-4657-4b1e-a63f-6f126afd338f`: 10 scenarios, minimum request success rate 100%,
minimum output quality gate 100%.

The high-throughput profile is separately bound to run
`1ca1cc1a-5a63-4aa7-927e-489a25f6157c`: 4 fair C8/C16 scenarios, 100% success and quality gates.

## Observed result

- Initial release ID: `1d07ed26-5c9b-4e72-9ab7-5b8190d4369e`
- Cold start: about 2 minutes 20 seconds
- Release transitions: `starting -> warming -> succeeded`
- `/v1/models` returned `qwen36-27b-fp8`
- A customer-service completion returned a non-empty Chinese answer and `finish_reason=stop`
- Model registry changed from `registered` to `serving`
- Service instance changed to `healthy` and recorded the release ID/profile/version
- Controlled stop changed the release to `rolled_back/stopped`, removed the container, and released GPU memory
- A failed profile replacement restores the previously ready runtime request; the release metadata records the rollback attempt
- Final online release ID: `563a13cb-a060-4e72-9a61-93a11939cbcd`
- The second balanced release reached `succeeded`; the final environment remains online

For Qwen reasoning models, release smoke requests explicitly set
`chat_template_kwargs.enable_thinking=false`; a small output budget can otherwise be consumed by
reasoning before final `content` is emitted.

## Negative gate

Submitting the Qwen3.5 LoRA smoke version to this release channel returned HTTP 409 with
`release_model_mismatch`. No runtime was started. The backend therefore does not rely on the
frontend model filter for correctness.
