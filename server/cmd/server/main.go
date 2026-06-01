// Command server 是云原生平台的 Go 控制面后端（迁移自 Java/Spring Boot）。
// Phase 0：连 PostgreSQL、应用迁移、暴露 /api/health。
// Phase 3：接入 Python AI 服务（诊断）+ SSE 反向代理（Copilot 单一入口）+ 优雅关机。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/heurry/cloudnative-infra-platform/server/internal/agentcli"
	"github.com/heurry/cloudnative-infra-platform/server/internal/aiclient"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/httpx"
	"github.com/heurry/cloudnative-infra-platform/server/internal/k8s"
	"github.com/heurry/cloudnative-infra-platform/server/internal/metrics"
	"github.com/heurry/cloudnative-infra-platform/server/internal/serving"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := config.Load()

	// 1) 迁移：空库可重建出与 Flyway 等价的 schema + 种子。
	if err := db.Migrate(cfg.MigrateURL()); err != nil {
		slog.Error("migrate failed", "err", err)
		os.Exit(1)
	}
	slog.Info("migrations applied")

	// 2) 连接池（注入各 handler）。
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	slog.Info("db connected")

	// 3) AI 边界：诊断客户端 + 两个反向代理（不可用时降级为 nil，路由跳过对应接口）。
	aiProxy, err := httpx.NewProxy(cfg.AIServiceBaseURL)
	if err != nil {
		slog.Warn("ai proxy disabled", "err", err)
		aiProxy = nil
	}
	legacyProxy, err := httpx.NewProxy(cfg.LegacyPyBaseURL)
	if err != nil {
		slog.Warn("legacy proxy disabled", "err", err)
		legacyProxy = nil
	}

	// 3.5) Phase 5/5B.1：控制面 client-go 直读集群（kubeconfig 加载失败时降级为 nil，
	// /api/kubernetes/* 返回 disabled，不阻塞启动）。
	k8sCollector, k8sErr := k8s.NewCollector(cfg.KubeconfigPath)
	k8sErrStr := ""
	if k8sErr != nil {
		slog.Warn("kubernetes collector unavailable (degraded)", "err", k8sErr)
		k8sErrStr = k8sErr.Error()
	} else {
		slog.Info("kubernetes collector ready")
	}

	// 3.6) Phase 5/Option A：vLLM Prometheus 指标抓取器（需 k8s collector；否则 nil→serving 指标走旧路径）。
	var servingScraper *serving.Scraper
	if k8sCollector != nil {
		servingScraper = serving.New(k8sCollector, cfg.VLLMMetricsPort)
	}

	// 4) HTTP。
	st := store.New(pool)
	router := httpx.NewRouter(&httpx.API{
		Pool:        pool,
		Agent:       agentcli.New(cfg.AgentBaseURL),
		Metrics:     metrics.NewService(pool),
		Store:       st,
		AI:          aiclient.New(cfg.AIServiceBaseURL, cfg.AIRequestTimeout),
		AIProxy:     aiProxy,
		LegacyProxy: legacyProxy,
		LegacyBase:  cfg.LegacyPyBaseURL,
		K8s:         k8sCollector,
		K8sErr:      k8sErrStr,
		Serving:     servingScraper,
		Cadvisor:    metrics.NewCadvisorCollector(cfg.CadvisorURL),
		CORSOrigins: cfg.CORSOrigins,
	})

	// 4.5) 后台任务（随关机一并停止）：服务注册表 reaper（5B.2）+ vLLM 指标抓取（Option A）。
	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	go runRegistryReaper(bgCtx, st, cfg.RegistrySweep, cfg.RegistryTTL.Seconds())
	if servingScraper != nil {
		go runServingScraper(bgCtx, servingScraper, cfg.ServingScrape)
	}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 5) 后台监听 + 优雅关机：收到 SIGINT/SIGTERM 停止收新连接、放干在途请求。
	go func() {
		slog.Info("server listening", "addr", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutdown signal received")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
	slog.Info("server stopped")
}

// runRegistryReaper 周期清扫：把超 TTL 未心跳的服务实例置 unreachable，并 best-effort 落审计。
// 静态种子实例（last_heartbeat_at 为 NULL）不受影响。
func runRegistryReaper(ctx context.Context, st *store.Store, interval time.Duration, ttlSeconds float64) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			names, err := st.SweepStaleInstances(ctx, ttlSeconds)
			if err != nil {
				slog.Warn("registry reaper sweep failed", "err", err)
				continue
			}
			if len(names) > 0 {
				slog.Info("registry reaper: marked stale instances unreachable", "names", names)
				for _, n := range names {
					st.Audit(ctx, "system", "system", "service.stale", "service_instance", n,
						map[string]any{"reason": "heartbeat_ttl_expired"})
				}
			}
		}
	}
}

// runServingScraper 周期抓取 vLLM Prometheus 指标，聚合成真实 serving 指标（Option A）。
func runServingScraper(ctx context.Context, sc *serving.Scraper, interval time.Duration) {
	if err := sc.ScrapeOnce(ctx); err != nil {
		slog.Warn("serving scrape failed", "err", err)
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := sc.ScrapeOnce(ctx); err != nil {
				slog.Warn("serving scrape failed", "err", err)
			}
		}
	}
}
