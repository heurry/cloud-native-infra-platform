# infra-server — Go 控制面后端

云原生平台的 Go 主后端。

## 技术栈（D1–D4 定稿）
- **chi**（路由）+ **pgx/v5**（PostgreSQL）+ **golang-migrate**（迁移）+ **sqlc**（Phase 1 起，SQL-first）
- 默认监听 `:8081`

## 目录
```
server/
├── cmd/server/main.go          # 入口：迁移 → 连库 → 起 HTTP
├── internal/config/            # 环境变量配置
├── internal/db/
│   ├── db.go                   # pgxpool 连接
│   ├── migrate.go              # golang-migrate（embed migrations）
│   ├── migrations/             # 000001~000003（= Flyway V1–V3 等价）
│   ├── query/                  # sqlc 查询（Phase 1）
│   └── sqlcgen/                # sqlc 生成代码（Phase 1）
├── internal/httpx/             # 路由 / 中间件 / 错误信封 / health
├── sqlc.yaml
└── Dockerfile
```

## 环境变量
| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVER_ADDR` | `:8081` | 监听地址 |
| `DATABASE_URL` | `postgres://infra:infra@localhost:5432/infra_platform?sslmode=disable` | pgx DSN |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 前端来源 |
| `AGENT_BASE_URL` | `http://127.0.0.1:8090` | Go Node Agent（Phase 1 起用） |

## 本地运行（需联网首拉依赖）
```bash
# 0) 确保 PostgreSQL 在跑（compose 的 postgres，或本地 16）
# 1) 拉依赖并生成 go.sum（首次需外网）
cd server && go mod tidy
# 2) 跑（自动迁移空库 → 连库 → :8081）
go run ./cmd/server
# 3) 验证
curl -s localhost:8081/api/health
# => {"service":"infra-platform-backend","status":"ok","version":"0.1.0"}
```

## 前端切到 Go 后端
```bash
cd apps/web && VITE_PROXY_TARGET=http://127.0.0.1:8081 npm run dev
```

## 迁移说明
- `migrations/000001~000003` 与 Flyway `V1–V3` **等价**：空库可一键重建 schema + 种子。
- **迁移期约定**（11-计划 §7）：schema 变更只走 golang-migrate，冻结 Flyway，避免双写冲突。
- dev 库已被 Flyway 建过表时，对它跑本服务会因表已存在报错；用**全新库**验收 Phase 0。

## Phase 0 验收（无 Go 工具链时，用 psql 验迁移 SQL）
```bash
createdb -h localhost -U infra infra_migrate_test
for f in internal/db/migrations/00000*_*.up.sql; do
  PGPASSWORD=infra psql -h localhost -U infra -d infra_migrate_test -v ON_ERROR_STOP=1 -f "$f"
done
PGPASSWORD=infra psql -h localhost -U infra -d infra_migrate_test -c "\dt"   # 期望 26 张表
```
