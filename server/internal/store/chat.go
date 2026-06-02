package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func isNoRowsErr(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// 客服对话领域层（6A chat 绞杀）：会话 / 消息 / 反馈，走 hand-pgx（chat_* 表，000008）。

// ChatSession 是一次客服会话。
type ChatSession struct {
	SessionID string
	Title     *string
	UserRole  string
	Kind      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ChatMessage 是会话中的一条消息。
type ChatMessage struct {
	MessageID string
	SessionID string
	Role      string
	Content   string
	Metadata  map[string]any
	CreatedAt time.Time
}

// CreateChatSession 新建会话，返回 session_id。
func (s *Store) CreateChatSession(ctx context.Context, title, userRole string) (string, error) {
	if userRole == "" {
		userRole = "customer"
	}
	sessionID := uuid.NewString()
	var t *string
	if title != "" {
		t = &title
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO chat_sessions (session_id, title, user_role) VALUES ($1, $2, $3)`,
		sessionID, t, userRole)
	return sessionID, err
}

// ListChatSessions 列会话（按 updated_at 倒序）。
func (s *Store) ListChatSessions(ctx context.Context, limit int) ([]ChatSession, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT session_id, title, user_role, kind, created_at, updated_at
		  FROM chat_sessions ORDER BY updated_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChatSession{}
	for rows.Next() {
		var c ChatSession
		if err := rows.Scan(&c.SessionID, &c.Title, &c.UserRole, &c.Kind, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetChatSession 取会话（不存在返回 nil, nil）。
func (s *Store) GetChatSession(ctx context.Context, sessionID string) (*ChatSession, error) {
	var c ChatSession
	err := s.pool.QueryRow(ctx, `
		SELECT session_id, title, user_role, kind, created_at, updated_at
		  FROM chat_sessions WHERE session_id = $1`, sessionID).
		Scan(&c.SessionID, &c.Title, &c.UserRole, &c.Kind, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		if isNoRowsErr(err) {
			return nil, nil
		}
		return nil, err
	}
	return &c, nil
}

// ListChatMessages 取会话全部消息（按时间正序）。
func (s *Store) ListChatMessages(ctx context.Context, sessionID string) ([]ChatMessage, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT message_id, role, content, metadata, created_at
		  FROM chat_messages WHERE session_id = $1 ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows, sessionID)
}

// FetchMemory 取会话最近 limit 条消息（按时间正序），用于记忆感知检索/提示。
func (s *Store) FetchMemory(ctx context.Context, sessionID string, limit int) ([]ChatMessage, error) {
	if limit <= 0 {
		limit = 8
	}
	rows, err := s.pool.Query(ctx, `
		SELECT message_id, role, content, metadata, created_at FROM (
			SELECT message_id, role, content, metadata, created_at
			  FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2
		) t ORDER BY created_at`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows, sessionID)
}

func scanMessages(rows pgx.Rows, sessionID string) ([]ChatMessage, error) {
	out := []ChatMessage{}
	for rows.Next() {
		var m ChatMessage
		var meta []byte
		if err := rows.Scan(&m.MessageID, &m.Role, &m.Content, &meta, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.SessionID = sessionID
		if len(meta) > 0 {
			_ = json.Unmarshal(meta, &m.Metadata)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// InsertChatMessage 插入一条消息并刷新会话 updated_at，返回 message_id。
func (s *Store) InsertChatMessage(ctx context.Context, sessionID, role, content string, metadata map[string]any) (string, error) {
	messageID := uuid.NewString()
	meta, err := json.Marshal(metadata)
	if err != nil || metadata == nil {
		meta = []byte("{}")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`INSERT INTO chat_messages (message_id, session_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5)`,
		messageID, sessionID, role, content, meta); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE chat_sessions SET updated_at = now() WHERE session_id = $1`, sessionID); err != nil {
		return "", err
	}
	return messageID, tx.Commit(ctx)
}

// GetMessageSession 取消息的 session_id 与 metadata.request_id（用于反馈；不存在返回 ok=false）。
func (s *Store) GetMessageSession(ctx context.Context, messageID string) (sessionID, requestID string, ok bool, err error) {
	var reqID *string
	err = s.pool.QueryRow(ctx,
		`SELECT session_id, metadata->>'request_id' FROM chat_messages WHERE message_id = $1`, messageID).
		Scan(&sessionID, &reqID)
	if err != nil {
		if isNoRowsErr(err) {
			return "", "", false, nil
		}
		return "", "", false, err
	}
	return sessionID, derefOrEmpty(reqID), true, nil
}

func derefOrEmpty(p *string) string {
	if p != nil {
		return *p
	}
	return ""
}

// CreateMessageFeedback 落一条消息反馈，返回 feedback_id。
func (s *Store) CreateMessageFeedback(ctx context.Context, messageID, sessionID, requestID, rating, note string) (string, error) {
	feedbackID := uuid.NewString()
	_, err := s.pool.Exec(ctx, `
		INSERT INTO chat_message_feedback (feedback_id, message_id, session_id, request_id, rating, note)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		feedbackID, messageID, sessionID, nilStr(requestID), rating, nilStr(note))
	return feedbackID, err
}

func nilStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
