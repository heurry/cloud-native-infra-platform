// Package cache 是控制面的 Redis 横切层（5B.4a）：JSON 缓存 / 令牌桶限流 / 幂等存储。
// 设计原则：Redis 不可达即「全降级」——缓存穿透到上游、限流放行、幂等放行——绝不阻塞启动或请求。
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Client 封装 go-redis；enabled=false 时所有方法走降级分支。
type Client struct {
	rdb     *redis.Client
	enabled bool
}

// tokenBucket 令牌桶 Lua（原子）：按 rate(令牌/秒)/burst(容量) 在 Redis 内刷新并扣减一个令牌。
// 返回 1=放行，0=超限。键过期时间取「灌满一桶所需秒数 + 1」，闲置自动回收。
var tokenBucket = redis.NewScript(`
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = burst
  ts = now
end
local delta = math.max(0, now - ts) / 1000.0
tokens = math.min(burst, tokens + delta * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
-- 存成字符串：Redis 会把 Lua number 截断为整数，会丢掉分数令牌，故用 tostring 保精度。
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', key, math.ceil(burst / rate) + 1)
return allowed
`)

// New 解析 REDIS_URL 并 ping；url 为空或 ping 失败 → 返回降级（disabled）客户端，不报错、不阻塞启动。
func New(ctx context.Context, url string) *Client {
	if url == "" {
		slog.Info("redis disabled (REDIS_URL empty); cache/ratelimit/idempotency degrade to no-op")
		return &Client{enabled: false}
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		slog.Warn("redis url parse failed; degraded", "err", err)
		return &Client{enabled: false}
	}
	rdb := redis.NewClient(opt)
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		slog.Warn("redis ping failed; degraded", "err", err)
		_ = rdb.Close()
		return &Client{enabled: false}
	}
	slog.Info("redis connected", "addr", opt.Addr)
	return &Client{rdb: rdb, enabled: true}
}

// Enabled 报告 Redis 是否可用（路由据此决定是否挂中间件）。
func (c *Client) Enabled() bool { return c != nil && c.enabled }

// Close 关闭连接（降级态为 no-op）。
func (c *Client) Close() error {
	if !c.Enabled() {
		return nil
	}
	return c.rdb.Close()
}

// GetJSON 读并反序列化到 dst；hit=false 表示未命中或降级。
func (c *Client) GetJSON(ctx context.Context, key string, dst any) (hit bool, err error) {
	if !c.Enabled() {
		return false, nil
	}
	b, err := c.rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return false, err
	}
	return true, nil
}

// SetJSON 序列化并写入（带 TTL）。降级态 no-op。
func (c *Client) SetJSON(ctx context.Context, key string, v any, ttl time.Duration) error {
	if !c.Enabled() {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.rdb.Set(ctx, key, b, ttl).Err()
}

// Del 删除若干键（缓存失效）。降级态 no-op。
func (c *Client) Del(ctx context.Context, keys ...string) {
	if !c.Enabled() || len(keys) == 0 {
		return
	}
	if err := c.rdb.Del(ctx, keys...).Err(); err != nil {
		slog.Warn("redis del failed", "err", err)
	}
}

// Allow 令牌桶限流：放行返回 true。降级 / 参数非法 / Redis 出错时一律「放行」（fail-open）。
func (c *Client) Allow(ctx context.Context, key string, rate float64, burst int) bool {
	if !c.Enabled() || rate <= 0 || burst <= 0 {
		return true
	}
	res, err := tokenBucket.Run(ctx, c.rdb, []string{key}, rate, burst, time.Now().UnixMilli()).Int()
	if err != nil {
		slog.Warn("ratelimit script failed; fail-open", "err", err)
		return true
	}
	return res == 1
}
