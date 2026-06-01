package store

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// DiagnosisInput 是领域层落库入参：handler 取证 + 调 Python 推理后，把结构化结果
// 归一成本结构再交给 store。JSON 字段（Evidence/RecommendedActions/RelatedResources）
// 由 handler 序列化为 JSONB 数组字节，空值传 "[]"。
type DiagnosisInput struct {
	Question           string
	Status             string // completed / failed
	RootCause          string
	Confidence         *float64 // 0.0~1.0，nil → NULL
	Impact             string
	Evidence           []byte
	RecommendedActions []byte
	RelatedResources   []byte
	ModelID            string
	EndpointID         string
	LatencyMs          *float64
	Error              string
}

// InsertDiagnosis 落库一条诊断，返回新 id。
func (s *Store) InsertDiagnosis(ctx context.Context, in DiagnosisInput) (string, error) {
	return s.q.InsertDiagnosis(ctx, sqlcgen.InsertDiagnosisParams{
		Question:           in.Question,
		Status:             orStatus(in.Status),
		RootCause:          ptr(in.RootCause),
		Confidence:         numFromPtr(in.Confidence),
		Impact:             ptr(in.Impact),
		Evidence:           orJSONArray(in.Evidence),
		RecommendedActions: orJSONArray(in.RecommendedActions),
		RelatedResources:   orJSONArray(in.RelatedResources),
		ModelID:            ptr(in.ModelID),
		EndpointID:         ptr(in.EndpointID),
		LatencyMs:          numFromPtr(in.LatencyMs),
		Error:              ptr(in.Error),
	})
}

// GetDiagnosis 返回单条诊断（含证据/动作/资源 JSONB）。
func (s *Store) GetDiagnosis(ctx context.Context, id string) (sqlcgen.Diagnosis, error) {
	return s.q.GetDiagnosis(ctx, id)
}

// ListDiagnoses 返回诊断历史（不含大字段，按时间倒序）。
func (s *Store) ListDiagnoses(ctx context.Context, limit int32) ([]sqlcgen.ListDiagnosesRow, error) {
	return s.q.ListDiagnoses(ctx, limit)
}

func orStatus(s string) string {
	if s == "" {
		return "completed"
	}
	return s
}

// orJSONArray 保证 JSONB 列非空（NOT NULL DEFAULT '[]'）：空/无效 → "[]"。
func orJSONArray(b []byte) []byte {
	if len(b) == 0 {
		return []byte("[]")
	}
	return b
}

// numFromPtr 把 *float64 转 pgtype.Numeric（nil → NULL）。
// sqlc 对 NUMERIC 列未走 override，故领域层在此承接 float64↔Numeric 转换。
func numFromPtr(f *float64) pgtype.Numeric {
	var n pgtype.Numeric
	if f == nil {
		return n // Valid=false → NULL
	}
	_ = n.Scan(strconv.FormatFloat(*f, 'f', -1, 64))
	return n
}
