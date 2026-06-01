package store

import (
	"context"
	"encoding/json"

	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// Incidents 返回故障事件列表（status 为空则不过滤）。
func (s *Store) Incidents(ctx context.Context, status string) ([]sqlcgen.ListIncidentsRow, error) {
	if status != "" {
		byStatus, err := s.q.ListIncidentsByStatus(ctx, status)
		if err != nil {
			return nil, err
		}
		// ListIncidentsByStatusRow 与 ListIncidentsRow 同构，转换以统一返回类型。
		out := make([]sqlcgen.ListIncidentsRow, 0, len(byStatus))
		for _, r := range byStatus {
			out = append(out, sqlcgen.ListIncidentsRow(r))
		}
		return out, nil
	}
	return s.q.ListIncidents(ctx)
}

// IncidentDetail 返回事件 + 时间线。
func (s *Store) IncidentDetail(ctx context.Context, id string) (sqlcgen.GetIncidentRow, []sqlcgen.ListIncidentEventsRow, error) {
	inc, err := s.q.GetIncident(ctx, id)
	if err != nil {
		return sqlcgen.GetIncidentRow{}, nil, err
	}
	events, err := s.q.ListIncidentEvents(ctx, id)
	if err != nil {
		return sqlcgen.GetIncidentRow{}, nil, err
	}
	return inc, events, nil
}

// CreateIncident 新建（open）+ created 时间线事件（事务），返回新 id。
func (s *Store) CreateIncident(ctx context.Context, title, severity, summary string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	q := s.q.WithTx(tx)

	id, err := q.CreateIncident(ctx, sqlcgen.CreateIncidentParams{Title: title, Severity: severity, Summary: ptr(summary)})
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]any{"severity": severity})
	if err := q.InsertIncidentEvent(ctx, sqlcgen.InsertIncidentEventParams{
		IncidentID: id, EventType: ptr("created"), Payload: payload,
	}); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// AckIncident 受理 + acknowledged 时间线事件（事务）。
func (s *Store) AckIncident(ctx context.Context, id, operator string) error {
	return s.incidentTransition(ctx, id, "acknowledged", operator, func(q *sqlcgen.Queries) error {
		return q.AckIncident(ctx, id)
	})
}

// ResolveIncident 解决 + resolved 时间线事件（事务）。
func (s *Store) ResolveIncident(ctx context.Context, id, operator string) error {
	return s.incidentTransition(ctx, id, "resolved", operator, func(q *sqlcgen.Queries) error {
		return q.ResolveIncident(ctx, id)
	})
}

func (s *Store) incidentTransition(ctx context.Context, id, eventType, operator string, mutate func(*sqlcgen.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.q.WithTx(tx)

	if err := mutate(q); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"operator": operator})
	if err := q.InsertIncidentEvent(ctx, sqlcgen.InsertIncidentEventParams{
		IncidentID: id, EventType: ptr(eventType), Payload: payload,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
