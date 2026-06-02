// Package blob 是控制面的对象存储层（5B.4b）：S3 兼容（MinIO）。
// 用途：基准报告 / 评测产物 / 知识源文件；DB 只存对象 key（*_uri 字段），不存二进制。
// 设计原则：endpoint 为空或不可达即「禁用」——方法返回 ErrDisabled，调用方退回 PG 内联 / 本地盘，
// 绝不阻塞启动。真正的写入点随 6A（benchmarks/evals/knowledge 变 Go 原生）接入。
package blob

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ErrDisabled 表示对象存储未配置 / 不可用，调用方应走降级路径。
var ErrDisabled = errors.New("blob store disabled")

// Config 来自环境变量（见 config.S3*）。Endpoint 为 host:port（不含 scheme）。
type Config struct {
	Endpoint   string
	AccessKey  string
	SecretKey  string
	Bucket     string
	UseSSL     bool
	PresignTTL time.Duration
}

// Client 封装 minio-go；enabled=false 时所有方法返回 ErrDisabled。
type Client struct {
	mc         *minio.Client
	bucket     string
	presignTTL time.Duration
	enabled    bool
}

// New 连接 MinIO 并确保 bucket 存在；endpoint 为空或连接 / 建桶失败 → 返回禁用客户端，不报错、不阻塞启动。
func New(ctx context.Context, cfg Config) *Client {
	if cfg.Endpoint == "" {
		slog.Info("blob store disabled (S3_ENDPOINT empty); artifact storage degrades")
		return &Client{enabled: false}
	}
	mc, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		slog.Warn("blob store init failed; degraded", "err", err)
		return &Client{enabled: false}
	}
	bucket := cfg.Bucket
	if bucket == "" {
		bucket = "infra-artifacts"
	}
	ttl := cfg.PresignTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	// best-effort 建桶：不可达 / 失败即降级。
	bctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	exists, err := mc.BucketExists(bctx, bucket)
	if err != nil {
		slog.Warn("blob store unreachable; degraded", "err", err)
		return &Client{enabled: false}
	}
	if !exists {
		if err := mc.MakeBucket(bctx, bucket, minio.MakeBucketOptions{}); err != nil {
			slog.Warn("blob make bucket failed; degraded", "err", err, "bucket", bucket)
			return &Client{enabled: false}
		}
	}
	slog.Info("blob store ready", "endpoint", cfg.Endpoint, "bucket", bucket)
	return &Client{mc: mc, bucket: bucket, presignTTL: ttl, enabled: true}
}

// Enabled 报告对象存储是否可用。
func (c *Client) Enabled() bool { return c != nil && c.enabled }

// Put 上传对象，返回其 key（DB 存它到 *_uri）。禁用态返回 ErrDisabled。
func (c *Client) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	if _, err := c.mc.PutObject(ctx, c.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType}); err != nil {
		return "", err
	}
	return key, nil
}

// PresignedGet 生成限时下载 URL（默认 PresignTTL）。禁用态返回 ErrDisabled。
func (c *Client) PresignedGet(ctx context.Context, key string) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	u, err := c.mc.PresignedGetObject(ctx, c.bucket, key, c.presignTTL, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// Get 读取对象内容（调用方负责 Close）。禁用态返回 ErrDisabled。
func (c *Client) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if !c.Enabled() {
		return nil, ErrDisabled
	}
	obj, err := c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	return obj, nil
}
