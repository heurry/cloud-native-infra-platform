package httpx

import "testing"

func TestInferenceReleaseProfilesUseValidatedParameters(t *testing.T) {
	balanced, ok := inferenceReleaseProfileByKey("balanced")
	if !ok || balanced.MaxNumSeqs != 8 || balanced.MaxBatchedTokens != 4096 {
		t.Fatalf("unexpected balanced profile: %+v", balanced)
	}
	if balanced.RuntimeRequest["profile"] != "prefix_cache" {
		t.Fatalf("balanced runtime must use the validated prefix-cache profile: %+v", balanced.RuntimeRequest)
	}
	high, ok := inferenceReleaseProfileByKey("high_throughput")
	if !ok || high.MaxNumSeqs != 16 || high.MaxBatchedTokens != 8192 {
		t.Fatalf("unexpected high-throughput profile: %+v", high)
	}
	if high.RuntimeRequest["profile"] != "scheduler" || high.RuntimeRequest["prefix_caching"] != true {
		t.Fatalf("high-throughput runtime request lost validated scheduler parameters: %+v", high.RuntimeRequest)
	}
	if _, ok := inferenceReleaseProfileByKey("unvalidated"); ok {
		t.Fatal("unknown release profiles must be rejected")
	}
}

func TestSummarizeReleaseCandidateRequiresEveryScenarioToPass(t *testing.T) {
	profile, _ := inferenceReleaseProfileByKey("balanced")
	evidence := inferenceBenchmarkEvidence{RunID: "run-1", Summary: map[string]any{"scenarios": []any{
		map[string]any{"success_rate": 1.0, "quality_gate_pass_rate": 1.0, "p95_ttft_ms": 1000.0, "p95_tpot_ms": 50.0, "output_tokens_per_second": 80.0},
		map[string]any{"success_rate": 0.98, "quality_gate_pass_rate": 1.0, "p95_ttft_ms": 2000.0, "p95_tpot_ms": 70.0, "output_tokens_per_second": 100.0},
	}}}
	candidate := summarizeReleaseCandidate(profile, evidence)
	if candidate.GatePassed {
		t.Fatal("one scenario below 99% must block release")
	}
	if candidate.Scenarios != 2 || candidate.MinSuccessRate != 0.98 || candidate.AverageP95TTFTMs != 1500 {
		t.Fatalf("unexpected candidate summary: %+v", candidate)
	}

	evidence.Summary["scenarios"].([]any)[1].(map[string]any)["success_rate"] = 1.0
	if candidate = summarizeReleaseCandidate(profile, evidence); !candidate.GatePassed {
		t.Fatalf("all passing scenarios should open the gate: %+v", candidate)
	}
}

func TestRuntimeRequestForRestore(t *testing.T) {
	if _, ok := runtimeRequestForRestore(map[string]any{"status": "stopped", "profile": "prefix_cache"}); ok {
		t.Fatal("a stopped runtime must not be restored")
	}
	request, ok := runtimeRequestForRestore(map[string]any{"status": "ready", "profile": "prefix_cache"})
	if !ok || request["profile"] != "prefix_cache" {
		t.Fatalf("unexpected prefix-cache restore request: %+v", request)
	}
	request, ok = runtimeRequestForRestore(map[string]any{
		"status": "ready", "profile": "scheduler",
		"config": map[string]any{"max_num_seqs": 16.0, "max_num_batched_tokens": 8192.0, "prefix_caching": true},
	})
	if !ok || request["profile"] != "scheduler" || request["max_num_seqs"] != 16.0 || request["prefix_caching"] != true {
		t.Fatalf("unexpected scheduler restore request: %+v", request)
	}
}

func TestDeriveInferenceReleaseProgress(t *testing.T) {
	progress := deriveInferenceReleaseProgress(
		map[string]any{"status": "starting"},
		map[string]any{"lines": []any{
			"Loading safetensors checkpoint shards:  53% Completed | 35/66",
		}},
		true,
	)
	if progress.ActiveStage != "weights" || progress.WeightPercent != 53 || progress.Stages[2].State != "active" {
		t.Fatalf("unexpected weight progress: %+v", progress)
	}
	progress = deriveInferenceReleaseProgress(
		map[string]any{"status": "starting"},
		map[string]any{"lines": []any{
			"Loading safetensors checkpoint shards: 100% Completed | 66/66",
			"Model loading took 14.17 GiB memory and 9.18 seconds",
			"torch.compile took 7.31 s in total",
		}},
		true,
	)
	if progress.ActiveStage != "health" || progress.Stages[3].State != "complete" || progress.Stages[4].State != "active" {
		t.Fatalf("unexpected health progress: %+v", progress)
	}
	progress = deriveInferenceReleaseProgress(map[string]any{"status": "ready"}, nil, true)
	for _, stage := range progress.Stages {
		if stage.State != "complete" {
			t.Fatalf("ready runtime must complete every stage: %+v", progress)
		}
	}
}
