package httpx

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// D4 负载基线：对关键只读路径做进程内并发压测，固化「零错误 + 延迟天花板」基线。
// 不追求绝对吞吐数字（受 CI 机器影响），而是回归护栏——出现错误或病态延迟即失败。需 TEST_DATABASE_URL。
func TestLoadBaseline(t *testing.T) {
	rt, _, pool := e2eEnv(t)
	defer pool.Close()

	const (
		total       = 600
		concurrency = 24
		p95Ceiling  = 2 * time.Second // 宽松上限：抓病态回归，不卡机器抖动
	)
	paths := []string{"/api/health", "/api/service-instances", "/api/platform/overview"}

	var (
		mu        sync.Mutex
		latencies []time.Duration
		errors    int32
		nonOK     int32
	)
	jobs := make(chan int, total)
	for i := 0; i < total; i++ {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	start := time.Now()
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				path := paths[i%len(paths)]
				t0 := time.Now()
				rec := httptest.NewRecorder()
				rt.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				d := time.Since(t0)
				if rec.Code != http.StatusOK {
					atomic.AddInt32(&nonOK, 1)
				}
				mu.Lock()
				latencies = append(latencies, d)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)

	if n := atomic.LoadInt32(&nonOK); n > 0 {
		t.Fatalf("load baseline: %d/%d requests returned non-200", n, total)
	}
	if n := atomic.LoadInt32(&errors); n > 0 {
		t.Fatalf("load baseline: %d transport errors", n)
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	p50 := latencies[len(latencies)*50/100]
	p95 := latencies[len(latencies)*95/100]
	p99 := latencies[len(latencies)*99/100]
	qps := float64(total) / elapsed.Seconds()
	t.Logf("load baseline: %d reqs @ c=%d in %s | qps=%.0f p50=%s p95=%s p99=%s",
		total, concurrency, elapsed.Round(time.Millisecond), qps, p50, p95, p99)
	if p95 > p95Ceiling {
		t.Fatalf("p95 latency %s exceeds ceiling %s (pathological regression?)", p95, p95Ceiling)
	}
}
