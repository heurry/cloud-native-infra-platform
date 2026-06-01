package metrics

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const cadvisorReadLimit = 32 << 20

var (
	promMetricLine = regexp.MustCompile(`^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$`)
	promLabel      = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"`)
	cadvisorID     = regexp.MustCompile(`/(?:docker|cri-containerd)-([0-9a-f]{12,64})\.scope|/(?:docker|containerd)/([0-9a-f]{12,64})(?:$|/)|cri-containerd-([0-9a-f]{12,64})\.scope`)
)

type CadvisorCollector struct {
	url      string
	http     *http.Client
	mu       sync.Mutex
	previous map[string]cadvisorPrevious
}

type cadvisorPrevious struct {
	timestamp       time.Time
	cpuUsageSeconds float64
	hasCPU          bool
	networkRxBytes  float64
	hasNetworkRx    bool
	networkTxBytes  float64
	hasNetworkTx    bool
}

type cadvisorRecord struct {
	key                     string
	namespace               string
	pod                     string
	container               string
	name                    string
	image                   string
	cpuUsageSeconds         float64
	hasCPU                  bool
	memoryWorkingSetBytes   float64
	hasMemory               bool
	fsUsageBytes            float64
	hasFS                   bool
	networkRxBytes          float64
	hasNetworkRx            bool
	networkTxBytes          float64
	hasNetworkTx            bool
	cpuCores                *float64
	networkRxBytesPerSecond *float64
	networkTxBytesPerSecond *float64
}

func NewCadvisorCollector(url string) *CadvisorCollector {
	return &CadvisorCollector{
		url:      strings.TrimSpace(url),
		http:     &http.Client{Timeout: 2 * time.Second},
		previous: map[string]cadvisorPrevious{},
	}
}

func (c *CadvisorCollector) Snapshot(ctx context.Context) map[string]any {
	url := ""
	if c != nil {
		url = c.url
	}
	out := emptyCadvisorSnapshot(url)
	if c == nil || c.url == "" {
		out["error"] = "CADVISOR_URL is not configured"
		return out
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		out["error"] = err.Error()
		return out
	}
	resp, err := c.http.Do(req)
	if err != nil {
		out["error"] = err.Error()
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		out["error"] = fmt.Sprintf("cadvisor returned HTTP %d", resp.StatusCode)
		return out
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, cadvisorReadLimit))
	if err != nil {
		out["error"] = err.Error()
		return out
	}

	records := c.parseText(string(body), time.Now())
	sort.Slice(records, func(i, j int) bool {
		ci, cj := numberPtr(records[i].cpuCores), numberPtr(records[j].cpuCores)
		if ci != cj {
			return ci > cj
		}
		return records[i].memoryWorkingSetBytes > records[j].memoryWorkingSetBytes
	})

	containers := make([]map[string]any, 0, minInt(len(records), 16))
	for _, r := range records {
		if len(containers) >= 16 {
			break
		}
		containers = append(containers, r.toMap())
	}
	out["available"] = true
	out["containers"] = containers
	out["summary"] = map[string]any{
		"container_count":             len(records),
		"cpu_cores":                   sumRecords(records, func(r cadvisorRecord) float64 { return numberPtr(r.cpuCores) }),
		"memory_working_set_bytes":    sumRecords(records, func(r cadvisorRecord) float64 { return r.memoryWorkingSetBytes }),
		"network_rx_bytes_per_second": sumRecords(records, func(r cadvisorRecord) float64 { return numberPtr(r.networkRxBytesPerSecond) }),
		"network_tx_bytes_per_second": sumRecords(records, func(r cadvisorRecord) float64 { return numberPtr(r.networkTxBytesPerSecond) }),
	}
	return out
}

func (c *CadvisorCollector) parseText(text string, now time.Time) []cadvisorRecord {
	records := map[string]*cadvisorRecord{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		m := promMetricLine.FindStringSubmatch(line)
		if m == nil || m[2] == "" {
			continue
		}
		metric, rawLabels, rawValue := m[1], m[2], m[3]
		if !isCadvisorMetric(metric) {
			continue
		}
		value, err := strconv.ParseFloat(rawValue, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		labels := parsePromLabels(rawLabels)
		rec, ok := cadvisorRecordFromLabels(labels)
		if !ok {
			continue
		}
		current := records[rec.key]
		if current == nil {
			records[rec.key] = &rec
			current = &rec
		}
		current.add(metric, value)
	}

	out := make([]cadvisorRecord, 0, len(records))
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, rec := range records {
		prev := c.previous[key]
		dt := now.Sub(prev.timestamp).Seconds()
		if rec.hasCPU && prev.hasCPU && dt > 0 {
			v := math.Max((rec.cpuUsageSeconds-prev.cpuUsageSeconds)/dt, 0)
			rec.cpuCores = &v
		}
		if rec.hasNetworkRx && prev.hasNetworkRx && dt > 0 {
			v := math.Max((rec.networkRxBytes-prev.networkRxBytes)/dt, 0)
			rec.networkRxBytesPerSecond = &v
		}
		if rec.hasNetworkTx && prev.hasNetworkTx && dt > 0 {
			v := math.Max((rec.networkTxBytes-prev.networkTxBytes)/dt, 0)
			rec.networkTxBytesPerSecond = &v
		}
		c.previous[key] = cadvisorPrevious{
			timestamp:       now,
			cpuUsageSeconds: rec.cpuUsageSeconds,
			hasCPU:          rec.hasCPU,
			networkRxBytes:  rec.networkRxBytes,
			hasNetworkRx:    rec.hasNetworkRx,
			networkTxBytes:  rec.networkTxBytes,
			hasNetworkTx:    rec.hasNetworkTx,
		}
		out = append(out, *rec)
	}
	return out
}

func emptyCadvisorSnapshot(url string) map[string]any {
	return map[string]any{
		"configured_url": strings.TrimSpace(url),
		"available":      false,
		"error":          "",
		"summary": map[string]any{
			"container_count":             0,
			"cpu_cores":                   0.0,
			"memory_working_set_bytes":    0.0,
			"network_rx_bytes_per_second": 0.0,
			"network_tx_bytes_per_second": 0.0,
		},
		"containers": []any{},
	}
}

func isCadvisorMetric(name string) bool {
	switch name {
	case "container_cpu_usage_seconds_total",
		"container_memory_working_set_bytes",
		"container_fs_usage_bytes",
		"container_network_receive_bytes_total",
		"container_network_transmit_bytes_total":
		return true
	default:
		return false
	}
}

func cadvisorRecordFromLabels(labels map[string]string) (cadvisorRecord, bool) {
	cgroupID := labels["id"]
	container := firstNonEmpty(
		labels["container"],
		labels["container_name"],
		labels["container_label_io_kubernetes_container_name"],
	)
	id := cadvisorContainerID(cgroupID)
	if container == "" {
		if id == "" {
			return cadvisorRecord{}, false
		}
		container = "container-" + id[:minInt(12, len(id))]
	}
	pod := firstNonEmpty(labels["pod"], labels["pod_name"], labels["container_label_io_kubernetes_pod_name"])
	namespace := firstNonEmpty(labels["namespace"], labels["container_label_io_kubernetes_pod_namespace"])
	image := labels["image"]
	if container == "" && pod == "" {
		return cadvisorRecord{}, false
	}
	if (container == "" || container == "POD") && image == "" {
		return cadvisorRecord{}, false
	}
	key := strings.Join([]string{namespace, pod, container, cgroupID}, "|")
	return cadvisorRecord{
		key:       key,
		namespace: namespace,
		pod:       pod,
		container: container,
		name:      firstNonEmpty(pod, container),
		image:     image,
	}, true
}

func (r *cadvisorRecord) add(metric string, value float64) {
	switch metric {
	case "container_cpu_usage_seconds_total":
		r.cpuUsageSeconds += value
		r.hasCPU = true
	case "container_memory_working_set_bytes":
		if !r.hasMemory || value > r.memoryWorkingSetBytes {
			r.memoryWorkingSetBytes = value
		}
		r.hasMemory = true
	case "container_fs_usage_bytes":
		if !r.hasFS || value > r.fsUsageBytes {
			r.fsUsageBytes = value
		}
		r.hasFS = true
	case "container_network_receive_bytes_total":
		r.networkRxBytes += value
		r.hasNetworkRx = true
	case "container_network_transmit_bytes_total":
		r.networkTxBytes += value
		r.hasNetworkTx = true
	}
}

func (r cadvisorRecord) toMap() map[string]any {
	out := map[string]any{
		"namespace": r.namespace,
		"pod":       r.pod,
		"container": r.container,
		"name":      r.name,
		"image":     r.image,
	}
	if r.cpuCores != nil {
		out["cpu_cores"] = *r.cpuCores
	}
	if r.hasMemory {
		out["memory_working_set_bytes"] = r.memoryWorkingSetBytes
	}
	if r.hasFS {
		out["fs_usage_bytes"] = r.fsUsageBytes
	}
	if r.networkRxBytesPerSecond != nil {
		out["network_rx_bytes_per_second"] = *r.networkRxBytesPerSecond
	}
	if r.networkTxBytesPerSecond != nil {
		out["network_tx_bytes_per_second"] = *r.networkTxBytesPerSecond
	}
	return out
}

func parsePromLabels(raw string) map[string]string {
	out := map[string]string{}
	for _, m := range promLabel.FindAllStringSubmatch(raw, -1) {
		out[m[1]] = strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, "\n").Replace(m[2])
	}
	return out
}

func cadvisorContainerID(cgroupID string) string {
	m := cadvisorID.FindStringSubmatch(cgroupID)
	if m == nil {
		return ""
	}
	for _, group := range m[1:] {
		if group != "" {
			return group
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func sumRecords(records []cadvisorRecord, f func(cadvisorRecord) float64) float64 {
	total := 0.0
	for _, r := range records {
		total += f(r)
	}
	return total
}

func numberPtr(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
