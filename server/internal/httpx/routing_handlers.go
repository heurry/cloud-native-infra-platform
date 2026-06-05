package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// E3：模型路由 / A-B / 影子流量。
// routing_policies 是命名的路由策略——多版本加权（A/B 灰度）+ 可选影子目标；与 C1（模型版本）、
// A1（发布）联动，形成「注册 → 灰度发布 → 评测 → 全量/回滚」闭环。数据面入口在 routing_proxy.go。
// 全部 raw SQL（与 benchmarks/storage 一致，不入 sqlc）。

// routingVariant 是一条加权候选：把权重份额的流量路由到 endpoint（service_instances.name）。
// Model 为空时沿用候选实例自身的 model_id；非空则覆盖（同模型多版本灰度）。
type routingVariant struct {
	Label    string `json:"label"`
	Endpoint string `json:"endpoint"`
	Model    string `json:"model,omitempty"`
	Weight   int    `json:"weight"`
}

// routingTarget 是影子目标（镜像流量、丢弃响应、只采指标）。
type routingTarget struct {
	Label    string `json:"label"`
	Endpoint string `json:"endpoint"`
	Model    string `json:"model,omitempty"`
}

type routingPolicy struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Enabled     bool             `json:"enabled"`
	Variants    []routingVariant `json:"variants"`
	Shadow      *routingTarget   `json:"shadow,omitempty"`
	CreatedBy   string           `json:"created_by"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

// loadRoutingPolicy 读单条策略（数据面与控制面共用）。
func (a *API) loadRoutingPolicy(ctx context.Context, name string) (*routingPolicy, error) {
	var p routingPolicy
	var variantsJSON, shadowJSON []byte
	err := a.Pool.QueryRow(ctx,
		`SELECT name, description, enabled, variants, shadow, created_by, created_at, updated_at
		   FROM routing_policies WHERE name = $1`, name).
		Scan(&p.Name, &p.Description, &p.Enabled, &variantsJSON, &shadowJSON, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(variantsJSON, &p.Variants)
	if len(shadowJSON) > 0 && string(shadowJSON) != "null" {
		var sh routingTarget
		if json.Unmarshal(shadowJSON, &sh) == nil && sh.Endpoint != "" {
			p.Shadow = &sh
		}
	}
	return &p, nil
}

// variantStat 是某候选（或影子）在窗口内的聚合指标（A/B 对比面板用）。
type variantStat struct {
	Label     string  `json:"label"`
	Endpoint  string  `json:"endpoint"`
	Count     int64   `json:"count"`
	Share     float64 `json:"share"`   // 占比 0..1
	AvgMs     int     `json:"avg_ms"`
	P95Ms     int     `json:"p95_ms"`
	ErrorRate float64 `json:"error_rate"`
}

// variantStats 聚合 routing_samples 主路指标（按 variant_label 分组，窗口 seconds）。
func (a *API) variantStats(ctx context.Context, policy string, windowSec int) ([]variantStat, error) {
	rows, err := a.Pool.Query(ctx,
		`SELECT variant_label,
		        COALESCE(max(variant_endpoint), '') AS endpoint,
		        count(*) AS n,
		        COALESCE(avg(primary_latency_ms), 0)::int AS avg_ms,
		        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY primary_latency_ms), 0)::int AS p95_ms,
		        count(*) FILTER (WHERE primary_status >= 400 OR primary_status = 0) AS errors
		   FROM routing_samples
		  WHERE policy_name = $1 AND created_at > now() - make_interval(secs => $2)
		  GROUP BY variant_label
		  ORDER BY variant_label`, policy, windowSec)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []variantStat{}
	var total int64
	for rows.Next() {
		var s variantStat
		var errs int64
		if err := rows.Scan(&s.Label, &s.Endpoint, &s.Count, &s.AvgMs, &s.P95Ms, &errs); err != nil {
			return nil, err
		}
		if s.Count > 0 {
			s.ErrorRate = float64(errs) / float64(s.Count)
		}
		total += s.Count
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if total > 0 {
			out[i].Share = float64(out[i].Count) / float64(total)
		}
	}
	return out, nil
}

// shadowStats 聚合影子路指标（仅 shadow_status 非空的样本）。
func (a *API) shadowStats(ctx context.Context, policy string, windowSec int) ([]variantStat, error) {
	rows, err := a.Pool.Query(ctx,
		`SELECT shadow_label,
		        COALESCE(max(shadow_endpoint), '') AS endpoint,
		        count(*) AS n,
		        COALESCE(avg(shadow_latency_ms), 0)::int AS avg_ms,
		        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY shadow_latency_ms), 0)::int AS p95_ms,
		        count(*) FILTER (WHERE shadow_status >= 400 OR shadow_status = 0) AS errors
		   FROM routing_samples
		  WHERE policy_name = $1 AND shadow_label <> '' AND shadow_status IS NOT NULL
		    AND created_at > now() - make_interval(secs => $2)
		  GROUP BY shadow_label
		  ORDER BY shadow_label`, policy, windowSec)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []variantStat{}
	for rows.Next() {
		var s variantStat
		var errs int64
		if err := rows.Scan(&s.Label, &s.Endpoint, &s.Count, &s.AvgMs, &s.P95Ms, &errs); err != nil {
			return nil, err
		}
		if s.Count > 0 {
			s.ErrorRate = float64(errs) / float64(s.Count)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GET /api/routing/policies —— 列出全部策略，附最近 1h 各候选份额（实时观测灰度比例）。
func (a *API) listRoutingPolicies(w http.ResponseWriter, r *http.Request) {
	rows, err := a.Pool.Query(r.Context(),
		`SELECT name, description, enabled, variants, shadow, created_by, created_at, updated_at
		   FROM routing_policies ORDER BY name`)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer rows.Close()
	policies := []map[string]any{}
	names := []string{}
	for rows.Next() {
		var p routingPolicy
		var variantsJSON, shadowJSON []byte
		if err := rows.Scan(&p.Name, &p.Description, &p.Enabled, &variantsJSON, &shadowJSON, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt); err != nil {
			a.fail(w, r, err)
			return
		}
		_ = json.Unmarshal(variantsJSON, &p.Variants)
		if len(shadowJSON) > 0 && string(shadowJSON) != "null" {
			var sh routingTarget
			if json.Unmarshal(shadowJSON, &sh) == nil && sh.Endpoint != "" {
				p.Shadow = &sh
			}
		}
		names = append(names, p.Name)
		policies = append(policies, map[string]any{
			"name": p.Name, "description": p.Description, "enabled": p.Enabled,
			"variants": p.Variants, "shadow": p.Shadow,
			"created_by": p.CreatedBy, "created_at": p.CreatedAt, "updated_at": p.UpdatedAt,
		})
	}
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}
	// 每策略最近 1h 主路指标（实时份额随机抖动靠真实样本回归到配置权重）。
	for i, name := range names {
		if vs, err := a.variantStats(r.Context(), name, 3600); err == nil {
			policies[i]["live"] = vs
		}
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"policies":       policies,
		"shadow_enabled": a.RoutingShadowEnabled,
	})
}

type routingPolicyReq struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Enabled     *bool            `json:"enabled"`
	Variants    []routingVariant `json:"variants"`
	Shadow      *routingTarget   `json:"shadow"`
	Operator    string           `json:"operator"`
}

// validateVariants 校验候选：至少一条、label 非空且唯一、endpoint 非空、weight>=0、权重和>0。
func validateVariants(vs []routingVariant) string {
	if len(vs) == 0 {
		return "at least one variant is required"
	}
	seen := map[string]bool{}
	total := 0
	for _, v := range vs {
		if strings.TrimSpace(v.Label) == "" {
			return "variant label is required"
		}
		if seen[v.Label] {
			return "duplicate variant label: " + v.Label
		}
		seen[v.Label] = true
		if strings.TrimSpace(v.Endpoint) == "" {
			return "variant endpoint is required for " + v.Label
		}
		if v.Weight < 0 {
			return "variant weight must be >= 0 for " + v.Label
		}
		total += v.Weight
	}
	if total <= 0 {
		return "sum of variant weights must be > 0"
	}
	return ""
}

// POST /api/routing/policies —— 创建策略。
func (a *API) createRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	var req routingPolicyReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		a.badRequest(w, r, "name is required")
		return
	}
	if msg := validateVariants(req.Variants); msg != "" {
		a.badRequest(w, r, msg)
		return
	}
	if req.Shadow != nil && strings.TrimSpace(req.Shadow.Endpoint) == "" {
		req.Shadow = nil
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	variantsJSON, _ := json.Marshal(req.Variants)
	shadowJSON, _ := json.Marshal(req.Shadow) // nil → "null"
	operator := a.actor(r, req.Operator)
	_, err := a.Pool.Exec(r.Context(),
		`INSERT INTO routing_policies (name, description, enabled, variants, shadow, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		req.Name, req.Description, enabled, variantsJSON, shadowJSON, operator)
	if err != nil {
		if isUniqueViolation(err) {
			WriteError(w, r, http.StatusConflict, "conflict", "routing policy already exists: "+req.Name)
			return
		}
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operator, "operator", "routing.create", "routing_policy", req.Name,
		map[string]any{"variants": len(req.Variants), "shadow": req.Shadow != nil})
	pol, _ := a.loadRoutingPolicy(r.Context(), req.Name)
	WriteJSON(w, http.StatusOK, map[string]any{"policy": pol})
}

// GET /api/routing/policies/{name} —— 策略详情 + 最近样本。
func (a *API) getRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	pol, err := a.loadRoutingPolicy(r.Context(), name)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "routing policy not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	limit := clamp(queryInt(r, "limit", 30), 1, 200)
	rows, err := a.Pool.Query(r.Context(),
		`SELECT request_id, variant_label, variant_endpoint, primary_status, primary_latency_ms,
		        shadow_label, shadow_status, shadow_latency_ms, created_at
		   FROM routing_samples WHERE policy_name = $1 ORDER BY created_at DESC LIMIT $2`, name, limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer rows.Close()
	recent := []map[string]any{}
	for rows.Next() {
		var reqID, vLabel, vEndpoint, sLabel string
		var pStatus, pLatency int
		var sStatus, sLatency *int
		var createdAt time.Time
		if err := rows.Scan(&reqID, &vLabel, &vEndpoint, &pStatus, &pLatency, &sLabel, &sStatus, &sLatency, &createdAt); err != nil {
			a.fail(w, r, err)
			return
		}
		recent = append(recent, map[string]any{
			"request_id": reqID, "variant_label": vLabel, "variant_endpoint": vEndpoint,
			"primary_status": pStatus, "primary_latency_ms": pLatency,
			"shadow_label": sLabel, "shadow_status": sStatus, "shadow_latency_ms": sLatency,
			"created_at": createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"policy": pol, "recent": recent})
}

// PATCH /api/routing/policies/{name} —— 更新描述/开关/候选权重/影子。
func (a *API) updateRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	cur, err := a.loadRoutingPolicy(r.Context(), name)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "routing policy not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	var req routingPolicyReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	if req.Variants != nil {
		if msg := validateVariants(req.Variants); msg != "" {
			a.badRequest(w, r, msg)
			return
		}
		cur.Variants = req.Variants
	}
	// PATCH 走全量更新（前端总携全字段）：描述/开关按传入值覆盖。
	cur.Description = req.Description
	if req.Enabled != nil {
		cur.Enabled = *req.Enabled
	}
	if req.Shadow != nil {
		if strings.TrimSpace(req.Shadow.Endpoint) == "" {
			cur.Shadow = nil
		} else {
			cur.Shadow = req.Shadow
		}
	}
	variantsJSON, _ := json.Marshal(cur.Variants)
	shadowJSON, _ := json.Marshal(cur.Shadow)
	operator := a.actor(r, req.Operator)
	_, err = a.Pool.Exec(r.Context(),
		`UPDATE routing_policies SET description=$2, enabled=$3, variants=$4, shadow=$5, updated_at=now()
		   WHERE name=$1`, name, cur.Description, cur.Enabled, variantsJSON, shadowJSON)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operator, "operator", "routing.update", "routing_policy", name,
		map[string]any{"enabled": cur.Enabled, "variants": len(cur.Variants), "shadow": cur.Shadow != nil})
	pol, _ := a.loadRoutingPolicy(r.Context(), name)
	WriteJSON(w, http.StatusOK, map[string]any{"policy": pol})
}

// DELETE /api/routing/policies/{name} —— 删除策略（样本保留供回溯）。
func (a *API) deleteRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	tag, err := a.Pool.Exec(r.Context(), `DELETE FROM routing_policies WHERE name=$1`, name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		WriteError(w, r, http.StatusNotFound, "not_found", "routing policy not found")
		return
	}
	a.Store.Audit(r.Context(), a.actor(r, ""), "operator", "routing.delete", "routing_policy", name, map[string]any{})
	WriteJSON(w, http.StatusOK, map[string]any{"name": name, "deleted": true})
}

// GET /api/routing/policies/{name}/stats?window=3600 —— A/B 对比聚合（主路各候选 + 影子）。
func (a *API) routingPolicyStats(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	window := clamp(queryInt(r, "window", 3600), 60, 7*24*3600)
	variants, err := a.variantStats(r.Context(), name, window)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	shadow, err := a.shadowStats(r.Context(), name, window)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"window": window, "variants": variants, "shadow": shadow,
	})
}

type promoteReq struct {
	Label    string `json:"label"`
	Operator string `json:"operator"`
}

// POST /api/routing/policies/{name}/promote —— 灰度全量：把指定候选权重设为 100、其余 0，
// 旧权重快照进 metadata.prev_variants 供回滚（与 A1 发布、C1 版本联动的「全量」动作）。
func (a *API) promoteRoutingVariant(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var req promoteReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	if strings.TrimSpace(req.Label) == "" {
		a.badRequest(w, r, "label is required")
		return
	}
	cur, err := a.loadRoutingPolicy(r.Context(), name)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "routing policy not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	found := false
	next := make([]routingVariant, len(cur.Variants))
	for i, v := range cur.Variants {
		if v.Label == req.Label {
			v.Weight = 100
			found = true
		} else {
			v.Weight = 0
		}
		next[i] = v
	}
	if !found {
		a.badRequest(w, r, "no such variant: "+req.Label)
		return
	}
	prevJSON, _ := json.Marshal(cur.Variants)
	nextJSON, _ := json.Marshal(next)
	operator := a.actor(r, req.Operator)
	_, err = a.Pool.Exec(r.Context(),
		`UPDATE routing_policies
		    SET variants=$2, metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb), '{prev_variants}', $3::jsonb), updated_at=now()
		  WHERE name=$1`, name, nextJSON, prevJSON)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operator, "operator", "routing.promote", "routing_policy", name,
		map[string]any{"label": req.Label})
	pol, _ := a.loadRoutingPolicy(r.Context(), name)
	WriteJSON(w, http.StatusOK, map[string]any{"policy": pol, "promoted": req.Label})
}

// POST /api/routing/policies/{name}/rollback —— 回滚到全量前的权重快照（metadata.prev_variants）。
func (a *API) rollbackRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var req struct {
		Operator string `json:"operator"`
	}
	_ = decodeBody(r, &req)
	var prevJSON []byte
	err := a.Pool.QueryRow(r.Context(),
		`SELECT metadata->'prev_variants' FROM routing_policies WHERE name=$1`, name).Scan(&prevJSON)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "routing policy not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	if len(prevJSON) == 0 || string(prevJSON) == "null" {
		a.badRequest(w, r, "no previous weights to roll back to")
		return
	}
	var prev []routingVariant
	if json.Unmarshal(prevJSON, &prev) != nil || validateVariants(prev) != "" {
		a.badRequest(w, r, "stored previous weights are invalid")
		return
	}
	restoreJSON, _ := json.Marshal(prev)
	operator := a.actor(r, req.Operator)
	_, err = a.Pool.Exec(r.Context(),
		`UPDATE routing_policies
		    SET variants=$2, metadata=(COALESCE(metadata,'{}'::jsonb) - 'prev_variants'), updated_at=now()
		  WHERE name=$1`, name, restoreJSON)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operator, "operator", "routing.rollback", "routing_policy", name, map[string]any{})
	pol, _ := a.loadRoutingPolicy(r.Context(), name)
	WriteJSON(w, http.StatusOK, map[string]any{"policy": pol, "rolled_back": true})
}
