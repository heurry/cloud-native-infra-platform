package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// C1：模型注册中心 store 层。对外暴露统一领域类型 ModelVersion（隐藏 sqlc 行类型），
// handler/DTO 只依赖它。tags JSONB ↔ []string 在此转换。

// ModelVersion 是一个注册的模型版本（版本化 + 血缘）。
type ModelVersion struct {
	ID            string
	ModelID       string
	Version       string
	BaseModel     *string
	LoraAdapter   *string
	ParentVersion *string
	ArtifactURI   *string
	Tags          []string
	Status        string
	CreatedBy     *string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// RegisterModelParams 是注册一个模型版本的入参（handler→store 边界）。
type RegisterModelParams struct {
	ModelID       string
	Version       string
	BaseModel     *string
	LoraAdapter   *string
	ParentVersion *string
	ArtifactURI   *string
	Tags          []string
	Status        string
	CreatedBy     string
}

func (s *Store) ListModelVersions(ctx context.Context) ([]ModelVersion, error) {
	rows, err := s.q.ListModelVersions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ModelVersion, 0, len(rows))
	for _, r := range rows {
		out = append(out, rowToModelVersion(r.ID, r.ModelID, r.Version, r.BaseModel, r.LoraAdapter,
			r.ParentVersion, r.ArtifactUri, r.Tags, r.Status, r.CreatedBy, r.CreatedAt, r.UpdatedAt))
	}
	return out, nil
}

func (s *Store) GetModelVersion(ctx context.Context, id string) (ModelVersion, error) {
	r, err := s.q.GetModelVersion(ctx, id)
	if err != nil {
		return ModelVersion{}, err
	}
	return rowToModelVersion(r.ID, r.ModelID, r.Version, r.BaseModel, r.LoraAdapter,
		r.ParentVersion, r.ArtifactUri, r.Tags, r.Status, r.CreatedBy, r.CreatedAt, r.UpdatedAt), nil
}

// VersionsByModelID 返回某 model_id 的全部版本（用于血缘链回溯）。
func (s *Store) VersionsByModelID(ctx context.Context, modelID string) ([]ModelVersion, error) {
	rows, err := s.q.ListVersionsByModelID(ctx, modelID)
	if err != nil {
		return nil, err
	}
	out := make([]ModelVersion, 0, len(rows))
	for _, r := range rows {
		out = append(out, rowToModelVersion(r.ID, r.ModelID, r.Version, r.BaseModel, r.LoraAdapter,
			r.ParentVersion, r.ArtifactUri, r.Tags, r.Status, r.CreatedBy, r.CreatedAt, r.UpdatedAt))
	}
	return out, nil
}

func (s *Store) RegisterModelVersion(ctx context.Context, p RegisterModelParams) (string, error) {
	tags, err := json.Marshal(p.Tags)
	if err != nil || len(tags) == 0 {
		tags = []byte("[]")
	}
	var createdBy *string
	if p.CreatedBy != "" {
		createdBy = &p.CreatedBy
	}
	return s.q.RegisterModelVersion(ctx, sqlcgen.RegisterModelVersionParams{
		ModelID:       p.ModelID,
		Version:       p.Version,
		BaseModel:     p.BaseModel,
		LoraAdapter:   p.LoraAdapter,
		ParentVersion: p.ParentVersion,
		ArtifactUri:   p.ArtifactURI,
		Tags:          tags,
		Status:        p.Status,
		CreatedBy:     createdBy,
	})
}

func (s *Store) UpdateModelStatus(ctx context.Context, id, status string) (modelID, version string, err error) {
	row, err := s.q.UpdateModelVersionStatus(ctx, sqlcgen.UpdateModelVersionStatusParams{Status: status, ID: id})
	return row.ModelID, row.Version, err
}

func (s *Store) SetModelArtifact(ctx context.Context, id, uri string) error {
	return s.q.SetModelArtifact(ctx, sqlcgen.SetModelArtifactParams{ArtifactUri: &uri, ID: id})
}

func (s *Store) DeleteModelVersion(ctx context.Context, id string) (modelID, version string, err error) {
	row, err := s.q.DeleteModelVersion(ctx, id)
	return row.ModelID, row.Version, err
}

func rowToModelVersion(id, modelID, version string, base, lora, parent, artifact *string,
	tags []byte, status string, createdBy *string, createdAt, updatedAt time.Time) ModelVersion {
	parsed := []string{}
	if len(tags) > 0 {
		_ = json.Unmarshal(tags, &parsed)
	}
	return ModelVersion{
		ID: id, ModelID: modelID, Version: version, BaseModel: base, LoraAdapter: lora,
		ParentVersion: parent, ArtifactURI: artifact, Tags: parsed, Status: status,
		CreatedBy: createdBy, CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
}
