package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/aiclient"
	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 集成测试（需 pgvector TEST_DATABASE_URL）：建会话 → messages:stream（mock embed + mock vLLM SSE）
// → 校验 retrieval/route/token/done 事件 + 会话消息（user+assistant）+ 反馈。
func TestChatStreamFlow(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL (pgvector) to run chat test")
	}
	ctx := context.Background()
	if err := db.Migrate(config.Config{DatabaseURL: url}.MigrateURL()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// mock embed.
	embedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Texts []string `json:"texts"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		embs := make([][]float32, len(req.Texts))
		for i, tx := range req.Texts {
			embs[i] = mockEmbedVec(tx)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"embeddings": embs, "dim": 1024, "mode": "stub"})
	}))
	defer embedSrv.Close()

	// mock vLLM SSE chat/completions.
	vllm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.Error(w, "bad path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"退款\"}}]}\n\n")
		if fl != nil {
			fl.Flush()
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"政策说明\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer vllm.Close()

	a := &API{Pool: pool, Store: store.New(pool), AI: aiclient.New(embedSrv.URL, 10*time.Second)}

	// 一篇 kb 文档（让检索非空 → 走 LLM 路径而非 no_retrieval 兜底）。
	_ = a.Store.UpsertDocument(ctx, store.Document{DocID: "chat-doc-1", Title: "退款", Content: "退款政策", Category: "benchmark", Version: "default"})
	_ = a.Store.ReplaceChunks(ctx, "chat-doc-1", "default", []store.Chunk{{Ordinal: 0, Text: "退款政策", Embedding: mockEmbedVec("退款政策")}})
	defer pool.Exec(ctx, `DELETE FROM kb_chunks WHERE doc_id='chat-doc-1'`)
	defer pool.Exec(ctx, `DELETE FROM kb_documents WHERE doc_id='chat-doc-1'`)

	// mock-llm 端点指向 mock vLLM。
	_, _ = pool.Exec(ctx,
		`INSERT INTO service_instances (name, base_url, model_id, kind, routing_role, status)
		 VALUES ('mock-llm', $1, 'qwen3-4b-platform', 'vllm', 'replica', 'healthy')
		 ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url, status='healthy'`, vllm.URL+"/v1")
	defer pool.Exec(ctx, `DELETE FROM service_instances WHERE name='mock-llm'`)

	rt := chi.NewRouter()
	rt.Route("/api/chat", func(r chi.Router) {
		r.Post("/sessions", a.createChatSession)
		r.Get("/sessions/{session_id}", a.getChatSession)
		r.Post("/sessions/{session_id}/messages:stream", a.streamChatMessage)
		r.Post("/messages/{message_id}/feedback", a.createMessageFeedback)
	})

	// 建会话。
	cs := httptest.NewRecorder()
	rt.ServeHTTP(cs, httptest.NewRequest(http.MethodPost, "/api/chat/sessions", strings.NewReader(`{"title":"t","user_role":"customer"}`)))
	if cs.Code != http.StatusOK {
		t.Fatalf("create session %d: %s", cs.Code, cs.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(cs.Body.Bytes(), &session)
	if session.SessionID == "" {
		t.Fatal("no session_id")
	}
	defer pool.Exec(ctx, `DELETE FROM chat_sessions WHERE session_id=$1`, session.SessionID)

	// messages:stream（endpoint_id=mock-llm → 走 LLM 路径）。
	sr := httptest.NewRecorder()
	body := `{"content":"退款规则是什么","endpoint_id":"mock-llm"}`
	rt.ServeHTTP(sr, httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+session.SessionID+"/messages:stream", strings.NewReader(body)))
	if sr.Code != http.StatusOK {
		t.Fatalf("stream status %d: %s", sr.Code, sr.Body.String())
	}
	sse := sr.Body.String()
	for _, ev := range []string{"event: retrieval", "event: route", "event: token", "event: citation", "event: done"} {
		if !strings.Contains(sse, ev) {
			t.Fatalf("SSE missing %q:\n%s", ev, sse)
		}
	}
	if !strings.Contains(sse, "退款") {
		t.Fatalf("SSE missing streamed token text:\n%s", sse)
	}

	// 会话含 user + assistant，assistant 文本 = 上游流式拼接。
	gs := httptest.NewRecorder()
	rt.ServeHTTP(gs, httptest.NewRequest(http.MethodGet, "/api/chat/sessions/"+session.SessionID, nil))
	var got struct {
		Messages []struct {
			MessageID string `json:"message_id"`
			Role      string `json:"role"`
			Content   string `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(gs.Body.Bytes(), &got)
	if len(got.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d: %s", len(got.Messages), gs.Body.String())
	}
	var assistantID, assistantContent string
	for _, m := range got.Messages {
		if m.Role == "assistant" {
			assistantID, assistantContent = m.MessageID, m.Content
		}
	}
	if assistantContent != "退款政策说明" {
		t.Fatalf("assistant content = %q, want 退款政策说明", assistantContent)
	}

	// 反馈。
	fb := httptest.NewRecorder()
	rt.ServeHTTP(fb, httptest.NewRequest(http.MethodPost, "/api/chat/messages/"+assistantID+"/feedback", strings.NewReader(`{"rating":"up","note":"good"}`)))
	if fb.Code != http.StatusOK || !strings.Contains(fb.Body.String(), "feedback_id") {
		t.Fatalf("feedback failed: %d %s", fb.Code, fb.Body.String())
	}
	defer pool.Exec(ctx, `DELETE FROM chat_message_feedback WHERE message_id=$1`, assistantID)
}
