// Package agentcli 是 Go 控制面访问 Go Node Agent 的客户端（对应 Java AgentClient）。
// 不可达 / 出错时返回降级结构 {available:false, error, pods/deployments/events:[]}，不抛错。
package agentcli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

type Client struct {
	base string
	http *http.Client
}

func New(base string) *Client {
	return &Client{base: base, http: &http.Client{Timeout: 5 * time.Second}}
}

// FetchObject 拉取并解析 agent 某路径为对象；任何失败都返回降级对象（与 Java fetch 一致）。
func (c *Client) FetchObject(ctx context.Context, path string) map[string]any {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return degraded()
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return degraded()
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return degraded()
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return degraded()
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil || m == nil {
		return degraded()
	}
	return m
}

func degraded() map[string]any {
	return map[string]any{
		"available":   false,
		"error":       "agent unreachable",
		"pods":        []any{},
		"deployments": []any{},
		"events":      []any{},
	}
}
