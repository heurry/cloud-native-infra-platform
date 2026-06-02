package httpx

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// 6A：进程内 serving 压测 runner（取代 legacy 起 Python 子进程跑 11_benchmark_serving.py）。
// 对解析出的端点做并发负载扫描（concurrency_levels × requests_per_level），流式请求测 TTFT，
// 由响应 usage 取 token；逐请求落 `request` 事件、逐档落 `scenario_summary`，汇总写 MinIO 报告。
// 无 live 模型时如实落 error 事件 + failed（与 legacy 行为一致）。

// workloadPrompts 把 workload 名映射到提示词（覆盖 legacy 的 prompt_profile 常用档）。
var workloadPrompts = map[string]string{
	"faq_short":   "What is the refund policy for a defective product?",
	"faq_long":    "Explain in detail the full warranty, refund, and return process for an order that arrived damaged, including timelines and required documents.",
	"mixed_peak":  "Summarize the order cancellation policy and how refunds are issued.",
	"chitchat":    "Hi, can you help me with my recent order?",
}

func workloadPrompt(workload string) string {
	if p, ok := workloadPrompts[workload]; ok {
		return p
	}
	return "What is the refund policy?"
}

// runServingBenchmark 是后台压测主流程（脱离请求 context）。
func (a *API) runServingBenchmark(runID string, ep *resolvedEndpoint, req benchmarkRunRequest) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("benchmark runner panic", "run_id", runID, "err", rec)
			a.failBenchmark(runID, fmt.Sprintf("panic: %v", rec))
		}
	}()
	ctx := context.Background()
	a.appendBenchmarkEvent(ctx, runID, "started",
		map[string]any{"endpoint": ep.TargetPod, "base_url": ep.BaseURL, "workload": req.Workload})
	_, _ = a.Pool.Exec(ctx, `UPDATE benchmark_runs SET status='running', updated_at=now() WHERE run_id=$1`, runID)

	prompt := workloadPrompt(req.Workload)
	scenarios := make([]map[string]any, 0, len(req.ConcurrencyLevels))
	for _, c := range req.ConcurrencyLevels {
		if c <= 0 {
			continue
		}
		scenarios = append(scenarios, a.runScenario(ctx, runID, ep, prompt, req.MaxTokens, c, req.RequestsPerLevel))
	}

	summary := map[string]any{"scenarios": scenarios}
	reportPath := a.uploadBenchmarkReport(ctx, runID, ep, req, summary)

	sb, _ := json.Marshal(summary)
	_, _ = a.Pool.Exec(ctx,
		`UPDATE benchmark_runs SET status='completed', summary=$2, report_path=$3, updated_at=now() WHERE run_id=$1`,
		runID, sb, nullableStr(reportPath))
	a.appendBenchmarkEvent(ctx, runID, "process_exit", map[string]any{"status": "completed", "scenarios": len(scenarios)})
}

// runScenario 跑一个并发档，落逐请求事件 + 一条 scenario_summary，返回该档汇总。
func (a *API) runScenario(ctx context.Context, runID string, ep *resolvedEndpoint, prompt string, maxTokens, concurrency, total int) map[string]any {
	a.appendBenchmarkEvent(ctx, runID, "scenario_start",
		map[string]any{"concurrency": concurrency, "requests": total})

	var (
		mu        sync.Mutex
		latencies []float64
		ttfts     []float64
		errCount  int
		outTokSum float64
		sem       = make(chan struct{}, concurrency)
		wg        sync.WaitGroup
	)
	start := time.Now()
	for i := 0; i < total; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			res := a.runOneRequest(ctx, ep, prompt, maxTokens)
			mu.Lock()
			if res.err != "" {
				errCount++
			} else {
				latencies = append(latencies, res.totalMs)
				if res.ttftMs > 0 {
					ttfts = append(ttfts, res.ttftMs)
				}
				outTokSum += res.outputTokens
			}
			mu.Unlock()
			payload := map[string]any{
				"request_id": res.requestID, "total_ms": res.totalMs, "ttft_ms": nilIfZero(res.ttftMs),
				"input_tokens": res.inputTokens, "output_tokens": res.outputTokens, "target_pod": ep.TargetPod,
			}
			if res.err != "" {
				payload["error"] = res.err
			}
			a.appendBenchmarkEvent(ctx, runID, "request", payload)
		}()
	}
	wg.Wait()
	wallSec := time.Since(start).Seconds()

	summary := map[string]any{
		"concurrency":              concurrency,
		"requests":                 total,
		"errors":                   errCount,
		"error_rate":               ratio(errCount, total),
		"p50_ms":                   pctile(latencies, 50),
		"p95_ms":                   pctile(latencies, 95),
		"p99_ms":                   pctile(latencies, 99),
		"mean_ms":                  mean(latencies),
		"p95_ttft_ms":              pctile(ttfts, 95),
		"qps":                      rate(len(latencies), wallSec),
		"output_tokens_per_second": rate(int(outTokSum), wallSec),
		"total_output_tokens":      outTokSum,
	}
	a.appendBenchmarkEvent(ctx, runID, "scenario_summary", map[string]any{"concurrency": concurrency, "summary": summary})
	return summary
}

type reqResult struct {
	requestID    string
	totalMs      float64
	ttftMs       float64
	inputTokens  float64
	outputTokens float64
	err          string
}

// runOneRequest 发一条流式 chat completion，测 TTFT/总时延，由 usage 取 token。
func (a *API) runOneRequest(ctx context.Context, ep *resolvedEndpoint, prompt string, maxTokens int) reqResult {
	res := reqResult{requestID: uuid.NewString()}
	body, _ := json.Marshal(map[string]any{
		"model":          ep.ModelID,
		"messages":       []map[string]string{{"role": "user", "content": prompt}},
		"max_tokens":     maxTokens,
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	})
	rctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, normalizeBaseURL(ep.BaseURL)+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		res.err = err.Error()
		return res
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer EMPTY")
	req.Header.Set("model", ep.ModelID)
	if ep.RoutingStrategy != "" {
		req.Header.Set("routing-strategy", ep.RoutingStrategy)
	}
	start := time.Now()
	resp, err := proxyHTTPClient.Do(req)
	if err != nil {
		res.err = err.Error()
		return res
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		res.err = fmt.Sprintf("upstream status %d", resp.StatusCode)
		return res
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	deltas := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var ev struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     float64 `json:"prompt_tokens"`
				CompletionTokens float64 `json:"completion_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			continue
		}
		if len(ev.Choices) > 0 && ev.Choices[0].Delta.Content != "" {
			if res.ttftMs == 0 {
				res.ttftMs = float64(time.Since(start).Milliseconds())
			}
			deltas++
		}
		if ev.Usage != nil {
			res.inputTokens = ev.Usage.PromptTokens
			res.outputTokens = ev.Usage.CompletionTokens
		}
	}
	res.totalMs = float64(time.Since(start).Milliseconds())
	if res.outputTokens == 0 {
		res.outputTokens = float64(deltas) // usage 缺失时以 delta 数近似
	}
	if err := sc.Err(); err != nil {
		res.err = err.Error()
	}
	return res
}

// uploadBenchmarkReport 把汇总写 MinIO（benchmarks/{run_id}/report.json），返回对象 key；Blob 禁用→""。
func (a *API) uploadBenchmarkReport(ctx context.Context, runID string, ep *resolvedEndpoint, req benchmarkRunRequest, summary map[string]any) string {
	if a.Blob == nil || !a.Blob.Enabled() {
		return ""
	}
	report := map[string]any{
		"run_id": runID, "endpoint": ep.TargetPod, "workload": req.Workload,
		"routing_strategy": req.RoutingStrategy, "generated_at": time.Now().UTC().Format(time.RFC3339),
		"summary": summary,
	}
	b, _ := json.MarshalIndent(report, "", "  ")
	key := "benchmarks/" + runID + "/report.json"
	uri, err := a.Blob.Put(ctx, key, bytes.NewReader(b), int64(len(b)), "application/json")
	if err != nil {
		slog.Warn("benchmark report upload failed", "run_id", runID, "err", err)
		return ""
	}
	return uri
}

func (a *API) failBenchmark(runID, errMsg string) {
	ctx := context.Background()
	a.appendBenchmarkEvent(ctx, runID, "error", map[string]any{"error": errMsg})
	_, _ = a.Pool.Exec(ctx, `UPDATE benchmark_runs SET status='failed', error=$2, updated_at=now() WHERE run_id=$1`, runID, errMsg)
}

// ---- 小工具 ----

func pctile(v []float64, p float64) any {
	if len(v) == 0 {
		return nil
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	if len(s) == 1 {
		return s[0]
	}
	rank := (p / 100.0) * float64(len(s)-1)
	lo := int(math.Floor(rank))
	hi := int(math.Ceil(rank))
	if lo == hi {
		return s[lo]
	}
	return s[lo] + (s[hi]-s[lo])*(rank-float64(lo))
}

func mean(v []float64) any {
	if len(v) == 0 {
		return nil
	}
	sum := 0.0
	for _, x := range v {
		sum += x
	}
	return sum / float64(len(v))
}

func ratio(n, d int) any {
	if d == 0 {
		return nil
	}
	return float64(n) / float64(d)
}

func rate(n int, sec float64) any {
	if sec <= 0 {
		return nil
	}
	return float64(n) / sec
}

func nilIfZero(v float64) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
