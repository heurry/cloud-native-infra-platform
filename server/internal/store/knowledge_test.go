package store

import (
	"context"
	"math"
	"os"
	"testing"

	"github.com/heurry/cloudnative-infra-platform/server/internal/config"
	"github.com/heurry/cloudnative-infra-platform/server/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestKnowledgeStore 需要带 pgvector 的 PostgreSQL：设 TEST_DATABASE_URL 后运行；否则跳过（CI 离线安全）。
// 例：TEST_DATABASE_URL=postgres://infra:infra@127.0.0.1:5432/infra_platform?sslmode=disable
func TestKnowledgeStore(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL (pgvector-enabled PG) to run knowledge store test")
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
	st := New(pool)

	if err := st.UpsertVersion(ctx, "test-v1", "knowledge store test"); err != nil {
		t.Fatalf("UpsertVersion: %v", err)
	}
	if err := st.UpsertDocument(ctx, Document{DocID: "kt-doc-1", Title: "T", Content: "C", Version: "test-v1"}); err != nil {
		t.Fatalf("UpsertDocument: %v", err)
	}
	// 三个正交单位向量；查询贴近 e0 → 期望 chunk0 最近。
	chunks := []Chunk{
		{Ordinal: 0, Text: "alpha", Embedding: unitVec(0)},
		{Ordinal: 1, Text: "beta", Embedding: unitVec(1)},
		{Ordinal: 2, Text: "gamma", Embedding: unitVec(2)},
	}
	if err := st.ReplaceChunks(ctx, "kt-doc-1", "test-v1", chunks); err != nil {
		t.Fatalf("ReplaceChunks: %v", err)
	}
	hits, err := st.SearchChunks(ctx, unitVec(0), "test-v1", 3)
	if err != nil {
		t.Fatalf("SearchChunks: %v", err)
	}
	if len(hits) != 3 {
		t.Fatalf("expected 3 hits, got %d", len(hits))
	}
	if hits[0].Text != "alpha" {
		t.Fatalf("nearest should be alpha, got %q (dist=%v)", hits[0].Text, hits[0].Distance)
	}
	if math.Abs(hits[0].Distance) > 1e-4 {
		t.Fatalf("self cosine distance should be ~0, got %v", hits[0].Distance)
	}
	// ReplaceChunks 幂等：再次替换后仍 3 条。
	if err := st.ReplaceChunks(ctx, "kt-doc-1", "test-v1", chunks); err != nil {
		t.Fatalf("ReplaceChunks (again): %v", err)
	}
	if hits, _ := st.SearchChunks(ctx, unitVec(0), "test-v1", 10); len(hits) != 3 {
		t.Fatalf("replace should not duplicate, got %d", len(hits))
	}
}

// unitVec 返回 1024 维、第 i 维为 1 的单位向量。
func unitVec(i int) []float32 {
	v := make([]float32, 1024)
	v[i] = 1
	return v
}
