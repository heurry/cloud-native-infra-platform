package httpx

import (
	"encoding/json"
	"time"

	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
)

// 本文件是"线上格式"边界：sqlc 领域 Row → 前端 DTO 的唯一映射处。
// 前端改交互/字段时只动这里，store 与 SQL 不受影响（Phase 2 分层决策）。

// ---- 时间/JSONB 辅助 ----

func tStr(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func tPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

// jsonObj 把 JSONB 字节转为可直接序列化的对象；null/非法 → {}（对齐 Java parseObject）。
func jsonObj(b []byte) json.RawMessage {
	if len(b) == 0 || !json.Valid(b) {
		return json.RawMessage("{}")
	}
	return json.RawMessage(b)
}

// ---- 配置中心 ----

type ConfigItemDTO struct {
	ID            string  `json:"id"`
	Env           string  `json:"env"`
	Namespace     *string `json:"namespace"`
	ConfigKey     string  `json:"config_key"`
	ConfigType    string  `json:"config_type"`
	ActiveVersion int32   `json:"active_version"`
	Status        string  `json:"status"`
	CreatedBy     *string `json:"created_by"`
	UpdatedAt     string  `json:"updated_at"`
	VersionCount  int32   `json:"version_count"`
}

func toConfigItemDTO(r sqlcgen.ListConfigItemsRow) ConfigItemDTO {
	return ConfigItemDTO{
		ID: r.ID, Env: r.Env, Namespace: r.Namespace, ConfigKey: r.ConfigKey,
		ConfigType: r.ConfigType, ActiveVersion: r.ActiveVersion, Status: r.Status,
		CreatedBy: r.CreatedBy, UpdatedAt: tStr(r.UpdatedAt), VersionCount: r.VersionCount,
	}
}

type ConfigVersionDTO struct {
	Version      int32   `json:"version"`
	Content      *string `json:"content"`
	ChangeReason *string `json:"change_reason"`
	Operator     *string `json:"operator"`
	Status       string  `json:"status"`
	CreatedAt    string  `json:"created_at"`
}

func toConfigVersionDTO(r sqlcgen.ListConfigVersionsRow) ConfigVersionDTO {
	return ConfigVersionDTO{
		Version: r.Version, Content: r.Content, ChangeReason: r.ChangeReason,
		Operator: r.Operator, Status: r.Status, CreatedAt: tStr(r.CreatedAt),
	}
}

// ---- 发布流水线 ----

type DeploymentDTO struct {
	ID         string          `json:"id"`
	Name       *string         `json:"name"` // = deployment_key
	Version    *string         `json:"version"`
	Env        *string         `json:"env"`
	Status     string          `json:"status"`
	StartedAt  *string         `json:"started_at"`
	FinishedAt *string         `json:"finished_at"`
	Metadata   json.RawMessage `json:"metadata"`
}

func toDeploymentDTO(r sqlcgen.ListDeploymentsRow) DeploymentDTO {
	return DeploymentDTO{
		ID: r.ID, Name: r.DeploymentKey, Version: r.Version, Env: r.Env, Status: r.Status,
		StartedAt: tPtr(r.StartedAt), FinishedAt: tPtr(r.FinishedAt), Metadata: jsonObj(r.Metadata),
	}
}

// ---- C1：模型注册中心 ----

type ModelVersionDTO struct {
	ID            string   `json:"id"`
	ModelID       string   `json:"model_id"`
	Version       string   `json:"version"`
	BaseModel     *string  `json:"base_model"`
	LoraAdapter   *string  `json:"lora_adapter"`
	ParentVersion *string  `json:"parent_version"`
	ArtifactURI   *string  `json:"artifact_uri"`
	Tags          []string `json:"tags"`
	Status        string   `json:"status"`
	CreatedBy     *string  `json:"created_by"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

func toModelVersionDTO(m store.ModelVersion) ModelVersionDTO {
	tags := m.Tags
	if tags == nil {
		tags = []string{}
	}
	return ModelVersionDTO{
		ID: m.ID, ModelID: m.ModelID, Version: m.Version, BaseModel: m.BaseModel,
		LoraAdapter: m.LoraAdapter, ParentVersion: m.ParentVersion, ArtifactURI: m.ArtifactURI,
		Tags: tags, Status: m.Status, CreatedBy: m.CreatedBy,
		CreatedAt: tStr(m.CreatedAt), UpdatedAt: tStr(m.UpdatedAt),
	}
}

// ---- 故障事件 ----

type IncidentDTO struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Severity   string  `json:"severity"`
	Status     string  `json:"status"`
	Summary    *string `json:"summary"`
	CreatedAt  string  `json:"created_at"`
	ResolvedAt *string `json:"resolved_at"`
}

func toIncidentDTO(r sqlcgen.ListIncidentsRow) IncidentDTO {
	return IncidentDTO{
		ID: r.ID, Title: r.Title, Severity: r.Severity, Status: r.Status,
		Summary: r.Summary, CreatedAt: tStr(r.CreatedAt), ResolvedAt: tPtr(r.ResolvedAt),
	}
}

func incidentDetailDTO(r sqlcgen.GetIncidentRow) IncidentDTO {
	return IncidentDTO{
		ID: r.ID, Title: r.Title, Severity: r.Severity, Status: r.Status,
		Summary: r.Summary, CreatedAt: tStr(r.CreatedAt), ResolvedAt: tPtr(r.ResolvedAt),
	}
}

type IncidentEventDTO struct {
	EventType *string         `json:"event_type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
}

func toIncidentEventDTO(r sqlcgen.ListIncidentEventsRow) IncidentEventDTO {
	return IncidentEventDTO{EventType: r.EventType, Payload: jsonObj(r.Payload), CreatedAt: tStr(r.CreatedAt)}
}

// ---- 审计 ----

type AuditEventDTO struct {
	ID           string          `json:"id"`
	ActorID      *string         `json:"actor_id"`
	ActorRole    *string         `json:"actor_role"`
	Action       string          `json:"action"`
	ResourceType *string         `json:"resource_type"`
	ResourceID   *string         `json:"resource_id"`
	Metadata     json.RawMessage `json:"metadata"`
	CreatedAt    string          `json:"created_at"`
}

func toAuditEventDTO(r sqlcgen.AuditEvent) AuditEventDTO {
	return AuditEventDTO{
		ID: r.ID, ActorID: r.ActorID, ActorRole: r.ActorRole, Action: r.Action,
		ResourceType: r.ResourceType, ResourceID: r.ResourceID,
		Metadata: jsonObj(r.Metadata), CreatedAt: tStr(r.CreatedAt),
	}
}

// mapSlice 通用映射辅助。
func mapSlice[T any, R any](in []T, f func(T) R) []R {
	out := make([]R, 0, len(in))
	for _, v := range in {
		out = append(out, f(v))
	}
	return out
}
