# Contributing Guide

Thanks for your interest in **CloudNative Infra Platform**! This document explains
how to set up the project, the conventions we follow, and how to get a change
merged. 中文说明见每节下方 `> 中文` 注记。

> **Project status:** this is a demo / portfolio-grade platform. It runs end to
> end, but some flows depend on a local minikube / GPU / vLLM setup. Expect to
> stub or skip those when contributing on a plain machine.

## Repository layout

```text
apps/web/          React/Vite console
server/            Go control-plane API (:8081)
agent/             Go node / Kubernetes collector (:8090)
apps/ai-service/   Python AI diagnosis & Copilot service (:8200)
src/               legacy Python facade (knowledge base, benchmark, demo APIs)
configs/           app + serving configuration
deploy/            docker-compose, AIBrix, observability, Helm
docs/              design notes, deployment guides, screenshots
```

## Prerequisites

- Go **1.22+**
- Node.js **20+** and npm
- Python **3.11+**
- Docker / Docker Compose
- (optional) minikube, NVIDIA container runtime, AIBrix + vLLM for the full stack

## Local development

```bash
# Backend control plane + Postgres + AI service + agent
docker compose -f deploy/compose/docker-compose.yml up -d --build

# Frontend
cd apps/web && npm install && npm run dev   # http://127.0.0.1:5173
```

> 中文：用 compose 起后端，`apps/web` 起前端。完整本地栈（minikube/GPU）见
> `scripts/run_aibrix_4b_stack.sh`。

## Building & testing

Run the checks for whatever you touched. CI (`.github/workflows/ci.yml`) runs all
of these on every push and pull request, so a green local run means a green CI.

| Area | Command |
| --- | --- |
| Go control plane | `cd server && go build ./... && go vet ./... && go test ./...` |
| Go agent | `cd agent && go build ./... && go vet ./...` |
| Frontend | `cd apps/web && npm ci && npm run build` |
| AI service | `cd apps/ai-service && pip install -r requirements.txt && pytest -q` |
| Legacy Python | `pip install -r requirements.txt && pytest tests/ -q` |
| SQL codegen | `cd server && sqlc generate` (must produce no diff) |

## Coding conventions

- **Go:** format with `gofmt`/`goimports`; keep `go vet` clean. Database access
  stays layered (`sqlc` → `store` → handlers); do not bypass the store layer.
- **TypeScript/React:** follow the existing ESLint/Tailwind setup; no new mock or
  sample ("示例") data in the UI — every panel must come from a real endpoint.
- **Python:** type hints where practical; keep services importable for tests.
- Editor settings are pinned in [`.editorconfig`](.editorconfig).

## Commit & PR workflow

1. Fork and create a topic branch off `main` (e.g. `feat/<short-name>`).
2. Keep commits focused; write clear messages. We loosely follow
   [Conventional Commits](https://www.conventionalcommits.org/) prefixes
   (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
3. Ensure the relevant checks above pass and update docs/screenshots if behavior
   or UI changed.
4. Open a pull request against `main`, fill in the PR template, and link any
   related issue.

## Reporting bugs & requesting features

Use the issue templates under **New issue**. For anything security-related, do
**not** open a public issue — follow [SECURITY.md](SECURITY.md) instead.

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).
