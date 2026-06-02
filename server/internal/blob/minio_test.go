package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDisabledDegrades(t *testing.T) {
	ctx := context.Background()
	c := New(ctx, Config{Endpoint: ""}) // 空 endpoint → 禁用
	if c.Enabled() {
		t.Fatal("empty endpoint should be disabled")
	}
	if _, err := c.Put(ctx, "k", strings.NewReader("x"), 1, "text/plain"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("Put should return ErrDisabled, got %v", err)
	}
	if _, err := c.PresignedGet(ctx, "k"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("PresignedGet should return ErrDisabled, got %v", err)
	}
	if _, err := c.Get(ctx, "k"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("Get should return ErrDisabled, got %v", err)
	}
}

// TestRoundTrip 需要一个真实 MinIO/S3：设 MINIO_TEST_ENDPOINT（host:port）后运行；否则跳过（CI 离线安全）。
func TestRoundTrip(t *testing.T) {
	endpoint := os.Getenv("MINIO_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("set MINIO_TEST_ENDPOINT to run the live round-trip")
	}
	ctx := context.Background()
	c := New(ctx, Config{
		Endpoint:   endpoint,
		AccessKey:  envOr("MINIO_TEST_ACCESS_KEY", "minioadmin"),
		SecretKey:  envOr("MINIO_TEST_SECRET_KEY", "minioadmin"),
		Bucket:     "blob-test",
		PresignTTL: time.Minute,
	})
	if !c.Enabled() {
		t.Fatal("expected enabled client against MINIO_TEST_ENDPOINT")
	}
	key := "benchmarks/test-run/report.json"
	payload := []byte(`{"hello":"world"}`)
	if _, err := c.Put(ctx, key, bytes.NewReader(payload), int64(len(payload)), "application/json"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	// 直接读回。
	rc, err := c.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, payload) {
		t.Fatalf("round-trip mismatch: %q", got)
	}
	// 预签名 URL 可下载。
	u, err := c.PresignedGet(ctx, key)
	if err != nil {
		t.Fatalf("PresignedGet: %v", err)
	}
	resp, err := http.Get(u) //nolint:gosec // 测试内自生成的预签名 URL
	if err != nil {
		t.Fatalf("download presigned: %v", err)
	}
	defer resp.Body.Close()
	dl, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(dl, payload) {
		t.Fatalf("presigned download mismatch: status=%d body=%q", resp.StatusCode, dl)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
