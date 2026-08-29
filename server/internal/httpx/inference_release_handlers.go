package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

const (
	inferenceReleaseModelID      = "qwen36-27b-fp8"
	inferenceReleaseEndpoint     = "qwen36-27b-fp8-vllm"
	inferenceReleaseName         = "qwen36-27b-fp8-production"
	inferenceReleaseTimeout      = 10 * time.Minute
	inferenceReleaseMaxP95TTFTMs = 5000.0
	inferenceReleaseMaxP95TPOTMs = 150.0
)

type inferenceReleaseProfile struct {
	Key              string
	Label            string
	Description      string
	MaxNumSeqs       int
	MaxBatchedTokens int
	PrefixCaching    bool
	RuntimeRequest   map[string]any
}

func inferenceReleaseProfiles() []inferenceReleaseProfile {
	return []inferenceReleaseProfile{
		{
			Key: "balanced", Label: "均衡档", Description: "优先控制 TPOT，适合默认客服流量。",
			MaxNumSeqs: 8, MaxBatchedTokens: 4096, PrefixCaching: true,
			RuntimeRequest: map[string]any{"profile": "prefix_cache"},
		},
		{
			Key: "high_throughput", Label: "高并发档", Description: "降低 C16 TTFT 并提高吞吐，TPOT 会有所增加。",
			MaxNumSeqs: 16, MaxBatchedTokens: 8192, PrefixCaching: true,
			RuntimeRequest: map[string]any{
				"profile": "scheduler", "max_num_seqs": 16, "max_num_batched_tokens": 8192,
				"prefix_caching": true, "scheduling_policy": "fcfs", "max_num_partial_prefills": 1,
				"max_long_partial_prefills": 1, "long_prefill_token_threshold": 0,
				"scheduler_reserve_full_isl": true, "disable_custom_all_reduce": true,
				"stream_interval": 1, "async_scheduling": true, "gpu_memory_utilization": 0.9,
				"max_model_len": 4096, "kv_cache_dtype": "auto", "speculative_decoding": "none",
			},
		},
	}
}

func inferenceReleaseProfileByKey(key string) (inferenceReleaseProfile, bool) {
	for _, profile := range inferenceReleaseProfiles() {
		if profile.Key == key {
			return profile, true
		}
	}
	return inferenceReleaseProfile{}, false
}

func customInferenceReleaseProfile(request map[string]any) (inferenceReleaseProfile, error) {
	if len(request) == 0 {
		return inferenceReleaseProfile{}, errors.New("runtime_request required")
	}
	runtimeRequest := make(map[string]any, len(request)+1)
	for key, value := range request {
		runtimeRequest[key] = value
	}
	profile := strings.TrimSpace(stringValue(runtimeRequest["profile"]))
	if profile == "" {
		profile = "scheduler"
		runtimeRequest["profile"] = profile
	}
	if profile != "scheduler" {
		return inferenceReleaseProfile{}, errors.New("custom release requires profile=scheduler")
	}
	maxNumSeqs := intFromAny(runtimeRequest["max_num_seqs"])
	maxBatchedTokens := intFromAny(runtimeRequest["max_num_batched_tokens"])
	if !allowedReleaseInt(maxNumSeqs, 8, 12, 16, 24, 32) {
		return inferenceReleaseProfile{}, errors.New("max_num_seqs must be one of 8, 12, 16, 24 or 32")
	}
	if !allowedReleaseInt(maxBatchedTokens, 2048, 4096, 8192) {
		return inferenceReleaseProfile{}, errors.New("max_num_batched_tokens must be one of 2048, 4096 or 8192")
	}
	tp := intFromAny(runtimeRequest["tensor_parallel_size"])
	pp := intFromAny(runtimeRequest["pipeline_parallel_size"])
	if tp == 0 {
		tp = 2
		runtimeRequest["tensor_parallel_size"] = tp
	}
	if pp == 0 {
		pp = 1
		runtimeRequest["pipeline_parallel_size"] = pp
	}
	if tp*pp != 2 {
		return inferenceReleaseProfile{}, errors.New("tensor_parallel_size * pipeline_parallel_size must equal the available 2 GPUs")
	}
	prefixCaching := true
	if value, ok := runtimeRequest["prefix_caching"].(bool); ok {
		prefixCaching = value
	} else {
		runtimeRequest["prefix_caching"] = true
	}
	return inferenceReleaseProfile{
		Key:   fmt.Sprintf("custom-%d-%d", maxNumSeqs, maxBatchedTokens),
		Label: "自定义配置", Description: "由发布参数或 YAML 生成的受控运行时配置。",
		MaxNumSeqs: maxNumSeqs, MaxBatchedTokens: maxBatchedTokens, PrefixCaching: prefixCaching,
		RuntimeRequest: runtimeRequest,
	}, nil
}

func allowedReleaseInt(value int, allowed ...int) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

type inferenceReleaseCandidate struct {
	Profile             string         `json:"profile"`
	Label               string         `json:"label"`
	Description         string         `json:"description"`
	Available           bool           `json:"available"`
	GatePassed          bool           `json:"gate_passed"`
	RunID               string         `json:"run_id,omitempty"`
	ReportPath          string         `json:"report_path,omitempty"`
	Scenarios           int            `json:"scenarios"`
	MinSuccessRate      float64        `json:"min_success_rate"`
	MinQualityRate      float64        `json:"min_quality_rate"`
	AverageP95TTFTMs    float64        `json:"average_p95_ttft_ms"`
	AverageP95TPOTMs    float64        `json:"average_p95_tpot_ms"`
	AverageThroughput   float64        `json:"average_output_tokens_per_second"`
	MaxP95TTFTMs        float64        `json:"max_p95_ttft_ms"`
	MaxP95TPOTMs        float64        `json:"max_p95_tpot_ms"`
	SLOTTFTLimitMs      float64        `json:"slo_ttft_limit_ms"`
	SLOTPOTLimitMs      float64        `json:"slo_tpot_limit_ms"`
	MaxNumSeqs          int            `json:"max_num_seqs"`
	MaxNumBatchedTokens int            `json:"max_num_batched_tokens"`
	RuntimeRequest      map[string]any `json:"runtime_request"`
	Error               string         `json:"error,omitempty"`
}

type inferenceReleaseProgressStage struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type inferenceReleaseProgress struct {
	ActiveStage   string                          `json:"active_stage"`
	WeightPercent int                             `json:"weight_percent,omitempty"`
	Stages        []inferenceReleaseProgressStage `json:"stages"`
}

var inferenceWeightProgressPattern = regexp.MustCompile(`Loading safetensors checkpoint shards:\s+(\d+)% Completed`)

func deriveInferenceReleaseProgress(runtime, logs map[string]any, releaseActive bool) inferenceReleaseProgress {
	stages := []inferenceReleaseProgressStage{
		{Key: "gate", Label: "发布门禁", State: "pending"},
		{Key: "container", Label: "创建容器", State: "pending"},
		{Key: "weights", Label: "加载权重", State: "pending"},
		{Key: "compile", Label: "编译与缓存", State: "pending"},
		{Key: "health", Label: "健康检查", State: "pending"},
	}
	status, _ := runtime["status"].(string)
	if !releaseActive && status != "starting" && status != "ready" {
		return inferenceReleaseProgress{ActiveStage: "idle", Stages: stages}
	}
	stages[0].State = "complete"
	stages[0].Detail = "模型、参数与压测证据匹配"
	if status == "ready" {
		for index := 1; index < len(stages); index++ {
			stages[index].State = "complete"
		}
		stages[1].Detail = "vLLM workload 已运行"
		stages[2].Detail = "Qwen3.6-27B-FP8 已加载"
		stages[3].Detail = "执行图与 KV Cache 已初始化"
		stages[4].Detail = "OpenAI-Compatible API 已就绪"
		return inferenceReleaseProgress{ActiveStage: "ready", WeightPercent: 100, Stages: stages}
	}
	stages[1].State = "complete"
	stages[1].Detail = "vLLM workload 已创建"
	stages[2].State = "active"
	stages[2].Detail = "等待模型加载日志"
	progress := inferenceReleaseProgress{ActiveStage: "weights", Stages: stages}

	lines, _ := logs["lines"].([]any)
	var text strings.Builder
	for _, raw := range lines {
		line, _ := raw.(string)
		text.WriteString(line)
		text.WriteByte('\n')
		for _, match := range inferenceWeightProgressPattern.FindAllStringSubmatch(line, -1) {
			value, _ := strconv.Atoi(match[1])
			if value > progress.WeightPercent {
				progress.WeightPercent = value
			}
		}
	}
	logText := text.String()
	if progress.WeightPercent > 0 {
		stages[2].Detail = fmt.Sprintf("checkpoint shards %d%%", progress.WeightPercent)
	}
	if strings.Contains(logText, "Model loading took") || progress.WeightPercent >= 100 {
		stages[2].State = "complete"
		stages[2].Detail = "checkpoint shards 100%"
		stages[3].State = "active"
		stages[3].Detail = "初始化执行图与 KV Cache"
		progress.ActiveStage = "compile"
		progress.WeightPercent = 100
	}
	if strings.Contains(logText, "torch.compile took") {
		stages[3].State = "complete"
		stages[3].Detail = "torch.compile 已完成"
		stages[4].State = "active"
		stages[4].Detail = "轮询 /health 与 /v1/models"
		progress.ActiveStage = "health"
	}
	progress.Stages = stages
	return progress
}

func summarizeReleaseCandidate(profile inferenceReleaseProfile, evidence inferenceBenchmarkEvidence) inferenceReleaseCandidate {
	result := inferenceReleaseCandidate{
		Profile: profile.Key, Label: profile.Label, Description: profile.Description,
		Available: true, RunID: evidence.RunID, ReportPath: evidence.ReportPath,
		MaxNumSeqs: profile.MaxNumSeqs, MaxNumBatchedTokens: profile.MaxBatchedTokens,
		RuntimeRequest: profile.RuntimeRequest, MinSuccessRate: 1, MinQualityRate: 1,
		SLOTTFTLimitMs: inferenceReleaseMaxP95TTFTMs, SLOTPOTLimitMs: inferenceReleaseMaxP95TPOTMs,
	}
	scenarios, _ := evidence.Summary["scenarios"].([]any)
	for _, raw := range scenarios {
		scenario, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		result.Scenarios++
		success, _ := asFloat(scenario["success_rate"])
		quality, _ := asFloat(scenario["quality_gate_pass_rate"])
		ttft, _ := asFloat(scenario["p95_ttft_ms"])
		tpot, _ := asFloat(scenario["p95_tpot_ms"])
		throughput, _ := asFloat(scenario["output_tokens_per_second"])
		if success < result.MinSuccessRate {
			result.MinSuccessRate = success
		}
		if quality < result.MinQualityRate {
			result.MinQualityRate = quality
		}
		if ttft > result.MaxP95TTFTMs {
			result.MaxP95TTFTMs = ttft
		}
		if tpot > result.MaxP95TPOTMs {
			result.MaxP95TPOTMs = tpot
		}
		result.AverageP95TTFTMs += ttft
		result.AverageP95TPOTMs += tpot
		result.AverageThroughput += throughput
	}
	if result.Scenarios > 0 {
		count := float64(result.Scenarios)
		result.AverageP95TTFTMs /= count
		result.AverageP95TPOTMs /= count
		result.AverageThroughput /= count
	}
	result.GatePassed = result.Scenarios > 0 && result.MinSuccessRate >= 0.99 && result.MinQualityRate >= 0.99 &&
		result.MaxP95TTFTMs <= inferenceReleaseMaxP95TTFTMs && result.MaxP95TPOTMs <= inferenceReleaseMaxP95TPOTMs
	return result
}

func (a *API) loadInferenceReleaseCandidate(ctx context.Context, profile inferenceReleaseProfile, runID string) (inferenceReleaseCandidate, error) {
	row := a.Pool.QueryRow(ctx, `
		SELECT run_id, COALESCE(endpoint_id,''), COALESCE(workload,''), config, summary,
		       COALESCE(report_path,''), created_at, updated_at
		FROM benchmark_runs
		WHERE status='completed' AND endpoint_id=$1
		  AND COALESCE((config->'vllm'->>'prefix_caching')::boolean, false)=$2
		  AND COALESCE((config->'vllm'->>'max_num_seqs')::int, 0)=$3
		  AND COALESCE((config->'vllm'->>'max_num_batched_tokens')::int, 0)=$4
		  AND ($5='' OR run_id::text=$5)
		ORDER BY jsonb_array_length(COALESCE(summary->'scenarios','[]'::jsonb)) DESC, updated_at DESC
		LIMIT 1`, inferenceReleaseEndpoint, profile.PrefixCaching, profile.MaxNumSeqs, profile.MaxBatchedTokens, runID)
	evidence, err := scanBenchmarkEvidence(row)
	if err != nil {
		return inferenceReleaseCandidate{}, err
	}
	return summarizeReleaseCandidate(profile, evidence), nil
}

// GET /api/inference/releases returns server-selected, parameter-matched release evidence.
func (a *API) inferenceReleaseCandidates(w http.ResponseWriter, r *http.Request) {
	candidates := make([]inferenceReleaseCandidate, 0, len(inferenceReleaseProfiles()))
	for _, profile := range inferenceReleaseProfiles() {
		candidate, err := a.loadInferenceReleaseCandidate(r.Context(), profile, "")
		if err != nil {
			candidate = inferenceReleaseCandidate{
				Profile: profile.Key, Label: profile.Label, Description: profile.Description,
				MaxNumSeqs: profile.MaxNumSeqs, MaxNumBatchedTokens: profile.MaxBatchedTokens,
				RuntimeRequest: profile.RuntimeRequest, Error: err.Error(),
				SLOTTFTLimitMs: inferenceReleaseMaxP95TTFTMs, SLOTPOTLimitMs: inferenceReleaseMaxP95TPOTMs,
			}
		}
		candidates = append(candidates, candidate)
	}
	runtime, _, err := a.Agent.RequestObject(r.Context(), http.MethodGet, "/api/inference/runtime", nil)
	if err != nil {
		runtime = map[string]any{"available": false, "status": "unavailable", "error": err.Error()}
	}
	var releaseActive bool
	_ = a.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM deployments
		WHERE metadata->>'mode'='inference_runtime' AND status IN ('running','success'))`).Scan(&releaseActive)
	logs := map[string]any{}
	if runtime["status"] == "starting" {
		logs = a.Agent.FetchObject(r.Context(), "/api/inference/runtime/logs")
	}
	payload := map[string]any{
		"model_id": inferenceReleaseModelID, "endpoint_id": inferenceReleaseEndpoint,
		"candidates": candidates, "runtime": runtime,
		"progress": deriveInferenceReleaseProgress(runtime, logs, releaseActive),
	}
	if maxNumSeqs, seqErr := strconv.Atoi(r.URL.Query().Get("max_num_seqs")); seqErr == nil {
		if maxBatchedTokens, tokenErr := strconv.Atoi(r.URL.Query().Get("max_num_batched_tokens")); tokenErr == nil {
			prefixCaching := r.URL.Query().Get("prefix_caching") != "false"
			requested, profileErr := customInferenceReleaseProfile(map[string]any{
				"profile": "scheduler", "max_num_seqs": maxNumSeqs,
				"max_num_batched_tokens": maxBatchedTokens, "prefix_caching": prefixCaching,
			})
			if profileErr == nil {
				candidate, candidateErr := a.loadInferenceReleaseCandidate(r.Context(), requested, r.URL.Query().Get("benchmark_run_id"))
				if candidateErr != nil {
					candidate = inferenceReleaseCandidate{Profile: requested.Key, Label: requested.Label, Description: requested.Description,
						MaxNumSeqs: requested.MaxNumSeqs, MaxNumBatchedTokens: requested.MaxBatchedTokens,
						RuntimeRequest: requested.RuntimeRequest, Error: candidateErr.Error(),
						SLOTTFTLimitMs: inferenceReleaseMaxP95TTFTMs, SLOTPOTLimitMs: inferenceReleaseMaxP95TPOTMs}
				}
				payload["requested_candidate"] = candidate
			}
		}
	}
	WriteJSON(w, http.StatusOK, payload)
}

type submitInferenceReleaseRequest struct {
	ModelVersionID string         `json:"model_version_id"`
	Profile        string         `json:"profile"`
	RuntimeRequest map[string]any `json:"runtime_request"`
	ReleaseSpec    string         `json:"release_spec"`
	BenchmarkRunID string         `json:"benchmark_run_id"`
	Env            string         `json:"env"`
	Operator       string         `json:"operator"`
}

func (a *API) submitInferenceRelease(w http.ResponseWriter, r *http.Request) {
	var req submitInferenceReleaseRequest
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	if req.ModelVersionID == "" {
		a.badRequest(w, r, "model_version_id required")
		return
	}
	var profile inferenceReleaseProfile
	var ok bool
	var profileErr error
	if len(req.RuntimeRequest) > 0 {
		profile, profileErr = customInferenceReleaseProfile(req.RuntimeRequest)
	} else {
		profile, ok = inferenceReleaseProfileByKey(req.Profile)
		if !ok {
			profileErr = errors.New("profile must be a known template or runtime_request must be provided")
		}
	}
	if profileErr != nil {
		a.badRequest(w, r, profileErr.Error())
		return
	}
	model, err := a.Store.GetModelVersion(r.Context(), req.ModelVersionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteError(w, r, http.StatusNotFound, "model_version_not_found", "model version not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	if model.ModelID != inferenceReleaseModelID {
		WriteError(w, r, http.StatusConflict, "release_model_mismatch", "该发布通道只接受 Qwen3.6-27B-FP8，不能复用其他模型的推理证据")
		return
	}
	if model.Status == "deprecated" {
		WriteError(w, r, http.StatusConflict, "release_model_deprecated", "deprecated model version cannot be released")
		return
	}
	candidate, err := a.loadInferenceReleaseCandidate(r.Context(), profile, req.BenchmarkRunID)
	if err != nil {
		WriteError(w, r, http.StatusConflict, "release_evidence_missing", "没有与当前核心运行参数完全匹配的已完成压测")
		return
	}
	if !candidate.GatePassed {
		WriteError(w, r, http.StatusConflict, "release_gate_failed", fmt.Sprintf(
			"发布门禁未通过：成功率/质量需 >=99%%，所有场景 P95 TTFT <= %.0fms、P95 TPOT <= %.0fms",
			inferenceReleaseMaxP95TTFTMs, inferenceReleaseMaxP95TPOTMs))
		return
	}
	if trainingID, active, err := a.activeTrainingJob(r.Context()); err != nil {
		a.fail(w, r, err)
		return
	} else if active {
		WriteError(w, r, http.StatusConflict, "gpu_lane_busy", "训练任务 "+trainingID+" 正在占用 GPU 实验通道")
		return
	}
	if benchmarkID, active, err := a.activeBenchmarkRun(r.Context()); err != nil {
		a.fail(w, r, err)
		return
	} else if active {
		WriteError(w, r, http.StatusConflict, "benchmark_active", "推理压测 "+benchmarkID+" 仍在运行")
		return
	}
	var activeRelease bool
	if err := a.Pool.QueryRow(r.Context(), `SELECT EXISTS(
		SELECT 1 FROM deployments WHERE status='running' AND metadata->>'mode'='inference_runtime'
	)`).Scan(&activeRelease); err != nil {
		a.fail(w, r, err)
		return
	}
	if activeRelease {
		WriteError(w, r, http.StatusConflict, "release_in_progress", "已有推理发布正在执行")
		return
	}

	operator := a.actor(r, req.Operator)
	env := orDefault(req.Env, "prod")
	previous, _, previousErr := a.Agent.RequestObject(r.Context(), http.MethodGet, "/api/inference/runtime", nil)
	if previousErr != nil {
		previous = map[string]any{"status": "unavailable", "error": previousErr.Error()}
	}
	var previousReleaseID string
	_ = a.Pool.QueryRow(r.Context(), `SELECT id FROM deployments
		WHERE status='success' AND metadata->>'mode'='inference_runtime'
		ORDER BY started_at DESC LIMIT 1`).Scan(&previousReleaseID)
	meta := map[string]any{
		"owner": operator, "mode": "inference_runtime", "phase": "queued",
		"model_id": model.ModelID, "model_version_id": model.ID, "endpoint_id": inferenceReleaseEndpoint,
		"release_profile": profile.Key, "runtime_request": profile.RuntimeRequest,
		"release_spec":     req.ReleaseSpec,
		"benchmark_run_id": candidate.RunID, "benchmark_report": candidate.ReportPath,
		"gate": map[string]any{"passed": true, "scenarios": candidate.Scenarios, "min_success_rate": candidate.MinSuccessRate, "min_quality_rate": candidate.MinQualityRate,
			"max_p95_ttft_ms": candidate.MaxP95TTFTMs, "max_p95_tpot_ms": candidate.MaxP95TPOTMs,
			"slo_ttft_limit_ms": candidate.SLOTTFTLimitMs, "slo_tpot_limit_ms": candidate.SLOTPOTLimitMs},
		"previous_runtime": previous,
	}
	if previousReleaseID != "" {
		meta["previous_release_id"] = previousReleaseID
	}
	id, err := a.Store.CreateDeploymentMeta(r.Context(), inferenceReleaseName, model.Version, env, meta)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operator, "operator", "inference.release.trigger", "model", model.ModelID+":"+model.Version,
		map[string]any{"deployment_id": id, "profile": profile.Key, "benchmark_run_id": candidate.RunID, "runtime_request": profile.RuntimeRequest})
	go a.runInferenceRelease(id, model.ID, model.ModelID, model.Version, operator, profile, meta)
	WriteJSON(w, http.StatusAccepted, map[string]any{"id": id, "status": "running", "profile": profile.Key, "benchmark_run_id": candidate.RunID})
}

func (a *API) runInferenceRelease(id, modelVersionID, modelID, version, operator string, profile inferenceReleaseProfile, meta map[string]any) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("inference release panic", "id", id, "err", rec)
			a.failInferenceRelease(context.Background(), id, modelVersionID, modelID, version, operator, meta, fmt.Sprintf("panic: %v", rec))
		}
	}()
	ctx := context.Background()
	a.inferenceReleaseEvent(ctx, id, meta, "starting", "starting validated vLLM production workload")
	previous, _, _ := a.Agent.RequestObject(ctx, http.MethodGet, "/api/inference/runtime", nil)
	if status, _ := previous["status"].(string); status == "ready" || status == "starting" {
		a.inferenceReleaseEvent(ctx, id, meta, "replacing", "stopping previous inference workload")
		if _, _, err := a.Agent.RequestObject(ctx, http.MethodDelete, "/api/inference/runtime", nil); err != nil {
			a.failInferenceRelease(ctx, id, modelVersionID, modelID, version, operator, meta, "failed to stop previous runtime: "+err.Error())
			return
		}
	}
	result, _, err := a.Agent.RequestObject(ctx, http.MethodPost, "/api/inference/runtime", profile.RuntimeRequest)
	if err != nil {
		a.failInferenceRelease(ctx, id, modelVersionID, modelID, version, operator, meta, "runtime start failed: "+err.Error())
		return
	}
	meta["runtime"] = result
	a.inferenceReleaseEvent(ctx, id, meta, "warming", "container created; waiting for OpenAI-compatible health check")

	deadline := time.Now().Add(inferenceReleaseTimeout)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		status, _, statusErr := a.Agent.RequestObject(ctx, http.MethodGet, "/api/inference/runtime", nil)
		if statusErr != nil {
			meta["message"] = "runtime status unavailable: " + statusErr.Error()
			a.persistDeployMeta(ctx, id, meta)
		} else {
			meta["runtime"] = status
			a.persistDeployMeta(ctx, id, meta)
			switch runtimeStatus, _ := status["status"].(string); runtimeStatus {
			case "ready":
				a.finishInferenceRelease(ctx, id, modelVersionID, modelID, version, operator, meta, "succeeded", "vLLM production endpoint is ready")
				return
			case "error", "stopped":
				a.failInferenceRelease(ctx, id, modelVersionID, modelID, version, operator, meta, "runtime entered "+runtimeStatus)
				return
			}
		}
		if time.Now().After(deadline) {
			a.failInferenceRelease(ctx, id, modelVersionID, modelID, version, operator, meta, "runtime readiness timed out")
			return
		}
	}
}

func (a *API) failInferenceRelease(ctx context.Context, id, modelVersionID, modelID, version, operator string, meta map[string]any, message string) {
	_, _, _ = a.Agent.RequestObject(ctx, http.MethodDelete, "/api/inference/runtime", nil)
	previous, _ := meta["previous_runtime"].(map[string]any)
	if request, ok := runtimeRequestForRestore(previous); ok {
		a.inferenceReleaseEvent(ctx, id, meta, "rolling_back", "restoring previous inference runtime")
		if restored, _, err := a.Agent.RequestObject(ctx, http.MethodPost, "/api/inference/runtime", request); err != nil {
			meta["rollback_error"] = err.Error()
		} else {
			meta["rollback_runtime"] = restored
			meta["rollback_status"] = "starting"
		}
	}
	a.finishInferenceRelease(ctx, id, modelVersionID, modelID, version, operator, meta, "failed", message)
}

func runtimeRequestForRestore(status map[string]any) (map[string]any, bool) {
	if status == nil || status["status"] != "ready" {
		return nil, false
	}
	profile, _ := status["profile"].(string)
	if profile == "baseline" || profile == "prefix_cache" {
		return map[string]any{"profile": profile}, true
	}
	if profile != "scheduler" {
		return nil, false
	}
	config, _ := status["config"].(map[string]any)
	request := map[string]any{"profile": "scheduler"}
	for _, key := range []string{
		"tensor_parallel_size", "pipeline_parallel_size", "pipeline_layer_partition",
		"max_num_seqs", "max_num_batched_tokens", "scheduling_policy", "max_num_partial_prefills",
		"max_long_partial_prefills", "long_prefill_token_threshold", "stream_interval", "prefix_caching",
		"async_scheduling", "scheduler_reserve_full_isl", "disable_custom_all_reduce", "profiling",
		"gpu_memory_utilization", "max_model_len", "kv_cache_dtype", "speculative_decoding",
	} {
		if value, exists := config[key]; exists {
			request[key] = value
		}
	}
	return request, true
}

func (a *API) finishInferenceRelease(ctx context.Context, id, modelVersionID, modelID, version, operator string, meta map[string]any, phase, message string) {
	a.inferenceReleaseEvent(ctx, id, meta, phase, message)
	status := "failed"
	if phase == "succeeded" {
		status = "success"
		_, _, _ = a.Store.UpdateModelStatus(ctx, modelVersionID, "serving")
		if previousID, _ := meta["previous_release_id"].(string); previousID != "" && previousID != id {
			_, _ = a.Pool.Exec(ctx, `UPDATE deployments SET status='rolled_back', finished_at=now(),
				metadata=jsonb_set(metadata,'{phase}','"superseded"'::jsonb) WHERE id=$1::uuid`, previousID)
		}
		bindingMeta, _ := json.Marshal(map[string]any{
			"release_id": id, "release_profile": meta["release_profile"], "model_version": version,
		})
		_, _ = a.Pool.Exec(ctx, `UPDATE service_instances SET status='healthy', last_checked_at=now(),
			metadata=metadata || $2::jsonb WHERE name=$1`, inferenceReleaseEndpoint, bindingMeta)
	}
	_, _ = a.Store.FinishDeployment(ctx, id, status)
	a.Store.Audit(ctx, operator, "operator", "inference.release."+phase, "model", modelID+":"+version,
		map[string]any{"deployment_id": id, "message": message})
}

func (a *API) inferenceReleaseEvent(ctx context.Context, id string, meta map[string]any, phase, message string) {
	a.deployEvent(ctx, id, meta, phase, message)
}

// DELETE /api/inference/releases/{id} takes the active single-node production workload offline.
func (a *API) stopInferenceRelease(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if benchmarkID, active, err := a.activeBenchmarkRun(r.Context()); err != nil {
		a.fail(w, r, err)
		return
	} else if active {
		WriteError(w, r, http.StatusConflict, "benchmark_active", "推理压测 "+benchmarkID+" 仍在运行")
		return
	}
	var latestID, latestStatus string
	err := a.Pool.QueryRow(r.Context(), `SELECT id, status FROM deployments
		WHERE metadata->>'mode'='inference_runtime'
		ORDER BY started_at DESC LIMIT 1`).Scan(&latestID, &latestStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteError(w, r, http.StatusConflict, "release_not_active", "没有运行中的推理发布")
			return
		}
		a.fail(w, r, err)
		return
	}
	if latestID != id {
		WriteError(w, r, http.StatusConflict, "release_not_current", "只能下线当前生效的推理发布")
		return
	}
	if latestStatus != "running" && latestStatus != "success" {
		WriteError(w, r, http.StatusConflict, "release_not_active", "当前推理发布已经下线")
		return
	}
	if _, _, err := a.Agent.RequestObject(r.Context(), http.MethodDelete, "/api/inference/runtime", nil); err != nil {
		WriteError(w, r, http.StatusBadGateway, "inference_stop_failed", err.Error())
		return
	}
	var modelVersionID string
	_ = a.Pool.QueryRow(r.Context(), `SELECT COALESCE(metadata->>'model_version_id','') FROM deployments WHERE id=$1::uuid`, id).Scan(&modelVersionID)
	_, _ = a.Pool.Exec(r.Context(), `UPDATE deployments SET status='rolled_back', finished_at=now(),
		metadata=jsonb_set(jsonb_set(metadata,'{phase}','"stopped"'::jsonb),'{message}','"production workload stopped"'::jsonb)
		WHERE id=$1::uuid`, id)
	if modelVersionID != "" {
		_, _, _ = a.Store.UpdateModelStatus(r.Context(), modelVersionID, "registered")
	}
	_, _ = a.Pool.Exec(r.Context(), `UPDATE service_instances SET status='unreachable', last_checked_at=now() WHERE name=$1`, inferenceReleaseEndpoint)
	operator := a.actor(r, "")
	a.Store.Audit(r.Context(), operator, "operator", "inference.release.stopped", "deployment", id, nil)
	WriteJSON(w, http.StatusOK, map[string]any{"id": id, "status": "rolled_back", "runtime_status": "stopped"})
}
