-- Phase 5 / 6A：chat 组绞杀——客服对话会话迁出 SQLite → PostgreSQL。
-- PG 000001 无 conversations/messages（旧表仅在 SQLite），故用 chat_* 新表，无冲突。
-- 非向量，走 hand-pgx（store/chat.go），不入 sqlc.yaml。
CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id   TEXT PRIMARY KEY,
    title        TEXT,
    user_role    TEXT NOT NULL DEFAULT 'customer',
    kind         TEXT NOT NULL DEFAULT 'customer_support',
    benchmark_id TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS chat_message_feedback (
    feedback_id TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    request_id  TEXT,
    rating      TEXT NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
