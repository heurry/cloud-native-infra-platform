package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func newTestClient(t *testing.T) *Client {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	c := New(context.Background(), "redis://"+mr.Addr())
	if !c.Enabled() {
		t.Fatal("expected enabled client")
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestJSONRoundTripAndDel(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	type doc struct {
		N int `json:"n"`
	}
	if err := c.SetJSON(ctx, "k", doc{N: 7}, time.Minute); err != nil {
		t.Fatal(err)
	}
	var got doc
	hit, err := c.GetJSON(ctx, "k", &got)
	if err != nil || !hit || got.N != 7 {
		t.Fatalf("get: hit=%v err=%v got=%+v", hit, err, got)
	}
	c.Del(ctx, "k")
	if hit, _ := c.GetJSON(ctx, "k", &got); hit {
		t.Fatal("expected miss after Del")
	}
}

func TestGetMiss(t *testing.T) {
	c := newTestClient(t)
	var v any
	hit, err := c.GetJSON(context.Background(), "absent", &v)
	if err != nil || hit {
		t.Fatalf("expected clean miss, got hit=%v err=%v", hit, err)
	}
}

func TestAllowTokenBucket(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	// burst=2 → 前两次放行；第三次来不及补充令牌 → 拒绝。
	if !c.Allow(ctx, "ip", 1, 2) || !c.Allow(ctx, "ip", 1, 2) {
		t.Fatal("first two should be allowed")
	}
	if c.Allow(ctx, "ip", 1, 2) {
		t.Fatal("third should be denied")
	}
}

func TestDisabledDegrades(t *testing.T) {
	ctx := context.Background()
	c := New(ctx, "")
	if c.Enabled() {
		t.Fatal("empty url should be disabled")
	}
	if err := c.SetJSON(ctx, "k", 1, time.Minute); err != nil {
		t.Fatal(err)
	}
	var v any
	if hit, err := c.GetJSON(ctx, "k", &v); hit || err != nil {
		t.Fatalf("disabled get should miss: hit=%v err=%v", hit, err)
	}
	if !c.Allow(ctx, "ip", 1, 1) {
		t.Fatal("disabled Allow should fail-open (true)")
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
}
