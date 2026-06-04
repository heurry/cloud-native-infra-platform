package httpx

import (
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
)

// isUniqueViolation 判定 Postgres 唯一约束冲突（23505），用于把重复注册映射成 409。
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// C1：独立模型注册中心（model registry）。
// 把「/models 派生自 service_instances」升级为版本化模型台账：版本 / 血缘(parent_version) /
// 基座+LoRA / 产物(MinIO) / 标签 / 状态，并按 model_id 与运行实例(service_instances)关联。

const maxArtifactBytes = 512 << 20 // 512 MiB：LoRA 适配器/小权重产物上限

var modelStatuses = map[string]bool{"registered": true, "active": true, "deprecated": true}

// binding 是某 model_id 当前的运行时绑定（来自 service_instances）。
type binding struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Status  string  `json:"status"`
	BaseURL string  `json:"base_url"`
	GpuID   *string `json:"gpu_id"`
}

// bindingsByModelID 读取 service_instances，按 model_id 聚合运行时绑定（运行时绑定 tab 的真实数据）。
func (a *API) bindingsByModelID(r *http.Request) (map[string][]binding, error) {
	rows, err := a.Pool.Query(r.Context(),
		`SELECT name, model_id, kind, status, base_url, gpu_id FROM service_instances WHERE model_id IS NOT NULL ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]binding{}
	for rows.Next() {
		var name, kind, status, baseURL string
		var modelID, gpuID *string
		if err := rows.Scan(&name, &modelID, &kind, &status, &baseURL, &gpuID); err != nil {
			return nil, err
		}
		if modelID == nil || *modelID == "" {
			continue
		}
		out[*modelID] = append(out[*modelID], binding{Name: name, Kind: kind, Status: status, BaseURL: baseURL, GpuID: gpuID})
	}
	return out, rows.Err()
}

// GET /api/models/registry —— 列出全部注册版本 + 按 model_id 的运行时绑定。
func (a *API) listModelRegistry(w http.ResponseWriter, r *http.Request) {
	versions, err := a.Store.ListModelVersions(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	bindings, err := a.bindingsByModelID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"versions": mapSlice(versions, toModelVersionDTO),
		"bindings": bindings,
	})
}

type registerModelReq struct {
	ModelID       string   `json:"model_id"`
	Version       string   `json:"version"`
	BaseModel     string   `json:"base_model"`
	LoraAdapter   string   `json:"lora_adapter"`
	ParentVersion string   `json:"parent_version"`
	ArtifactURI   string   `json:"artifact_uri"`
	Tags          []string `json:"tags"`
	Status        string   `json:"status"`
	Operator      string   `json:"operator"`
}

// POST /api/models/registry —— 注册一个模型版本。
func (a *API) registerModelVersion(w http.ResponseWriter, r *http.Request) {
	var req registerModelReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	req.ModelID = strings.TrimSpace(req.ModelID)
	req.Version = strings.TrimSpace(req.Version)
	if req.ModelID == "" || req.Version == "" {
		a.badRequest(w, r, "model_id and version are required")
		return
	}
	status := orDefault(req.Status, "registered")
	if !modelStatuses[status] {
		a.badRequest(w, r, "status must be registered|active|deprecated")
		return
	}
	operator := orDefault(req.Operator, defaultOperator)
	id, err := a.Store.RegisterModelVersion(r.Context(), store.RegisterModelParams{
		ModelID:       req.ModelID,
		Version:       req.Version,
		BaseModel:     nilIfEmpty(req.BaseModel),
		LoraAdapter:   nilIfEmpty(req.LoraAdapter),
		ParentVersion: nilIfEmpty(req.ParentVersion),
		ArtifactURI:   nilIfEmpty(req.ArtifactURI),
		Tags:          req.Tags,
		Status:        status,
		CreatedBy:     operator,
	})
	if err != nil {
		if isUniqueViolation(err) {
			WriteError(w, r, http.StatusConflict, "conflict", fmt.Sprintf("model %s version %s already registered", req.ModelID, req.Version))
			return
		}
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), operator, "operator", "model.register", "model", req.ModelID+":"+req.Version,
		map[string]any{"version": req.Version, "base_model": req.BaseModel, "parent_version": req.ParentVersion})
	WriteJSON(w, http.StatusOK, map[string]any{"id": id, "model_id": req.ModelID, "version": req.Version, "status": status})
}

// GET /api/models/registry/{id} —— 版本详情 + 血缘链 + 运行时绑定。
func (a *API) getModelVersion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	mv, err := a.Store.GetModelVersion(r.Context(), id)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "model version not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	lineage := a.lineageChain(r, mv)
	bindings, err := a.bindingsByModelID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"model":           toModelVersionDTO(mv),
		"lineage":         mapSlice(lineage, toModelVersionDTO),
		"bound_instances": bindings[mv.ModelID],
	})
}

// lineageChain 从当前版本的 parent_version 沿同 model_id 向上回溯，返回祖先链（近→远）。
func (a *API) lineageChain(r *http.Request, mv store.ModelVersion) []store.ModelVersion {
	chain := []store.ModelVersion{}
	if mv.ParentVersion == nil || *mv.ParentVersion == "" {
		return chain
	}
	siblings, err := a.Store.VersionsByModelID(r.Context(), mv.ModelID)
	if err != nil {
		return chain
	}
	byVersion := make(map[string]store.ModelVersion, len(siblings))
	for _, s := range siblings {
		byVersion[s.Version] = s
	}
	seen := map[string]bool{mv.Version: true}
	cur := *mv.ParentVersion
	for cur != "" && !seen[cur] {
		seen[cur] = true
		parent, ok := byVersion[cur]
		if !ok {
			break
		}
		chain = append(chain, parent)
		if parent.ParentVersion == nil {
			break
		}
		cur = *parent.ParentVersion
	}
	return chain
}

type updateModelStatusReq struct {
	Status   string `json:"status"`
	Operator string `json:"operator"`
}

// PATCH /api/models/registry/{id}/status —— 改版本状态（registered/active/deprecated）。
func (a *API) updateModelStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req updateModelStatusReq
	if err := decodeBody(r, &req); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	if !modelStatuses[req.Status] {
		a.badRequest(w, r, "status must be registered|active|deprecated")
		return
	}
	modelID, version, err := a.Store.UpdateModelStatus(r.Context(), id, req.Status)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "model version not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	operator := orDefault(req.Operator, defaultOperator)
	a.Store.Audit(r.Context(), operator, "operator", "model.status", "model", modelID+":"+version,
		map[string]any{"status": req.Status})
	WriteJSON(w, http.StatusOK, map[string]any{"id": id, "model_id": modelID, "version": version, "status": req.Status})
}

// DELETE /api/models/registry/{id} —— 注销一个版本。
func (a *API) deleteModelVersion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	modelID, version, err := a.Store.DeleteModelVersion(r.Context(), id)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "model version not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), defaultOperator, "operator", "model.delete", "model", modelID+":"+version, map[string]any{})
	WriteJSON(w, http.StatusOK, map[string]any{"id": id, "model_id": modelID, "version": version, "deleted": true})
}

// POST /api/models/registry/{id}/artifact —— 上传产物到 MinIO，回填 artifact_uri（key）。
func (a *API) uploadModelArtifact(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if a.Blob == nil || !a.Blob.Enabled() {
		WriteError(w, r, http.StatusServiceUnavailable, "blob_disabled", "object storage not configured")
		return
	}
	mv, err := a.Store.GetModelVersion(r.Context(), id)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "model version not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxArtifactBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		a.badRequest(w, r, "artifact too large or invalid multipart body")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		a.badRequest(w, r, "multipart field 'file' is required")
		return
	}
	defer file.Close()

	key := fmt.Sprintf("models/%s/%s/%s", mv.ModelID, mv.Version, path.Base(header.Filename))
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	storedKey, err := a.Blob.Put(r.Context(), key, file, header.Size, contentType)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.Store.SetModelArtifact(r.Context(), id, storedKey); err != nil {
		a.fail(w, r, err)
		return
	}
	a.Store.Audit(r.Context(), defaultOperator, "operator", "model.artifact.upload", "model", mv.ModelID+":"+mv.Version,
		map[string]any{"key": storedKey, "size": header.Size})
	WriteJSON(w, http.StatusOK, map[string]any{"id": id, "artifact_uri": storedKey, "size": header.Size})
}

// GET /api/models/registry/{id}/artifact —— 返回产物下载地址（MinIO key → 预签名 URL；外部 URL 原样返回）。
func (a *API) modelArtifactURL(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	mv, err := a.Store.GetModelVersion(r.Context(), id)
	if err != nil {
		if isNoRows(err) {
			WriteError(w, r, http.StatusNotFound, "not_found", "model version not found")
			return
		}
		a.fail(w, r, err)
		return
	}
	if mv.ArtifactURI == nil || *mv.ArtifactURI == "" {
		WriteError(w, r, http.StatusNotFound, "not_found", "no artifact for this version")
		return
	}
	uri := *mv.ArtifactURI
	if strings.Contains(uri, "://") {
		// 外部 URL（注册时手填）：原样返回。
		WriteJSON(w, http.StatusOK, map[string]any{"download_url": uri, "external": true})
		return
	}
	if a.Blob == nil || !a.Blob.Enabled() {
		WriteJSON(w, http.StatusOK, map[string]any{"key": uri, "download_url": nil, "note": "object storage disabled"})
		return
	}
	url, err := a.Blob.PresignedGet(r.Context(), uri)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"download_url": url, "key": uri})
}
