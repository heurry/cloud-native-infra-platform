package httpx

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/aiclient"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
)

// ===== AI 诊断 /api/ai =====
// 边界（Phase 3 D4）：Go 取证 → Python 推理 → Go 落库+审计+历史。
// 无 GPU 时 Python 走 stub 模式，本链路仍可端到端跑通（result.Mode=stub）。

type diagnoseReq struct {
	Question    string  `json:"question"`
	MaxTokens   int     `json:"max_tokens"`
	Temperature float64 `json:"temperature"`
	Operator    string  `json:"operator"`
}

func (a *API) diagnose(w http.ResponseWriter, r *http.Request) {
	var req diagnoseReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	question := strings.TrimSpace(req.Question)
	if question == "" {
		a.badRequest(w, r, "question required")
		return
	}
	operator := orDefault(req.Operator, defaultOperator)
	ctx := r.Context()

	// 1) Go 取证：聚合 metrics / 事件 / 部署 / 配置 / k8s 成证据 bundle（best-effort）。
	evidence := a.gatherEvidence(ctx)

	// 2) 调 Python 推理。
	var opts *aiclient.DiagnoseOptions
	if req.MaxTokens > 0 || req.Temperature > 0 {
		opts = &aiclient.DiagnoseOptions{MaxTokens: req.MaxTokens, Temperature: req.Temperature}
	}
	result, aiErr := a.AI.Diagnose(ctx, aiclient.DiagnoseRequest{
		Question: question, Evidence: evidence, Options: opts,
	})

	// 3a) 上游失败：仍落一条 failed 诊断 + 审计（可观测），返回 502。
	if aiErr != nil {
		id, insErr := a.Store.InsertDiagnosis(ctx, store.DiagnosisInput{
			Question: question, Status: "failed", Error: aiErr.Error(),
		})
		if insErr != nil {
			slog.Error("persist failed-diagnosis errored", "err", insErr, "request_id", RequestIDFrom(ctx))
		}
		a.Store.Audit(ctx, operator, "operator", "ai.diagnose", "diagnosis", id,
			map[string]any{"status": "failed", "error": aiErr.Error()})
		slog.Error("diagnose upstream failed", "err", aiErr, "request_id", RequestIDFrom(ctx))
		WriteError(w, r, http.StatusBadGateway, "ai_unavailable", "AI service failed: "+classifyAIErr(aiErr))
		return
	}

	// 3b) 成功：落库 → 回读 → DTO（round-trip 保证「返回==落库」）。
	id, err := a.Store.InsertDiagnosis(ctx, store.DiagnosisInput{
		Question:           question,
		Status:             result.Status,
		RootCause:          result.RootCause,
		Confidence:         result.Confidence,
		Impact:             result.Impact,
		Evidence:           []byte(result.Evidence),
		RecommendedActions: []byte(result.RecommendedActions),
		RelatedResources:   []byte(result.RelatedResources),
		ModelID:            result.ModelID,
		EndpointID:         result.EndpointID,
		LatencyMs:          result.LatencyMs,
		Error:              result.Error,
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(ctx, operator, "operator", "ai.diagnose", "diagnosis", id,
		map[string]any{"status": result.Status, "mode": result.Mode, "model_id": result.ModelID})

	row, err := a.Store.GetDiagnosis(ctx, id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"diagnosis": toDiagnosisDTO(row), "mode": result.Mode})
}

// gatherEvidence 聚合证据 bundle；每块独立 best-effort，单块失败不拖垮整次诊断。
func (a *API) gatherEvidence(ctx context.Context) map[string]any {
	ev := map[string]any{}

	if m, err := a.Metrics.Current(ctx); err == nil {
		ev["metrics"] = m
	} else {
		ev["metrics"] = map[string]any{"error": err.Error()}
		slog.Warn("evidence metrics failed", "err", err)
	}

	if rows, err := a.Store.Incidents(ctx, ""); err == nil {
		ev["incidents"] = mapSlice(rows, toIncidentDTO)
	} else {
		ev["incidents"] = []any{}
		slog.Warn("evidence incidents failed", "err", err)
	}

	if rows, err := a.Store.Deployments(ctx); err == nil {
		ev["deployments"] = mapSlice(rows, toDeploymentDTO)
	} else {
		ev["deployments"] = []any{}
		slog.Warn("evidence deployments failed", "err", err)
	}

	if rows, err := a.Store.ConfigItems(ctx); err == nil {
		ev["config_items"] = mapSlice(rows, toConfigItemDTO)
	} else {
		ev["config_items"] = []any{}
		slog.Warn("evidence config_items failed", "err", err)
	}

	// k8s 经 Agent 透传，自带 {available:false,...} 降级，无需额外容错。
	ev["kubernetes"] = a.Agent.FetchObject(ctx, "/api/kubernetes/pods")

	return ev
}

func (a *API) getDiagnosis(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		a.badRequest(w, r, "invalid diagnosis id")
		return
	}
	row, err := a.Store.GetDiagnosis(r.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteError(w, r, http.StatusNotFound, "not_found", "diagnosis not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"diagnosis": toDiagnosisDTO(row)})
}

func (a *API) listDiagnoses(w http.ResponseWriter, r *http.Request) {
	limit := clamp(queryInt(r, "limit", 20), 1, 200)
	rows, err := a.Store.ListDiagnoses(r.Context(), int32(limit))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"diagnoses": mapSlice(rows, toDiagnosisListItemDTO)})
}

// classifyAIErr 把 aiclient 的错误分类转成对外简短原因（不泄露内部细节）。
func classifyAIErr(err error) string {
	switch {
	case errors.Is(err, aiclient.ErrUnreachable):
		return "unreachable"
	case errors.Is(err, aiclient.ErrBadStatus):
		return "upstream error"
	case errors.Is(err, aiclient.ErrBadResponse):
		return "malformed response"
	default:
		return "unknown"
	}
}
