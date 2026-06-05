# 测试与工程质量（D4）

平台的测试金字塔：单元 → 集成（真实依赖）→ e2e（全中间件链）→ 负载基线 → 混沌降级。
CI（`.github/workflows/ci.yml`）跑全套；DB 用例在无库时自动 `skip`，由专门的 `integration` job 起真实依赖执行。

## 分层

| 层 | 位置 | 依赖 | CI job |
|---|---|---|---|
| 单元 | `server/internal/**/*_test.go`（纯函数、表驱动） | 无 | `go-server` |
| 进程内混沌 | `server/internal/httpx/chaos_test.go`（Redis 猝死用 miniredis） | 无 | `go-server` |
| 集成 | `*_test.go`（gated `TEST_DATABASE_URL`）：迁移、检索、路由、反馈回流… | PostgreSQL(pgvector) | `integration` |
| e2e | `server/internal/httpx/e2e_test.go`：经 `NewRouter` 全中间件链走关键用户路径 | PG + Redis + MinIO | `integration` |
| 负载基线 | `server/internal/httpx/load_test.go`：进程内并发，零错误 + p95 天花板回归护栏 | PG(+Redis) | `integration` |
| 混沌（真实栈） | `deploy/chaos/run-chaos.sh`：逐个杀依赖验证降级 | compose 栈 | 手动 |
| 负载（真实栈） | `deploy/load/k6-baseline.js`：k6 压控制面只读路径 | compose 栈 | 手动 |

## 本地运行

```bash
# 1) 纯单元 + 进程内混沌（无需依赖）
cd server && go test ./...

# 2) 集成 / e2e / 负载（起真实依赖）
docker run -d --name pg    -e POSTGRES_USER=infra -e POSTGRES_PASSWORD=infra -e POSTGRES_DB=infra_platform -p 5432:5432 pgvector/pgvector:pg16
docker run -d --name redis -p 6379:6379 redis:7-alpine
docker run -d --name minio -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin -p 9000:9000 minio/minio server /data
cd server && \
  TEST_DATABASE_URL='postgres://infra:infra@127.0.0.1:5432/infra_platform?sslmode=disable' \
  TEST_REDIS_URL='redis://127.0.0.1:6379' \
  TEST_S3_ENDPOINT='127.0.0.1:9000' \
  go test ./... -p 1     # -p 1：跨包共享同一测试库，串行避免污染搜索表

# 3) 真实栈混沌 + 负载（先 docker compose up）
BASE_URL=http://localhost:8081 deploy/chaos/run-chaos.sh
BASE_URL=http://localhost:8081 k6 run deploy/load/k6-baseline.js
```

## 降级矩阵（混沌固化）

代码本就「依赖不可达即降级、绝不阻塞启动/请求」；下列由 `chaos_test.go` 固化为回归：

| 依赖故障 | 行为 | 断言 |
|---|---|---|
| Redis 猝死 | cache-aside 穿透到上游 | 接口仍 200，handler 重新执行 |
| Redis 猝死 | 令牌桶限流 fail-open | 放行，不 429/5xx |
| Redis 猝死 | 幂等存储失效 | 退化为重新执行，不 5xx |
| MinIO 不可用 | 对象层降级 | `storage/tiers` 200，对象层标记未启用；产物接口 503（非 panic） |
| AI 服务不可达 | 评测/诊断优雅失败 | `502 ai_unavailable`（非 500/panic）；chat 走兜底话术 |

## 负载基线（参考，进程内）

`TestLoadBaseline` 600 请求 / 并发 24 命中 `/api/health`、`/api/service-instances`、`/api/platform/overview`：
零非 200，p95 在毫秒级（护栏上限 2s，抓病态回归而非机器抖动）。真实吞吐随机器变化，绝对数字以 k6 真实栈结果为准。
