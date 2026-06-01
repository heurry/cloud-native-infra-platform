package store

import (
	"context"
	"encoding/json"

	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// RegisterInstanceParams 是服务自注册的领域入参（5B.2）。
type RegisterInstanceParams struct {
	Name        string
	BaseURL     string
	Kind        string
	ModelID     *string
	GpuID       *string
	RoutingRole *string
	Metadata    map[string]any
}

// RegisterInstance 按 name upsert 注册/重注册，置 healthy 并打心跳戳。
func (s *Store) RegisterInstance(ctx context.Context, p RegisterInstanceParams) (name, status string, err error) {
	meta := []byte("{}")
	if p.Metadata != nil {
		if b, mErr := json.Marshal(p.Metadata); mErr == nil {
			meta = b
		}
	}
	kind := p.Kind
	if kind == "" {
		kind = "vllm"
	}
	row, err := s.q.RegisterServiceInstance(ctx, sqlcgen.RegisterServiceInstanceParams{
		Name:        p.Name,
		BaseUrl:     p.BaseURL,
		ModelID:     p.ModelID,
		Kind:        kind,
		GpuID:       p.GpuID,
		RoutingRole: p.RoutingRole,
		Metadata:    meta,
	})
	if err != nil {
		return "", "", err
	}
	return row.Name, row.Status, nil
}

// HeartbeatInstance 刷新心跳；返回是否命中（false=实例不存在）。
func (s *Store) HeartbeatInstance(ctx context.Context, name string) (bool, error) {
	n, err := s.q.HeartbeatServiceInstance(ctx, name)
	return n > 0, err
}

// DeregisterInstance 注销实例；返回是否命中。
func (s *Store) DeregisterInstance(ctx context.Context, name string) (bool, error) {
	n, err := s.q.DeregisterServiceInstance(ctx, name)
	return n > 0, err
}

// SweepStaleInstances 把超 TTL 未心跳的实例置 unreachable，返回被处理的 name 列表。
func (s *Store) SweepStaleInstances(ctx context.Context, ttlSeconds float64) ([]string, error) {
	return s.q.SweepStaleServiceInstances(ctx, ttlSeconds)
}
