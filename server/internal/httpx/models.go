package httpx

import (
	"net/http"
	"sort"
)

// 6A：models 组绞杀——Go 原生 GET /api/models（复刻 legacy src/api list_models 契约）。
// legacy：SELECT name, model_id, kind, status FROM service_instances ORDER BY name；
// 返回 {models:[{model_id}], service_instances:[{name,model_id,kind,status}]}，model_id 去重排序。
func (a *API) models(w http.ResponseWriter, r *http.Request) {
	rows, err := a.Pool.Query(r.Context(),
		`SELECT name, model_id, kind, status FROM service_instances ORDER BY name`)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer rows.Close()

	instances := []map[string]any{}
	idSet := map[string]struct{}{}
	for rows.Next() {
		var name, kind, status string
		var modelID *string
		if err := rows.Scan(&name, &modelID, &kind, &status); err != nil {
			a.fail(w, r, err)
			return
		}
		instances = append(instances, map[string]any{
			"name": name, "model_id": modelID, "kind": kind, "status": status,
		})
		if modelID != nil && *modelID != "" {
			idSet[*modelID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}

	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	models := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		models = append(models, map[string]any{"model_id": id})
	}
	WriteJSON(w, http.StatusOK, map[string]any{"models": models, "service_instances": instances})
}
