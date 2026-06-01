// Package config 从环境变量加载控制面运行配置（默认值对齐本地 dev 的 PostgreSQL）。
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr             string        // 监听地址，默认 :8081（迁移期与 Java :8080 并存）
	DatabaseURL      string        // pgxpool DSN：postgres://...
	CORSOrigins      []string      // 允许的前端来源
	AgentBaseURL     string        // Go Node Agent 地址（Phase 1 起用）
	AIServiceBaseURL string        // Python AI 服务（Phase 3：diagnose + chat:stream）
	LegacyPyBaseURL  string        // 迁移期 Python 单体（aiops/knowledge 反代目标）
	AIRequestTimeout time.Duration // 调 AI 诊断的超时（含 LLM 推理，默认 90s）
	KubeconfigPath   string        // Phase 5/5B.1：控制面 client-go 的 kubeconfig（空=in-cluster 或默认规则）
	RegistryTTL      time.Duration // Phase 5/5B.2：心跳 TTL（超时未心跳→unreachable）
	RegistrySweep    time.Duration // Phase 5/5B.2：reaper 清扫周期
	ServingScrape    time.Duration // Phase 5/Option A：抓取 vLLM Prometheus 指标的周期
	VLLMMetricsPort  string        // vLLM /metrics 端口（默认 8000）
	CadvisorURL      string        // cAdvisor Prometheus metrics URL
}

func Load() Config {
	return Config{
		Addr:             env("SERVER_ADDR", ":8081"),
		DatabaseURL:      env("DATABASE_URL", "postgres://infra:infra@localhost:5432/infra_platform?sslmode=disable"),
		CORSOrigins:      splitCSV(env("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")),
		AgentBaseURL:     env("AGENT_BASE_URL", "http://127.0.0.1:8090"),
		AIServiceBaseURL: env("AI_SERVICE_BASE_URL", "http://127.0.0.1:8200"),
		LegacyPyBaseURL:  env("LEGACY_PYTHON_BASE_URL", "http://127.0.0.1:8088"),
		AIRequestTimeout: envSeconds("AI_REQUEST_TIMEOUT_SECONDS", 90*time.Second),
		KubeconfigPath:   env("KUBECONFIG", ""),
		RegistryTTL:      envSeconds("REGISTRY_TTL_SECONDS", 30*time.Second),
		RegistrySweep:    envSeconds("REGISTRY_SWEEP_SECONDS", 15*time.Second),
		ServingScrape:    envSeconds("SERVING_SCRAPE_SECONDS", 10*time.Second),
		VLLMMetricsPort:  env("VLLM_METRICS_PORT", "8000"),
		CadvisorURL:      env("CADVISOR_URL", "http://127.0.0.1:18080/metrics"),
	}
}

// envSeconds 读取以秒为单位的时长 env，缺省/非法时取 def。
func envSeconds(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return def
}

// MigrateURL 返回 golang-migrate 用的 URL（pgx5 scheme，由 database/pgx/v5 驱动注册）。
func (c Config) MigrateURL() string {
	if rest, ok := strings.CutPrefix(c.DatabaseURL, "postgres://"); ok {
		return "pgx5://" + rest
	}
	if rest, ok := strings.CutPrefix(c.DatabaseURL, "postgresql://"); ok {
		return "pgx5://" + rest
	}
	return c.DatabaseURL
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
