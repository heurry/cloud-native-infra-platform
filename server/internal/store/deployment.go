package store

import (
	"context"
	"encoding/json"

	"github.com/heurry/cloudnative-infra-platform/server/internal/db/sqlcgen"
)

// Deployments 返回部署列表。
func (s *Store) Deployments(ctx context.Context) ([]sqlcgen.ListDeploymentsRow, error) {
	return s.q.ListDeployments(ctx)
}

// CreateDeployment 触发部署（running），metadata={owner}。返回新 id。
func (s *Store) CreateDeployment(ctx context.Context, name, version, env, operator string) (string, error) {
	meta, _ := json.Marshal(map[string]any{"owner": operator})
	return s.q.CreateDeployment(ctx, sqlcgen.CreateDeploymentParams{
		DeploymentKey: ptr(name), Version: ptr(version), Env: ptr(env), Metadata: meta,
	})
}

// CreateDeploymentMeta 触发部署（running）并写入自定义 metadata（A1：含 rollout 目标/镜像/阶段）。返回新 id。
func (s *Store) CreateDeploymentMeta(ctx context.Context, name, version, env string, meta map[string]any) (string, error) {
	b, err := json.Marshal(meta)
	if err != nil {
		return "", err
	}
	return s.q.CreateDeployment(ctx, sqlcgen.CreateDeploymentParams{
		DeploymentKey: ptr(name), Version: ptr(version), Env: ptr(env), Metadata: b,
	})
}

// FinishDeployment 标记成功/失败，返回 deployment_key（供审计）。
func (s *Store) FinishDeployment(ctx context.Context, id, status string) (string, error) {
	if err := s.q.FinishDeployment(ctx, sqlcgen.FinishDeploymentParams{Status: status, ID: id}); err != nil {
		return "", err
	}
	key, err := s.q.GetDeploymentKey(ctx, id)
	if err != nil {
		return "", err
	}
	return deref(key), nil
}

// RollbackDeployment 原记录置 rolled_back + 生成新 running 记录（事务），返回新 id 与 key。
func (s *Store) RollbackDeployment(ctx context.Context, id, operator string) (string, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)
	q := s.q.WithTx(tx)

	orig, err := q.GetDeploymentForRollback(ctx, id)
	if err != nil {
		return "", "", err
	}
	if err := q.MarkDeploymentRolledBack(ctx, id); err != nil {
		return "", "", err
	}
	meta, _ := json.Marshal(map[string]any{"rollback_of": id, "owner": operator})
	newID, err := q.CreateDeployment(ctx, sqlcgen.CreateDeploymentParams{
		DeploymentKey: orig.DeploymentKey, Version: orig.Version, Env: orig.Env, Metadata: meta,
	})
	if err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return newID, deref(orig.DeploymentKey), nil
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
