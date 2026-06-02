package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// isNoRows 判定 pgx QueryRow 无行。
func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// 6A：benchmarks 组绞杀——Go 原生 serving 压测（复刻 legacy src/api + src/jobs/benchmark.py 契约）。
// 复用既有 PG benchmark_runs / benchmark_samples（000001，是 SQLite 的超集）；
// 压测执行从「Go 起 Python 子进程跑 11_benchmark_serving.py」改为「Go 进程内并发负载」
// （见 benchmark_runner.go），复用 6A proxy 的端点解析与 5B.4b 的 MinIO 报告。
// 历史 25 行 SQLite 旧 run 不迁（前端只轮询新建 run_id；批量回填留待 6B）。

// benchmarkRunRequest 对齐 customer_support.schemas.BenchmarkRunRequest。
type benchmarkRunRequest struct {
	EndpointID        string `json:"endpoint_id"`
	Workload          string `json:"workload"`
	RoutingStrategy   string `json:"routing_strategy"`
	ConcurrencyLevels []int  `json:"concurrency_levels"`
	RequestsPerLevel  int    `json:"requests_per_level"`
	MaxTokens         int    `json:"max_tokens"`
}

func (r *benchmarkRunRequest) applyDefaults() {
	if r.EndpointID == "" {
		r.EndpointID = "aibrix-gateway"
	}
	if r.Workload == "" {
		r.Workload = "faq_short"
	}
	if r.RoutingStrategy == "" {
		r.RoutingStrategy = "least-request"
	}
	if len(r.ConcurrencyLevels) == 0 {
		r.ConcurrencyLevels = []int{1, 2, 4, 8, 16}
	}
	if r.RequestsPerLevel <= 0 {
		r.RequestsPerLevel = 16
	}
	if r.MaxTokens <= 0 {
		r.MaxTokens = 256
	}
}

// POST /api/benchmarks/serving：建 run（queued）→ 解析端点 → 后台跑负载 → 返回 {run_id,status}。
func (a *API) createServingBenchmark(w http.ResponseWriter, r *http.Request) {
	var req benchmarkRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.badRequest(w, r, "invalid JSON body")
		return
	}
	req.applyDefaults()

	ep, status, err := a.resolveEndpoint(r.Context(), req.EndpointID)
	if err != nil {
		WriteError(w, r, status, errCodeForStatus(status), err.Error())
		return
	}

	runID := uuid.NewString()
	cfg, _ := json.Marshal(req)
	if _, err := a.Pool.Exec(r.Context(), `
		INSERT INTO benchmark_runs (run_id, status, endpoint_id, workload, routing_strategy, config)
		VALUES ($1, 'queued', $2, $3, $4, $5)`,
		runID, req.EndpointID, req.Workload, req.RoutingStrategy, cfg); err != nil {
		a.fail(w, r, err)
		return
	}
	a.appendBenchmarkEvent(r.Context(), runID, "queued",
		map[string]any{"endpoint_id": req.EndpointID, "workload": req.Workload})

	// 后台跑（脱离请求 context，随进程存活）。
	go a.runServingBenchmark(runID, ep, req)

	WriteJSON(w, http.StatusOK, map[string]any{"run_id": runID, "status": "queued"})
}

// GET /api/benchmarks/{run_id}（复刻：返回行 + config/summary 解析为对象）。
func (a *API) benchmarkRun(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "run_id")
	var status string
	var endpointID, workload, routingStrategy, reportPath, errText *string
	var config, summary []byte
	var createdAt, updatedAt time.Time
	err := a.Pool.QueryRow(r.Context(), `
		SELECT status, endpoint_id, workload, routing_strategy, config, summary, report_path, error, created_at, updated_at
		  FROM benchmark_runs WHERE run_id = $1`, runID).
		Scan(&status, &endpointID, &workload, &routingStrategy, &config, &summary, &reportPath, &errText, &createdAt, &updatedAt)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "benchmark run not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "status": status,
		"endpoint_id": endpointID, "workload": workload, "routing_strategy": routingStrategy,
		"config": jsonbObject(config), "summary": jsonbObject(summary),
		"report_path": reportPath, "error": errText,
		"created_at": createdAt.UTC().Format(time.RFC3339Nano),
		"updated_at": updatedAt.UTC().Format(time.RFC3339Nano),
	})
}

// GET /api/benchmarks/{run_id}/events（复刻：benchmark_samples 按序，payload 解析为对象）。
func (a *API) benchmarkEvents(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "run_id")
	rows, err := a.Pool.Query(r.Context(), `
		SELECT event_type, payload, created_at FROM benchmark_samples
		 WHERE run_id = $1 ORDER BY id ASC`, runID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer rows.Close()
	events := []map[string]any{}
	for rows.Next() {
		var eventType *string
		var payload []byte
		var createdAt time.Time
		if err := rows.Scan(&eventType, &payload, &createdAt); err != nil {
			a.fail(w, r, err)
			return
		}
		events = append(events, map[string]any{
			"event_type": eventType, "payload": jsonbObject(payload),
			"created_at": createdAt.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"run_id": runID, "events": events})
}

// appendBenchmarkEvent best-effort 落一条 benchmark_samples 事件。
func (a *API) appendBenchmarkEvent(ctx context.Context, runID, eventType string, payload map[string]any) {
	b, err := json.Marshal(payload)
	if err != nil {
		b = []byte("{}")
	}
	_, _ = a.Pool.Exec(ctx,
		`INSERT INTO benchmark_samples (run_id, event_type, payload) VALUES ($1, $2, $3)`,
		runID, eventType, b)
}
