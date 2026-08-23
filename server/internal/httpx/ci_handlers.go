package httpx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var githubHTTPClient = &http.Client{Timeout: 15 * time.Second}

func (a *API) githubActionsConfigured() bool {
	return strings.TrimSpace(a.GitHubRepository) != "" && strings.TrimSpace(a.GitHubToken) != "" && strings.TrimSpace(a.GitHubWorkflow) != ""
}

func (a *API) githubRequest(r *http.Request, method, path string, body any) (*http.Response, error) {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	req, err := http.NewRequestWithContext(r.Context(), method, "https://api.github.com"+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+a.GitHubToken)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return githubHTTPClient.Do(req)
}

func (a *API) ciRuns(w http.ResponseWriter, r *http.Request) {
	if !a.githubActionsConfigured() {
		WriteJSON(w, http.StatusOK, map[string]any{"configured": false, "provider": "github_actions", "runs": []any{},
			"message": "Set GITHUB_REPOSITORY, GITHUB_TOKEN and optionally GITHUB_WORKFLOW_FILE to connect CI."})
		return
	}
	path := fmt.Sprintf("/repos/%s/actions/workflows/%s/runs?per_page=%d", a.GitHubRepository, url.PathEscape(a.GitHubWorkflow), clamp(queryInt(r, "limit", 10), 1, 50))
	resp, err := a.githubRequest(r, http.MethodGet, path, nil)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "ci_provider_unavailable", err.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		WriteError(w, r, http.StatusBadGateway, "ci_provider_error", fmt.Sprintf("GitHub Actions returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))))
		return
	}
	var payload struct {
		Runs []map[string]any `json:"workflow_runs"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		a.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"configured": true, "provider": "github_actions", "repository": a.GitHubRepository, "workflow": a.GitHubWorkflow, "runs": payload.Runs})
}

func (a *API) triggerCIRun(w http.ResponseWriter, r *http.Request) {
	if !a.githubActionsConfigured() {
		WriteError(w, r, http.StatusServiceUnavailable, "ci_not_configured", "GitHub Actions integration is not configured")
		return
	}
	var input struct {
		Ref      string            `json:"ref"`
		Inputs   map[string]string `json:"inputs"`
		Operator string            `json:"operator"`
	}
	if err := decodeBody(r, &input); err != nil {
		a.badRequest(w, r, "invalid body")
		return
	}
	input.Ref = orDefault(strings.TrimSpace(input.Ref), "main")
	path := fmt.Sprintf("/repos/%s/actions/workflows/%s/dispatches", a.GitHubRepository, url.PathEscape(a.GitHubWorkflow))
	payload := map[string]any{"ref": input.Ref}
	if len(input.Inputs) > 0 {
		payload["inputs"] = input.Inputs
	}
	resp, err := a.githubRequest(r, http.MethodPost, path, payload)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "ci_provider_unavailable", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		WriteError(w, r, http.StatusBadGateway, "ci_dispatch_failed", fmt.Sprintf("GitHub Actions returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))))
		return
	}
	operator := a.actor(r, input.Operator)
	a.Store.Audit(r.Context(), operator, "operator", "ci.run.trigger", "repository", a.GitHubRepository,
		map[string]any{"workflow": a.GitHubWorkflow, "ref": input.Ref, "inputs": input.Inputs})
	_ = a.recordPlatformLog(r.Context(), platformLogInput{Level: "info", Source: "github-actions", ResourceType: "repository", ResourceID: a.GitHubRepository,
		Message: "CI workflow dispatched", Attributes: map[string]any{"workflow": a.GitHubWorkflow, "ref": input.Ref}})
	WriteJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "provider": "github_actions", "repository": a.GitHubRepository, "workflow": a.GitHubWorkflow, "ref": input.Ref})
}
