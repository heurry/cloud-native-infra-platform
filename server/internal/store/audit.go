package store

import (
	"context"

	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// AuditEvents 返回审计事件（resourceType 为空则不过滤）。两个查询均直接返回 []AuditEvent。
func (s *Store) AuditEvents(ctx context.Context, resourceType string, limit int32) ([]sqlcgen.AuditEvent, error) {
	if resourceType != "" {
		return s.q.ListAuditEventsByResourceType(ctx, sqlcgen.ListAuditEventsByResourceTypeParams{
			ResourceType: ptr(resourceType), Lim: limit,
		})
	}
	return s.q.ListAuditEvents(ctx, limit)
}

// ServiceInstanceHealthcheck 占位：更新 last_checked_at，返回是否命中（行数>0）。
func (s *Store) ServiceInstanceHealthcheck(ctx context.Context, name string) (bool, error) {
	n, err := s.q.UpdateServiceInstanceChecked(ctx, name)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
