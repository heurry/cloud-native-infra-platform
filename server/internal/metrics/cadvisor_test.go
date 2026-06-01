package metrics

import (
	"testing"
	"time"
)

func TestCadvisorParsePerContainerRates(t *testing.T) {
	c := NewCadvisorCollector("http://cadvisor.test/metrics")
	first := `
container_cpu_usage_seconds_total{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope"} 10
container_memory_working_set_bytes{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope"} 104857600
container_network_receive_bytes_total{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope",interface="eth0"} 1000
container_network_transmit_bytes_total{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope",interface="eth0"} 2000
`
	second := `
container_cpu_usage_seconds_total{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope"} 13
container_memory_working_set_bytes{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope"} 209715200
container_network_receive_bytes_total{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope",interface="eth0"} 1600
container_network_transmit_bytes_total{namespace="default",pod="vllm-0",container="vllm",image="vllm:latest",id="/kubepods.slice/cri-containerd-abcdef123456.scope",interface="eth0"} 2600
`

	start := time.Unix(100, 0)
	if got := c.parseText(first, start); len(got) != 1 {
		t.Fatalf("first parse records=%d, want 1", len(got))
	}
	got := c.parseText(second, start.Add(2*time.Second))
	if len(got) != 1 {
		t.Fatalf("second parse records=%d, want 1", len(got))
	}
	row := got[0].toMap()
	if row["namespace"] != "default" || row["pod"] != "vllm-0" || row["container"] != "vllm" {
		t.Fatalf("unexpected identity: %#v", row)
	}
	if cpu := row["cpu_cores"].(float64); cpu != 1.5 {
		t.Fatalf("cpu_cores=%v, want 1.5", cpu)
	}
	if rx := row["network_rx_bytes_per_second"].(float64); rx != 300 {
		t.Fatalf("network_rx_bytes_per_second=%v, want 300", rx)
	}
	if tx := row["network_tx_bytes_per_second"].(float64); tx != 300 {
		t.Fatalf("network_tx_bytes_per_second=%v, want 300", tx)
	}
	if mem := row["memory_working_set_bytes"].(float64); mem != 209715200 {
		t.Fatalf("memory_working_set_bytes=%v, want 209715200", mem)
	}
}

func TestCadvisorParseSkipsRootCgroups(t *testing.T) {
	c := NewCadvisorCollector("http://cadvisor.test/metrics")
	text := `
container_cpu_usage_seconds_total{id="/"} 10
container_memory_working_set_bytes{id="/"} 100
`
	if got := c.parseText(text, time.Unix(100, 0)); len(got) != 0 {
		t.Fatalf("records=%d, want 0", len(got))
	}
}
