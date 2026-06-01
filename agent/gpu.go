// GPU 采集（调用 nvidia-smi）。无 GPU/驱动/二进制时返回空切片（不编造数据）。
//
// 与 host 同理，nvidia-smi 调用有开销，故由后台周期采样并缓存，HTTP 返回缓存。
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// gpuMetric 字段对齐前端 GpuMetric。
type gpuMetric struct {
	Index                    int      `json:"index"`
	Name                     string   `json:"name"`
	GpuUtilizationPercent    float64  `json:"gpu_utilization_percent"`
	MemoryUsedMb             float64  `json:"memory_used_mb"`
	MemoryTotalMb            float64  `json:"memory_total_mb"`
	MemoryUtilizationPercent float64  `json:"memory_utilization_percent"`
	TemperatureCelsius       *float64 `json:"temperature_celsius"`
	PowerWatts               *float64 `json:"power_watts"`
}

type gpuCollector struct {
	mu        sync.RWMutex
	latest    []gpuMetric
	available bool
	lastError string
}

func newGPUCollector() *gpuCollector {
	return &gpuCollector{latest: []gpuMetric{}}
}

func (g *gpuCollector) start(interval time.Duration) {
	g.sample()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for range t.C {
			g.sample()
		}
	}()
}

func (g *gpuCollector) snapshot() ([]gpuMetric, bool, string) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.latest, g.available, g.lastError
}

func (g *gpuCollector) sample() {
	res, errText := collectGPU(context.Background())
	g.mu.Lock()
	g.latest = res
	g.available = len(res) > 0
	g.lastError = errText
	g.mu.Unlock()
}

// collectGPU 执行 nvidia-smi 查询；任何失败（无二进制/无 GPU/超时）均返回空切片。
func collectGPU(ctx context.Context) ([]gpuMetric, string) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	bin, err := lookupNvidiaSMI()
	if err != nil {
		return []gpuMetric{}, err.Error()
	}
	cmd := exec.CommandContext(ctx, bin,
		"--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
		"--format=csv,noheader,nounits")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return []gpuMetric{}, fmt.Sprintf("nvidia-smi failed: %v; %s", err, firstLine(strings.TrimSpace(string(out))))
	}
	res := []gpuMetric{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		cols := strings.Split(line, ",")
		if len(cols) < 5 {
			continue
		}
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		idx, _ := strconv.Atoi(cols[0])
		used := parseFloatOr(cols[3])
		total := parseFloatOr(cols[4])
		g := gpuMetric{
			Index:                 idx,
			Name:                  cols[1],
			GpuUtilizationPercent: parseFloatOr(cols[2]),
			MemoryUsedMb:          used,
			MemoryTotalMb:         total,
		}
		if total > 0 {
			g.MemoryUtilizationPercent = used / total * 100
		}
		if len(cols) > 5 {
			if t, ok := parseFloatOk(cols[5]); ok {
				g.TemperatureCelsius = &t
			}
		}
		if len(cols) > 6 {
			if p, ok := parseFloatOk(cols[6]); ok {
				g.PowerWatts = &p
			}
		}
		res = append(res, g)
	}
	if len(res) == 0 {
		return res, "nvidia-smi returned no GPU rows"
	}
	return res, ""
}

func lookupNvidiaSMI() (string, error) {
	if bin, err := exec.LookPath("nvidia-smi"); err == nil {
		return bin, nil
	}
	candidates := []string{
		"/usr/bin/nvidia-smi",
		"/usr/local/nvidia/bin/nvidia-smi",
		"/run/nvidia/driver/usr/bin/nvidia-smi",
		"/host/usr/bin/nvidia-smi",
	}
	for _, path := range candidates {
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			return path, nil
		}
	}
	return "", fmt.Errorf("nvidia-smi not found in PATH or common driver mount paths")
}

func firstLine(s string) string {
	if s == "" {
		return "no output"
	}
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

func parseFloatOr(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

func parseFloatOk(s string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v, err == nil
}
