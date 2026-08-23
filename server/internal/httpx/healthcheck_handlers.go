package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const healthProbeTimeout = 5 * time.Second

// serviceInstanceHealthcheck performs a real active probe. Model-serving
// endpoints use the OpenAI-compatible models endpoint; ordinary services use
// healthz/health. A metadata.health_path value overrides these defaults.
func (a *API) serviceInstanceHealthcheck(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	row, err := a.fetchInstance(r.Context(), name)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if row == nil {
		WriteError(w, r, http.StatusNotFound, "not_found", "service instance not found")
		return
	}

	target := row
	if row.Kind == "auto_router" || row.Kind == "client_round_robin" || row.RoutingRole == "auto_router" || row.RoutingRole == "client_round_robin" {
		resolved, _, resolveErr := a.resolveEndpoint(r.Context(), row.Name)
		if resolveErr != nil {
			a.persistHealthResult(r.Context(), row.Name, "unreachable", 0, "", resolveErr.Error())
			WriteJSON(w, http.StatusOK, map[string]any{"name": name, "status": "unreachable", "detail": resolveErr.Error()})
			return
		}
		target = &instanceRow{Name: resolved.TargetPod, BaseURL: resolved.BaseURL, ModelID: resolved.ModelID, Kind: "vllm"}
	}

	paths := healthPaths(target)
	started := time.Now()
	probeURL, code, detail, probeErr := probeService(r.Context(), target.BaseURL, paths)
	latencyMs := float64(time.Since(started).Microseconds()) / 1000
	status := "healthy"
	if probeErr != nil {
		status = "unreachable"
		detail = probeErr.Error()
	}
	if err := a.persistHealthResult(r.Context(), row.Name, status, latencyMs, probeURL, detail); err != nil {
		a.fail(w, r, err)
		return
	}
	level := "info"
	if status != "healthy" {
		level = "error"
	}
	_ = a.recordPlatformLog(r.Context(), platformLogInput{
		Level: level, Source: "healthcheck", ResourceType: "service_instance", ResourceID: name,
		Message:    status + ": " + orDefault(detail, probeURL),
		Attributes: map[string]any{"target": target.Name, "url": probeURL, "http_status": code, "latency_ms": latencyMs},
	})
	operator := a.actor(r, "")
	a.Store.Audit(r.Context(), operator, "operator", "service.healthcheck", "service_instance", name, map[string]any{
		"status": status, "target": target.Name, "url": probeURL, "http_status": code, "latency_ms": latencyMs, "detail": detail,
	})
	WriteJSON(w, http.StatusOK, map[string]any{
		"name": name, "target": target.Name, "status": status, "url": probeURL,
		"http_status": code, "latency_ms": latencyMs, "detail": detail,
	})
}

func healthPaths(row *instanceRow) []string {
	var metadata map[string]any
	_ = json.Unmarshal(row.Metadata, &metadata)
	if path, _ := metadata["health_path"].(string); strings.TrimSpace(path) != "" {
		return []string{path}
	}
	kind := strings.ToLower(row.Kind + " " + row.RoutingRole)
	if strings.Contains(kind, "vllm") || strings.Contains(kind, "model") || strings.Contains(kind, "aibrix") || row.ModelID != "" {
		return []string{"/v1/models", "/health", "/healthz"}
	}
	return []string{"/healthz", "/health", "/readyz"}
}

func probeService(ctx context.Context, baseURL string, paths []string) (string, int, string, error) {
	client := &http.Client{Timeout: healthProbeTimeout}
	root := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if strings.HasSuffix(root, "/v1") {
		root = strings.TrimSuffix(root, "/v1")
	}
	var lastErr error
	for _, path := range paths {
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		url := root + path
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		detail := strings.TrimSpace(string(raw))
		if resp.StatusCode >= 200 && resp.StatusCode < 400 {
			return url, resp.StatusCode, detail, nil
		}
		lastErr = fmt.Errorf("%s returned HTTP %d", url, resp.StatusCode)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no health probe path configured")
	}
	return "", 0, "", lastErr
}

func (a *API) persistHealthResult(ctx context.Context, name, status string, latencyMs float64, url, detail string) error {
	meta, _ := json.Marshal(map[string]any{
		"healthcheck": map[string]any{
			"status": status, "latency_ms": latencyMs, "url": url, "detail": detail,
			"checked_at": time.Now().UTC().Format(time.RFC3339Nano),
		},
	})
	_, err := a.Pool.Exec(ctx, `UPDATE service_instances
		SET status=$2, last_checked_at=now(), updated_at=now(), metadata=metadata || $3::jsonb
		WHERE name=$1`, name, status, meta)
	return err
}
