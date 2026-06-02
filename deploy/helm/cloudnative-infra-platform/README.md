# cloudnative-infra-platform (Helm chart)

Phase 5 / 5B.5：把平台打成 Helm chart，go-server 无状态多副本 + 健康探针 + in-cluster RBAC（client-go 直读集群）。

## 组件
- **go-server**：Go 控制面（单一入口），默认 **2 副本**（无状态，状态在 PostgreSQL），readiness/liveness 命中 `/api/health`；in-cluster ServiceAccount + ClusterRole 只读 pods/deployments/events/nodes/hpa（5B.1/5B.3）。
- **ai-service**：结构化诊断 / chat:stream / embed（探针 `/internal/health`）。
- **redis**：横切缓存 / 限流 / 幂等（5B.4a）。**minio**：对象存储（5B.4b）。
- **postgres**：演示自带（生产设 `postgres.enabled=false` + `postgres.external.url`）。
- **agent**：节点 host/gpu 采集 DaemonSet，默认关闭（`agent.enabled=true` 开启）。

## 校验（无需安装 helm 到宿主）
```bash
docker run --rm -v "$PWD":/work -w /work -v twf-gomod:/gomod \
  -e GOMODCACHE=/gomod -e GOWORK=off -e GOPROXY=https://goproxy.cn,direct \
  -e GOSUMDB=off -e GOBIN=/usr/local/bin golang:1.22 \
  bash -c 'go install helm.sh/helm/v3/cmd/helm@v3.16.4 && \
    helm lint deploy/helm/cloudnative-infra-platform && \
    helm template cip deploy/helm/cloudnative-infra-platform'
```

## 部署（minikube，本地镜像）
```bash
# 1) 构建镜像（见各 Dockerfile / docker-compose），并加载进 minikube：
minikube image load cloudnative-infra-platform/go-server:latest
minikube image load cloudnative-infra-platform/python-ai-service:latest
# 2) 安装：
helm install cip deploy/helm/cloudnative-infra-platform -n cip --create-namespace
# 3) 访问：
kubectl -n cip port-forward svc/cloudnative-infra-platform-go-server 8081:8081
curl localhost:8081/api/health
```

## 已知考量
- **多副本下的注册表 reaper**：每个 go-server 副本各跑一份 reaper；`SweepStale` 幂等（`UPDATE ... WHERE stale`），并发安全但冗余。生产可加 leader election 让单副本执行。
- **迁移**：go-server 启动即跑 golang-migrate；多副本并发启动由 migrate 的锁保证只跑一次。
