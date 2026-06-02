-- Phase 5 / 5B.4c：RAG 知识库（PostgreSQL + pgvector）。vector 扩展见 000006。
-- 用 kb_* 命名以与 000001 遗留的 Flyway 时代 knowledge_*（Go 从未使用、知识库仍在 Python SQLite）
-- 并存——绞杀者模式：旧 knowledge_* 留待 6B 退役 Python 知识代理时清理，本迁移不动它。
-- 向量检索走 hand-pgx（embedding <=> $1::vector），向量以 $N::vector 文本字面量传入、不经 sqlc；
-- 故本组表不加入 sqlc.yaml 的 schema 列表。
CREATE TABLE IF NOT EXISTS kb_versions (
    version     TEXT PRIMARY KEY,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb_documents (
    doc_id         TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    category       TEXT NOT NULL DEFAULT 'general',
    effective_from TEXT,
    version        TEXT NOT NULL DEFAULT 'default',
    source_uri     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb_chunks (
    chunk_id   BIGSERIAL PRIMARY KEY,
    doc_id     TEXT NOT NULL REFERENCES kb_documents(doc_id) ON DELETE CASCADE,
    version    TEXT NOT NULL DEFAULT 'default',
    ordinal    INT  NOT NULL,
    text       TEXT NOT NULL,
    embedding  vector(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks (doc_id, version);
-- HNSW 余弦索引；NULL embedding 行不入索引（尚未嵌入）。
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops);

INSERT INTO kb_versions (version, description) VALUES ('default', 'default knowledge version')
    ON CONFLICT (version) DO NOTHING;
