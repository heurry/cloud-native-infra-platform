package httpx

import (
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// AI 诊断的「线上格式」映射处（与 dto.go 同职责）：sqlcgen 行 → 前端 DTO。
// confidence/latency_ms 列是 NUMERIC（sqlc 生成 pgtype.Numeric），在此转 *float64；
// evidence/recommended_actions/related_resources 是 JSONB 数组，转 json.RawMessage 原样透出。

// DiagnosisDTO 是诊断详情（GET /api/ai/diagnoses/{id}）。
type DiagnosisDTO struct {
	ID                 string          `json:"id"`
	Question           string          `json:"question"`
	Status             string          `json:"status"`
	RootCause          *string         `json:"root_cause"`
	Confidence         *float64        `json:"confidence"`
	Impact             *string         `json:"impact"`
	Evidence           json.RawMessage `json:"evidence"`
	RecommendedActions json.RawMessage `json:"recommended_actions"`
	RelatedResources   json.RawMessage `json:"related_resources"`
	ModelID            *string         `json:"model_id"`
	EndpointID         *string         `json:"endpoint_id"`
	LatencyMs          *float64        `json:"latency_ms"`
	Error              *string         `json:"error"`
	CreatedAt          string          `json:"created_at"`
}

func toDiagnosisDTO(r sqlcgen.Diagnosis) DiagnosisDTO {
	return DiagnosisDTO{
		ID: r.ID, Question: r.Question, Status: r.Status,
		RootCause: r.RootCause, Confidence: numPtr(r.Confidence), Impact: r.Impact,
		Evidence:           jsonArr(r.Evidence),
		RecommendedActions: jsonArr(r.RecommendedActions),
		RelatedResources:   jsonArr(r.RelatedResources),
		ModelID:            r.ModelID, EndpointID: r.EndpointID, LatencyMs: numPtr(r.LatencyMs),
		Error: r.Error, CreatedAt: tStr(r.CreatedAt),
	}
}

// DiagnosisListItemDTO 是诊断历史行（GET /api/ai/diagnoses）——不含大 JSONB 字段。
type DiagnosisListItemDTO struct {
	ID         string   `json:"id"`
	Question   string   `json:"question"`
	Status     string   `json:"status"`
	RootCause  *string  `json:"root_cause"`
	Confidence *float64 `json:"confidence"`
	Impact     *string  `json:"impact"`
	ModelID    *string  `json:"model_id"`
	EndpointID *string  `json:"endpoint_id"`
	LatencyMs  *float64 `json:"latency_ms"`
	Error      *string  `json:"error"`
	CreatedAt  string   `json:"created_at"`
}

func toDiagnosisListItemDTO(r sqlcgen.ListDiagnosesRow) DiagnosisListItemDTO {
	return DiagnosisListItemDTO{
		ID: r.ID, Question: r.Question, Status: r.Status,
		RootCause: r.RootCause, Confidence: numPtr(r.Confidence), Impact: r.Impact,
		ModelID: r.ModelID, EndpointID: r.EndpointID, LatencyMs: numPtr(r.LatencyMs),
		Error: r.Error, CreatedAt: tStr(r.CreatedAt),
	}
}

// numPtr 把 pgtype.Numeric 转 *float64（NULL/无效 → nil）。
func numPtr(n pgtype.Numeric) *float64 {
	if !n.Valid {
		return nil
	}
	fv, err := n.Float64Value()
	if err != nil || !fv.Valid {
		return nil
	}
	f := fv.Float64
	return &f
}

// jsonArr 保证 JSONB 数组字段对外是合法 JSON：空/非法 → []（对齐列默认值）。
func jsonArr(b []byte) json.RawMessage {
	if len(b) == 0 || !json.Valid(b) {
		return json.RawMessage("[]")
	}
	return json.RawMessage(b)
}
