// 主机资源采集（纯 /proc 解析，无外部依赖）。
//
// Agent 以 host 网络模式运行时，/proc/stat、/proc/meminfo、/proc/loadavg、
// /proc/net/dev 反映宿主机全局值（这些聚合文件不随 PID namespace 隔离）。
// CPU 利用率与网络速率需两次采样求差，故由后台 goroutine 周期采样并缓存，
// HTTP 请求返回缓存值（响应快、速率准）。磁盘用 statfs 读容器根文件系统。
package main

import (
	"bufio"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---- 主机指标结构（字段对齐前端 HostMetrics） ----

type hostCPU struct {
	UsagePercent *float64  `json:"usage_percent"`
	Count        int       `json:"count"`
	LoadAverage  []float64 `json:"load_average"`
}

type hostMemory struct {
	TotalBytes     uint64   `json:"total_bytes"`
	AvailableBytes uint64   `json:"available_bytes"`
	UsedBytes      uint64   `json:"used_bytes"`
	UsedPercent    *float64 `json:"used_percent"`
	SwapTotalBytes uint64   `json:"swap_total_bytes"`
	SwapFreeBytes  uint64   `json:"swap_free_bytes"`
}

type hostDisk struct {
	Path        string   `json:"path"`
	TotalBytes  uint64   `json:"total_bytes"`
	UsedBytes   uint64   `json:"used_bytes"`
	FreeBytes   uint64   `json:"free_bytes"`
	UsedPercent *float64 `json:"used_percent"`
}

type hostNetIface struct {
	Name             string  `json:"name"`
	RxBytesPerSecond float64 `json:"rx_bytes_per_second"`
	TxBytesPerSecond float64 `json:"tx_bytes_per_second"`
	RxBytes          uint64  `json:"rx_bytes"`
	TxBytes          uint64  `json:"tx_bytes"`
}

type hostNetwork struct {
	RxBytesPerSecond float64        `json:"rx_bytes_per_second"`
	TxBytesPerSecond float64        `json:"tx_bytes_per_second"`
	Interfaces       []hostNetIface `json:"interfaces"`
}

type hostMetrics struct {
	CPU     hostCPU     `json:"cpu"`
	Memory  hostMemory  `json:"memory"`
	Disk    []hostDisk  `json:"disk"`
	Network hostNetwork `json:"network"`
}

// ---- 采集器 ----

type cpuSample struct {
	idle  uint64
	total uint64
}

type netSample struct {
	rx uint64
	tx uint64
}

type hostCollector struct {
	mu sync.RWMutex

	latest  hostMetrics
	hasData bool

	prevCPU   cpuSample
	prevCPUok bool
	prevNet   map[string]netSample
	prevTime  time.Time
}

func newHostCollector() *hostCollector {
	return &hostCollector{prevNet: map[string]netSample{}}
}

// start 立即采一次基线，随后每 interval 采样一次（CPU/网络速率需要前后两次差值）。
func (h *hostCollector) start(interval time.Duration) {
	h.sample()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for range t.C {
			h.sample()
		}
	}()
}

func (h *hostCollector) snapshot() (hostMetrics, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.latest, h.hasData
}

func (h *hostCollector) sample() {
	now := time.Now()
	m := hostMetrics{Disk: []hostDisk{}, Network: hostNetwork{Interfaces: []hostNetIface{}}}

	m.CPU.Count = runtime.NumCPU()
	m.CPU.LoadAverage = readLoadAvg()

	if cur, ok := readCPUSample(); ok {
		if h.prevCPUok {
			totalDelta := float64(cur.total - h.prevCPU.total)
			idleDelta := float64(cur.idle - h.prevCPU.idle)
			if totalDelta > 0 {
				u := (1 - idleDelta/totalDelta) * 100
				m.CPU.UsagePercent = &u
			}
		}
		h.prevCPU = cur
		h.prevCPUok = true
	}

	m.Memory = readMemory()

	if d, ok := readDisk("/"); ok {
		m.Disk = append(m.Disk, d)
	}

	cur := readNetSamples()
	dt := now.Sub(h.prevTime).Seconds()
	var totalRx, totalTx float64
	ifaces := make([]hostNetIface, 0, len(cur))
	for name, c := range cur {
		iface := hostNetIface{Name: name, RxBytes: c.rx, TxBytes: c.tx}
		if prev, ok := h.prevNet[name]; ok && dt > 0 && c.rx >= prev.rx && c.tx >= prev.tx {
			iface.RxBytesPerSecond = float64(c.rx-prev.rx) / dt
			iface.TxBytesPerSecond = float64(c.tx-prev.tx) / dt
		}
		totalRx += iface.RxBytesPerSecond
		totalTx += iface.TxBytesPerSecond
		ifaces = append(ifaces, iface)
	}
	sort.Slice(ifaces, func(i, j int) bool { return ifaces[i].Name < ifaces[j].Name })
	m.Network.Interfaces = ifaces
	m.Network.RxBytesPerSecond = totalRx
	m.Network.TxBytesPerSecond = totalTx
	h.prevNet = cur
	h.prevTime = now

	h.mu.Lock()
	h.latest = m
	h.hasData = true
	h.mu.Unlock()
}

// ---- /proc 解析辅助 ----

func readCPUSample() (cpuSample, bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		var total, idle uint64
		for i, fld := range fields {
			v, _ := strconv.ParseUint(fld, 10, 64)
			total += v
			if i == 3 || i == 4 { // idle + iowait
				idle += v
			}
		}
		return cpuSample{idle: idle, total: total}, true
	}
	return cpuSample{}, false
}

func readLoadAvg() []float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return []float64{}
	}
	parts := strings.Fields(string(b))
	out := make([]float64, 0, 3)
	for i := 0; i < 3 && i < len(parts); i++ {
		if v, err := strconv.ParseFloat(parts[i], 64); err == nil {
			out = append(out, v)
		}
	}
	return out
}

func readMemory() hostMemory {
	m := hostMemory{}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return m
	}
	defer f.Close()
	vals := map[string]uint64{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		v, _ := strconv.ParseUint(fields[1], 10, 64)
		vals[key] = v * 1024 // kB → bytes
	}
	m.TotalBytes = vals["MemTotal"]
	m.AvailableBytes = vals["MemAvailable"]
	m.SwapTotalBytes = vals["SwapTotal"]
	m.SwapFreeBytes = vals["SwapFree"]
	if m.TotalBytes >= m.AvailableBytes {
		m.UsedBytes = m.TotalBytes - m.AvailableBytes
	}
	if m.TotalBytes > 0 {
		p := float64(m.UsedBytes) / float64(m.TotalBytes) * 100
		m.UsedPercent = &p
	}
	return m
}

func readDisk(path string) (hostDisk, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return hostDisk{}, false
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bavail * bsize
	used := (st.Blocks - st.Bfree) * bsize
	d := hostDisk{Path: path, TotalBytes: total, FreeBytes: free, UsedBytes: used}
	if total > 0 {
		p := float64(used) / float64(total) * 100
		d.UsedPercent = &p
	}
	return d, true
}

func readNetSamples() map[string]netSample {
	out := map[string]netSample{}
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		if name == "lo" {
			continue
		}
		fields := strings.Fields(line[idx+1:])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		out[name] = netSample{rx: rx, tx: tx}
	}
	return out
}
