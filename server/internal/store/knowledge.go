package store

import (
	"context"
	"strconv"
	"strings"
	"time"
)

// 知识库领域层（5B.4c）：文档 / 版本 / 切块向量。
// 表用 kb_*（与 000001 遗留的 knowledge_* 并存，见 000007 注释）。
// 向量经 pgvector 存储与检索；为避免 sqlc 不识别 vector 类型，本组全部走 hand-pgx，
// 向量以 `$N::vector` 文本字面量传入（pgvector 接受 "[f1,f2,...]"），检索只取距离、不回扫向量。
// 嵌入由 ai-service /internal/embed 生成（Qwen3-Embedding-0.6B，1024 维）。
// 写入点（rebuild-index / search 的 HTTP 端点）随 6A knowledge 绞杀接入。

// KnowledgeVersion 是知识库版本。
type KnowledgeVersion struct {
	Version     string
	Description string
	Status      string
	CreatedAt   time.Time
}

// Document 是知识文档元数据（正文存 Content；切块向量在 kb_chunks）。
type Document struct {
	DocID         string
	Title         string
	Content       string
	Category      string
	Version       string
	EffectiveFrom *string
	SourceURI     *string
}

// Chunk 是文档切块及其嵌入（Embedding 为空表示尚未嵌入）。
type Chunk struct {
	Ordinal   int
	Text      string
	Embedding []float32
}

// ChunkHit 是一次向量检索命中（Distance 为余弦距离，越小越相关）。
type ChunkHit struct {
	ChunkID  int64
	DocID    string
	Version  string
	Ordinal  int
	Text     string
	Distance float64
}

// DocumentMeta 是文档列表项（不含正文/向量）。
type DocumentMeta struct {
	DocID         string
	Title         string
	Category      string
	Version       string
	EffectiveFrom *string
	SourceURI     *string
	CreatedAt     time.Time
}

// DocHit 是文档级向量检索命中（取该文档最相关切块的距离；Score=1-距离，越大越相关）。
type DocHit struct {
	DocID    string
	Title    string
	Category string
	Version  string
	Content  string // 6A chat：RAG 上下文块需要正文
	Score    float64
}

// vectorLiteral 把向量编码为 pgvector 文本字面量 "[f1,f2,...]"（配合 $N::vector 转换）。
func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'f', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// UpsertVersion 创建/更新知识库版本（置 active）。
func (s *Store) UpsertVersion(ctx context.Context, version, description string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO kb_versions (version, description)
		VALUES ($1, $2)
		ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description, status = 'active'`,
		version, description)
	return err
}

// ListVersions 列出全部版本（按创建时间）。
func (s *Store) ListVersions(ctx context.Context) ([]KnowledgeVersion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT version, COALESCE(description, ''), status, created_at
		  FROM kb_versions ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KnowledgeVersion{}
	for rows.Next() {
		var v KnowledgeVersion
		if err := rows.Scan(&v.Version, &v.Description, &v.Status, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// UpsertDocument 创建/更新文档元数据（按 doc_id）。
func (s *Store) UpsertDocument(ctx context.Context, d Document) error {
	category := d.Category
	if category == "" {
		category = "general"
	}
	version := d.Version
	if version == "" {
		version = "default"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO kb_documents (doc_id, title, content, category, effective_from, version, source_uri)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (doc_id) DO UPDATE SET
			title = EXCLUDED.title, content = EXCLUDED.content, category = EXCLUDED.category,
			effective_from = EXCLUDED.effective_from, version = EXCLUDED.version, source_uri = EXCLUDED.source_uri`,
		d.DocID, d.Title, d.Content, category, d.EffectiveFrom, version, d.SourceURI)
	return err
}

// ReplaceChunks 用事务替换某文档某版本的全部切块（先删后插，含嵌入）。
func (s *Store) ReplaceChunks(ctx context.Context, docID, version string, chunks []Chunk) error {
	if version == "" {
		version = "default"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM kb_chunks WHERE doc_id = $1 AND version = $2`, docID, version); err != nil {
		return err
	}
	for _, c := range chunks {
		var emb any // nil → NULL::vector（尚未嵌入）；否则文本字面量经 $5::vector 转换
		if len(c.Embedding) > 0 {
			emb = vectorLiteral(c.Embedding)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO kb_chunks (doc_id, version, ordinal, text, embedding)
			VALUES ($1, $2, $3, $4, $5::vector)`,
			docID, version, c.Ordinal, c.Text, emb); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ListDocuments 列出文档元数据（按创建时间倒序，复刻 legacy GET /api/knowledge/documents）。
func (s *Store) ListDocuments(ctx context.Context, limit int) ([]DocumentMeta, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT doc_id, title, category, effective_from, version, source_uri, created_at
		  FROM kb_documents ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocumentMeta{}
	for rows.Next() {
		var d DocumentMeta
		if err := rows.Scan(&d.DocID, &d.Title, &d.Category, &d.EffectiveFrom, &d.Version, &d.SourceURI, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SearchDocuments 文档级余弦检索：取每个文档最相关切块的距离，返回 top-k（Score=1-距离）。
func (s *Store) SearchDocuments(ctx context.Context, queryEmbedding []float32, version string, k int) ([]DocHit, error) {
	if k <= 0 {
		k = 5
	}
	// 先按 doc_id 取最相关切块距离的 top-k，再 join 文档拿元数据 + 正文（避免 GROUP BY 大文本）。
	rows, err := s.pool.Query(ctx, `
		SELECT d.doc_id, d.title, d.category, d.version, d.content, t.distance
		  FROM (
			SELECT doc_id, MIN(embedding <=> $1::vector) AS distance
			  FROM kb_chunks
			 WHERE embedding IS NOT NULL AND ($2 = '' OR version = $2)
			 GROUP BY doc_id ORDER BY distance LIMIT $3
		  ) t JOIN kb_documents d ON d.doc_id = t.doc_id
		 ORDER BY t.distance`, vectorLiteral(queryEmbedding), version, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocHit{}
	for rows.Next() {
		var h DocHit
		var dist float64
		if err := rows.Scan(&h.DocID, &h.Title, &h.Category, &h.Version, &h.Content, &dist); err != nil {
			return nil, err
		}
		h.Score = 1 - dist
		out = append(out, h)
	}
	return out, rows.Err()
}

// SearchChunks 按查询向量做余弦近邻检索（version 为空=不限版本）；只返回已嵌入的切块。
func (s *Store) SearchChunks(ctx context.Context, queryEmbedding []float32, version string, k int) ([]ChunkHit, error) {
	if k <= 0 {
		k = 5
	}
	rows, err := s.pool.Query(ctx, `
		SELECT chunk_id, doc_id, version, ordinal, text, embedding <=> $1::vector AS distance
		  FROM kb_chunks
		 WHERE embedding IS NOT NULL AND ($2 = '' OR version = $2)
		 ORDER BY embedding <=> $1::vector
		 LIMIT $3`,
		vectorLiteral(queryEmbedding), version, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChunkHit{}
	for rows.Next() {
		var h ChunkHit
		if err := rows.Scan(&h.ChunkID, &h.DocID, &h.Version, &h.Ordinal, &h.Text, &h.Distance); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
