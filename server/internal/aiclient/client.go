// Package aiclient 是 Go 控制面调用 Python AI 服务（FastAPI）的客户端。
// 边界（Phase 3 D4）：Go 取证打包 evidence → 本客户端 POST /internal/diagnose →
// Python 做 RAG+LLM 推理出结构化 JSON → Go 落库+审计。错误分三类，便于 handler 分流状态码。
package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// 错误分类：handler 据此区分「上游不可达/超时」(502) 与「上游返回非 2xx 或坏响应」。
var (
	ErrUnreachable  = errors.New("ai service unreachable")
	ErrBadStatus    = errors.New("ai service returned error status")
	ErrBadResponse  = errors.New("ai service returned malformed response")
	maxResponseSize = int64(1 << 20) // 1 MiB，防止异常大响应撑爆内存
)

type Client struct {
	base string
	http *http.Client
}

// New 构建客户端；timeout<=0 时取 60s（诊断含 LLM 推理，比普通调用宽）。
func New(base string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Client{
		base: strings.TrimRight(base, "/"),
		http: &http.Client{Timeout: timeout},
	}
}

// DiagnoseOptions 透传给 Python 的推理参数（可空，Python 侧有默认值）。
type DiagnoseOptions struct {
	MaxTokens   int     `json:"max_tokens,omitempty"`
	Temperature float64 `json:"temperature,omitempty"`
}

// DiagnoseRequest 是发往 /internal/diagnose 的契约：问题 + Go 聚合的证据 bundle。
// Evidence 用 any（handler 传 map），整体一次性 marshal。
type DiagnoseRequest struct {
	Question string           `json:"question"`
	Evidence any              `json:"evidence"`
	Options  *DiagnoseOptions `json:"options,omitempty"`
}

// DiagnoseResult 是 Python 返回的结构化诊断。
// 三个 JSON 数组（Evidence/RecommendedActions/RelatedResources）保留为 RawMessage：
// Go 不重建嵌套结构，直接作为 JSONB 落库，由 Python 拥有「结构化外形」，边界更稳。
type DiagnoseResult struct {
	Status             string          `json:"status"` // completed / failed
	RootCause          string          `json:"root_cause"`
	Confidence         *float64        `json:"confidence"`
	Impact             string          `json:"impact"`
	Evidence           json.RawMessage `json:"evidence"`
	RecommendedActions json.RawMessage `json:"recommended_actions"`
	RelatedResources   json.RawMessage `json:"related_resources"`
	ModelID            string          `json:"model_id"`
	EndpointID         string          `json:"endpoint_id"`
	LatencyMs          *float64        `json:"latency_ms"`
	Mode               string          `json:"mode"` // stub / live —— 便于排查无 GPU 时为何是假响应
	Error              string          `json:"error"`
}

// Diagnose 调 Python 推理。任何网络/超时归 ErrUnreachable；非 2xx 归 ErrBadStatus；
// 解析失败归 ErrBadResponse。ctx 取消会传导到底层请求。
func (c *Client) Diagnose(ctx context.Context, req DiagnoseRequest) (*DiagnoseResult, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal diagnose request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/internal/diagnose", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize))
	if err != nil {
		return nil, fmt.Errorf("%w: read body: %v", ErrBadResponse, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: status %d: %s", ErrBadStatus, resp.StatusCode, truncate(data, 300))
	}

	var out DiagnoseResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadResponse, err)
	}
	return &out, nil
}

// EmbedRequest / EmbedResult 对齐 ai-service /internal/embed（5B.4c）。
type embedRequest struct {
	Texts   []string `json:"texts"`
	IsQuery bool     `json:"is_query"`
}

type embedResult struct {
	Embeddings [][]float32 `json:"embeddings"`
	Model      string      `json:"model"`
	Dim        int         `json:"dim"`
	Mode       string      `json:"mode"`
}

// Embed 调 Python /internal/embed 取文本嵌入（is_query=true 时查询侧加 Qwen3 指令前缀）。
// 错误分类同 Diagnose。向量响应可较大，单独放宽读取上限。
func (c *Client) Embed(ctx context.Context, texts []string, isQuery bool) ([][]float32, error) {
	body, err := json.Marshal(embedRequest{Texts: texts, IsQuery: isQuery})
	if err != nil {
		return nil, fmt.Errorf("marshal embed request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/internal/embed", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20)) // 32 MiB：批量向量可观
	if err != nil {
		return nil, fmt.Errorf("%w: read body: %v", ErrBadResponse, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: status %d: %s", ErrBadStatus, resp.StatusCode, truncate(data, 300))
	}
	var out embedResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadResponse, err)
	}
	return out.Embeddings, nil
}

// BaseURL 暴露给反向代理（httpx/proxy.go）拼上游地址。
func (c *Client) BaseURL() string { return c.base }

func truncate(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
