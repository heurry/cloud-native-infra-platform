// Package serving 抓取集群内 vLLM 各副本的 Prometheus 指标，聚合成平台的 serving 指标
// （QPS / P50·P95·P99 延迟 / TTFT / tokens·吞吐 / 错误率），覆盖到 /api/metrics/current。
//
// 这让 serving 指标来自**真实推理负载**（取代空的 request_traces 聚合，Phase 5 Option A）。
// 抓取经 kube-apiserver 的 pod proxy（见 k8s.Collector.ProxyGetPodMetrics），无需直连 Pod 网络。
package serving

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/heurry/cloudnative-infra-platform/server/internal/k8s"
)

type Scraper struct {
	collector *k8s.Collector
	port      string

	mu     sync.RWMutex
	latest map[string]any
	prev   *rateState
}

type rateState struct {
	ts        time.Time
	reqCount  float64
	genTokens float64
}

func New(collector *k8s.Collector, port string) *Scraper {
	if port == "" {
		port = "8000"
	}
	return &Scraper{collector: collector, port: port}
}

// Snapshot 返回最近一次聚合的 serving 指标（无则 nil）。
func (s *Scraper) Snapshot() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.latest
}

// ScrapeOnce 抓取所有运行中的 vLLM Pod 并聚合；逐 Pod best-effort（单 Pod 失败不影响整体）。
func (s *Scraper) ScrapeOnce(ctx context.Context) error {
	pods, err := s.collector.Pods(ctx)
	if err != nil {
		return err
	}
	a := newAgg()
	scraped := 0
	for _, p := range pods {
		if p.Component != "vllm" || p.Phase != "Running" {
			continue
		}
		raw, err := s.collector.ProxyGetPodMetrics(ctx, p.Namespace, p.Name, s.port)
		if err != nil {
			continue
		}
		a.add(parsePod(p.Name, string(raw)))
		scraped++
	}
	if scraped == 0 {
		return nil // 无可抓取的 vLLM Pod：保持上次快照、不覆盖为 0
	}
	metrics := s.compute(a)
	s.mu.Lock()
	s.latest = metrics
	s.mu.Unlock()
	return nil
}

// ---- 聚合 ----

type podAgg struct {
	name                  string
	e2eBuckets            map[float64]float64
	e2eSum, e2eCount      float64
	ttftBuckets           map[float64]float64
	ttftSum, ttftCount    float64
	genTokens, promptToks float64
	success, errors       float64
	running, waiting      float64
}

type aggregate struct {
	pods                  []podAgg
	e2eBuckets            map[float64]float64
	e2eSum, e2eCount      float64
	ttftBuckets           map[float64]float64
	ttftSum, ttftCount    float64
	genTokens, promptToks float64
	success, errors       float64
	running, waiting      float64
}

func newAgg() *aggregate {
	return &aggregate{e2eBuckets: map[float64]float64{}, ttftBuckets: map[float64]float64{}}
}

func (a *aggregate) add(p podAgg) {
	a.pods = append(a.pods, p)
	for le, c := range p.e2eBuckets {
		a.e2eBuckets[le] += c
	}
	for le, c := range p.ttftBuckets {
		a.ttftBuckets[le] += c
	}
	a.e2eSum += p.e2eSum
	a.e2eCount += p.e2eCount
	a.ttftSum += p.ttftSum
	a.ttftCount += p.ttftCount
	a.genTokens += p.genTokens
	a.promptToks += p.promptToks
	a.success += p.success
	a.errors += p.errors
	a.running += p.running
	a.waiting += p.waiting
}

// compute 把聚合结果转成前端 Metrics 契约字段。
func (s *Scraper) compute(a *aggregate) map[string]any {
	now := time.Now()
	reqCount := a.e2eCount
	errorRate := 0.0
	if reqCount > 0 {
		errorRate = a.errors / reqCount
	}

	// 速率（窗口）：用上次抓取的累计值求 Δ/Δt。首次抓取无速率。
	qps, tps := 0.0, 0.0
	if s.prev != nil {
		dt := now.Sub(s.prev.ts).Seconds()
		if dt > 0 {
			if d := reqCount - s.prev.reqCount; d > 0 {
				qps = d / dt
			}
			if d := a.genTokens - s.prev.genTokens; d > 0 {
				tps = d / dt
			}
		}
	}
	s.prev = &rateState{ts: now, reqCount: reqCount, genTokens: a.genTokens}

	podStats := make([]map[string]any, 0, len(a.pods))
	for _, p := range a.pods {
		pErr := 0.0
		if p.e2eCount > 0 {
			pErr = p.errors / p.e2eCount
		}
		podStats = append(podStats, map[string]any{
			"name":            p.name,
			"request_count":   int(p.e2eCount),
			"error_count":     int(p.errors),
			"error_rate":      pErr,
			"mean_latency_ms": meanMs(p.e2eSum, p.e2eCount),
			"p95_latency_ms":  quantileMs(0.95, p.e2eBuckets, p.e2eCount),
			"mean_ttft_ms":    meanMs(p.ttftSum, p.ttftCount),
			"p95_ttft_ms":     quantileMs(0.95, p.ttftBuckets, p.ttftCount),
			"output_tokens":   int(p.genTokens),
		})
	}
	sort.Slice(podStats, func(i, j int) bool {
		return podStats[i]["name"].(string) < podStats[j]["name"].(string)
	})

	return map[string]any{
		"source":              "vllm_prometheus",
		"request_count":       int(reqCount),
		"error_count":         int(a.errors),
		"error_rate":          errorRate,
		"qps":                 qps,
		"mean_latency_ms":     meanMs(a.e2eSum, a.e2eCount),
		"p50_latency_ms":      quantileMs(0.50, a.e2eBuckets, a.e2eCount),
		"p95_latency_ms":      quantileMs(0.95, a.e2eBuckets, a.e2eCount),
		"p99_latency_ms":      quantileMs(0.99, a.e2eBuckets, a.e2eCount),
		"mean_ttft_ms":        meanMs(a.ttftSum, a.ttftCount),
		"p50_ttft_ms":         quantileMs(0.50, a.ttftBuckets, a.ttftCount),
		"p95_ttft_ms":         quantileMs(0.95, a.ttftBuckets, a.ttftCount),
		"p99_ttft_ms":         quantileMs(0.99, a.ttftBuckets, a.ttftCount),
		"input_tokens":        int(a.promptToks),
		"output_tokens":       int(a.genTokens),
		"total_tokens":        int(a.promptToks + a.genTokens),
		"tokens_per_second":   tps,
		"num_requests_running": int(a.running),
		"num_requests_waiting": int(a.waiting),
		"target_pod_stats":    podStats,
		"endpoint_stats":      podStats,
	}
}

func meanMs(sum, count float64) any {
	if count <= 0 {
		return nil
	}
	return (sum / count) * 1000.0
}

func quantileMs(q float64, buckets map[float64]float64, total float64) any {
	if total <= 0 || len(buckets) == 0 {
		return nil
	}
	return histogramQuantile(q, buckets, total) * 1000.0
}

// histogramQuantile 复刻 Prometheus 直方图分位（桶内线性插值）。buckets 为累计计数 by le。
func histogramQuantile(q float64, buckets map[float64]float64, total float64) float64 {
	les := make([]float64, 0, len(buckets))
	for le := range buckets {
		les = append(les, le)
	}
	sort.Float64s(les)
	rank := q * total
	prevLe, prevCount := 0.0, 0.0
	for _, le := range les {
		cum := buckets[le]
		if cum >= rank {
			if math.IsInf(le, 1) {
				return prevLe // 落在 +Inf 桶：返回最后有限 le（保守）
			}
			if cum == prevCount {
				return le
			}
			frac := (rank - prevCount) / (cum - prevCount)
			return prevLe + frac*(le-prevLe)
		}
		if !math.IsInf(le, 1) {
			prevLe = le
		}
		prevCount = cum
	}
	return prevLe
}

// ---- Prometheus 文本解析（仅取所需 vLLM series） ----

func parsePod(name, text string) podAgg {
	p := podAgg{name: name, e2eBuckets: map[float64]float64{}, ttftBuckets: map[float64]float64{}}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		sp := strings.LastIndexByte(line, ' ')
		if sp <= 0 {
			continue
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(line[sp+1:]), 64)
		if err != nil {
			continue
		}
		metric, labels := splitNameLabels(line[:sp])
		switch metric {
		case "vllm:e2e_request_latency_seconds_bucket":
			p.e2eBuckets[parseLe(labels)] += val
		case "vllm:e2e_request_latency_seconds_sum":
			p.e2eSum += val
		case "vllm:e2e_request_latency_seconds_count":
			p.e2eCount += val
		case "vllm:time_to_first_token_seconds_bucket":
			p.ttftBuckets[parseLe(labels)] += val
		case "vllm:time_to_first_token_seconds_sum":
			p.ttftSum += val
		case "vllm:time_to_first_token_seconds_count":
			p.ttftCount += val
		case "vllm:generation_tokens_total":
			p.genTokens += val
		case "vllm:prompt_tokens_total":
			p.promptToks += val
		case "vllm:request_success_total":
			p.success += val
			if r := labelVal(labels, "finished_reason"); r == "error" || r == "abort" {
				p.errors += val
			}
		case "vllm:num_requests_running":
			p.running += val
		case "vllm:num_requests_waiting":
			p.waiting += val
		}
	}
	return p
}

func splitNameLabels(s string) (name, labels string) {
	if i := strings.IndexByte(s, '{'); i >= 0 {
		return s[:i], s[i:]
	}
	return s, ""
}

func parseLe(labels string) float64 {
	v := labelVal(labels, "le")
	if v == "+Inf" || v == "Inf" {
		return math.Inf(1)
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return math.Inf(1)
	}
	return f
}

func labelVal(labels, key string) string {
	marker := key + `="`
	i := strings.Index(labels, marker)
	if i < 0 {
		return ""
	}
	rest := labels[i+len(marker):]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		return ""
	}
	return rest[:j]
}
