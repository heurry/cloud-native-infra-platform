// Package httpx 组装 chi 路由、中间件、统一错误信封与各 handler。
package httpx

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
)

// legacyProxyPrefixes 是 Python 单体仍拥有、需经 Go 反向代理透传的 /api 前缀。
// 维护规则：当某前缀的端点迁到 Go 原生实现（或迁入新 AI 服务）后，从本表移除。
var legacyProxyPrefixes = []string{
	// 6A 全部完成 → 列表为空，Go 控制面不再反代 Python 单体（6B 将删除 legacy-python）：
	//   models / proxy / benchmarks / knowledge / evals(#52) / chat(#53) 已 Go 原生绞杀；
	//   aiops(#54) 已退役（遗留子应用，前端不消费，由 /api/ai/* + /api/chat + /api/benchmarks 取代，走 404）。
}

// NewRouter 构建带中间件链与 /api 路由组的 chi 路由器。
func NewRouter(a *API) *chi.Mux {
	r := chi.NewRouter()

	r.Use(RequestID)
	r.Use(Logger)
	r.Use(Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   a.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Route("/api", func(r chi.Router) {
		// 5B.4a：Redis 横切中间件（各自在 Redis 降级时透明直通）。
		// 限流按 IP 令牌桶；幂等仅对带 Idempotency-Key 的 POST 生效。
		r.Use(a.RateLimit())
		r.Use(a.Idempotency())

		r.Get("/health", Health)

		// Phase 1：只读 + 可观测（接口/外形复刻现有 Java 控制面）
		r.Get("/service-instances", a.serviceInstances)
		// 5B.4a：overview 走 cache-aside（短 TTL；服务实例写操作显式失效）。
		r.Get("/platform/overview", a.cached(cacheKeyOverview, a.CacheTTL, a.overview))

		// 5B.1：控制面 client-go 直读集群级 k8s（取代经 Agent 透传）；新增 events/nodes。
		r.Route("/kubernetes", func(r chi.Router) {
			r.Get("/pods", a.k8sNative(true, false, false, false, false))
			r.Get("/deployments", a.k8sNative(false, true, false, false, false))
			r.Get("/events", a.k8sNative(false, false, true, false, false))
			r.Get("/nodes", a.k8sNative(false, false, false, true, false))
			r.Get("/hpa", a.k8sNative(false, false, false, false, true)) // 5B.3
			// 5B.4a：整集群快照走 cache-aside（命中真实 minikube，开销大；10s TTL）。
			r.Get("/snapshot", a.cached(cacheKeyK8sSnapshot, 10*time.Second, a.k8sNative(true, true, true, true, true)))
		})

		r.Route("/metrics", func(r chi.Router) {
			r.Get("/current", a.metricsCurrent)
			r.Get("/history", a.metricsHistory)
			r.Get("/requests", a.metricsRequests)
		})

		// 5A.3：基于当前指标快照的规则化告警评估（取代前端告警表 mock）。
		r.Get("/alerts", a.alerts)

		// Phase 2：写操作 + 平台治理（外形复刻现有 Java 控制面）
		r.Post("/service-instances/{name}/healthcheck", a.serviceInstanceHealthcheck)
		// Phase 5 / 5B.2：服务注册表（注册 / 心跳 / 注销）；后台 reaper 据 TTL 清扫。
		r.Post("/service-instances/register", a.registerServiceInstance)
		r.Post("/service-instances/{name}/heartbeat", a.heartbeatServiceInstance)
		r.Delete("/service-instances/{name}", a.deregisterServiceInstance)

		r.Route("/config", func(r chi.Router) {
			r.Get("/items", a.configItems)
			r.Post("/items", a.createConfigItem)
			r.Get("/items/{id}/versions", a.configVersions)
			r.Post("/items/{id}/versions", a.publishConfigVersion)
			r.Post("/items/{id}/rollback", a.rollbackConfigVersion)
		})

		// deployments/incidents 用无尾斜杠形式（对齐 Java @RequestMapping("/api/deployments")）。
		r.Get("/deployments", a.deployments)
		r.Post("/deployments", a.triggerDeployment)
		r.Post("/deployments/{id}/finish", a.finishDeployment)
		r.Post("/deployments/{id}/rollback", a.rollbackDeployment)

		r.Get("/incidents", a.incidents)
		r.Post("/incidents", a.createIncident)
		r.Get("/incidents/{id}", a.incidentDetail)
		r.Post("/incidents/{id}/ack", a.ackIncident)
		r.Post("/incidents/{id}/resolve", a.resolveIncident)

		r.Get("/audit/events", a.auditEvents)

		// 6A：models / proxy / benchmarks 组 Go 原生（取代 legacy 反代）。
		r.Get("/models", a.models)
		r.Post("/proxy/{endpoint_id}/v1/chat/completions", a.proxyChatCompletions)
		r.Post("/benchmarks/serving", a.createServingBenchmark)
		r.Get("/benchmarks/{run_id}", a.benchmarkRun)
		r.Get("/benchmarks/{run_id}/events", a.benchmarkEvents)

		// 6A：evals 组 Go 原生（检索召回评测；依赖 knowledge 检索）。
		r.Post("/evals/customer-support", a.createCustomerSupportEval)
		r.Get("/evals/{run_id}", a.evalRun)

		// 6A：chat 组 Go 原生（客服 RAG 对话；会话/消息→PG，messages:stream 流式 RAG）。
		r.Route("/chat", func(r chi.Router) {
			r.Post("/sessions", a.createChatSession)
			r.Get("/sessions", a.listChatSessions)
			r.Get("/sessions/{session_id}", a.getChatSession)
			r.Post("/sessions/{session_id}/messages:stream", a.streamChatMessage)
			r.Post("/messages/{message_id}/feedback", a.createMessageFeedback)
		})

		// 6A：knowledge 组 Go 原生（pgvector RAG；语料=基准测试日志，方案 A）。
		r.Route("/knowledge", func(r chi.Router) {
			r.Get("/versions", a.knowledgeVersions)
			r.Post("/versions", a.createKnowledgeVersion)
			r.Get("/documents", a.knowledgeDocuments)
			r.Post("/documents", a.createKnowledgeDocument)
			r.Post("/rebuild-index", a.rebuildKnowledgeIndex)
			r.Get("/search", a.knowledgeSearch)
		})

		// Phase 3：AI 边界（Go 取证 → Python 推理 → Go 落库+审计）。
		r.Route("/ai", func(r chi.Router) {
			r.Post("/diagnose", a.diagnose)
			r.Get("/diagnoses", a.listDiagnoses)
			r.Get("/diagnoses/{id}", a.getDiagnosis)
			// SSE 流式问答经 Go 透传到 AI 服务，让 Copilot 走单一入口。
			if a.AIProxy != nil {
				r.Post("/chat:stream", a.AIProxy.To("/internal/chat:stream"))
			}
		})

		// Phase 4：Go 成为单一入口。Python 单体仍拥有的 AI/服务面端点（aiops/knowledge/
		// benchmarks/proxy/chat/evals/models）经 Go 同路径反向代理透传，前端只对接 Go。
		// 注意：Go 已原生拥有的 ops 端点（metrics/service-instances/health 等）不在此列，
		// 它们由上面的原生路由处理，优先级高于代理。
		if a.LegacyProxy != nil {
			for _, prefix := range legacyProxyPrefixes {
				r.HandleFunc("/"+prefix, a.LegacyProxy.Pass())   // 精确（如 GET /api/benchmarks）
				r.HandleFunc("/"+prefix+"/*", a.LegacyProxy.Pass()) // 子路径（如 /api/proxy/auto-router/v1）
			}
		}
	})

	// 404 / 405 也走统一错误信封（对齐前端 ApiError 解析）。
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		WriteError(w, req, http.StatusNotFound, "not_found", "resource not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, req *http.Request) {
		WriteError(w, req, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	})

	return r
}
