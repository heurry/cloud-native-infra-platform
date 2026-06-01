from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List

import requests

from src.api.db import Database, json_loads
from src.serve.openai_client import normalize_base_url


def percentile(values: List[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * p
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    weight = rank - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def current_metrics(db: Database) -> Dict[str, Any]:
    window_seconds = 600
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat(timespec="milliseconds")
    rows = db.fetch_all(
        """
        SELECT * FROM request_traces
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 500
        """,
        (cutoff,),
    )
    latencies = [float(row["total_ms"]) for row in rows if row.get("total_ms") is not None]
    ttfts = [float(row["ttft_ms"]) for row in rows if row.get("ttft_ms") is not None]
    generation_latencies = [float(row["generation_ms"]) for row in rows if row.get("generation_ms") is not None]
    input_tokens = sum(int(row.get("input_tokens") or 0) for row in rows)
    output_tokens = sum(int(row.get("output_tokens") or 0) for row in rows)
    errors = [row for row in rows if row.get("status") != "ok"]
    target_counts = Counter(row.get("target_pod") or "unknown" for row in rows)
    endpoint_counts = Counter(row.get("endpoint_id") or "unknown" for row in rows)
    status_counts = Counter(row.get("status") or "unknown" for row in rows)
    fallback_counts = Counter(row.get("fallback_reason") or "none" for row in rows)
    return {
        "window": "10m",
        "window_seconds": window_seconds,
        "request_count": len(rows),
        "qps": len(rows) / window_seconds,
        "error_count": len(errors),
        "error_rate": len(errors) / len(rows) if rows else 0.0,
        "mean_latency_ms": mean(latencies) if latencies else None,
        "mean_ttft_ms": mean(ttfts) if ttfts else None,
        "p50_latency_ms": percentile(latencies, 0.50),
        "p95_latency_ms": percentile(latencies, 0.95),
        "p99_latency_ms": percentile(latencies, 0.99),
        "p50_ttft_ms": percentile(ttfts, 0.50),
        "p95_ttft_ms": percentile(ttfts, 0.95),
        "p99_ttft_ms": percentile(ttfts, 0.99),
        "p95_generation_ms": percentile(generation_latencies, 0.95),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "tokens_per_second": output_tokens / window_seconds,
        "target_pod_counts": dict(target_counts),
        "endpoint_counts": dict(endpoint_counts),
        "status_counts": dict(status_counts),
        "fallback_counts": dict(fallback_counts),
        "target_pod_stats": _group_stats(rows, "target_pod"),
        "endpoint_stats": _group_stats(rows, "endpoint_id"),
        "gpu": collect_gpu_metrics(),
        "host": collect_host_metrics(),
        "cadvisor": collect_cadvisor_metrics(),
        "service_instances": _service_instance_summary(db),
        "upstream_metrics": collect_upstream_metrics(db),
        "kubernetes": collect_kubernetes_status(),
    }


def _group_stats(rows: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get(key) or "unknown"), []).append(row)
    result = []
    for name, items in sorted(grouped.items(), key=lambda item: item[0]):
        latencies = [float(row["total_ms"]) for row in items if row.get("total_ms") is not None]
        ttfts = [float(row["ttft_ms"]) for row in items if row.get("ttft_ms") is not None]
        output_tokens = sum(int(row.get("output_tokens") or 0) for row in items)
        errors = [row for row in items if row.get("status") != "ok"]
        result.append(
            {
                "name": name,
                "request_count": len(items),
                "error_count": len(errors),
                "error_rate": len(errors) / len(items) if items else 0.0,
                "mean_latency_ms": mean(latencies) if latencies else None,
                "p95_latency_ms": percentile(latencies, 0.95),
                "mean_ttft_ms": mean(ttfts) if ttfts else None,
                "p95_ttft_ms": percentile(ttfts, 0.95),
                "output_tokens": output_tokens,
            }
        )
    return result


def _service_instance_summary(db: Database) -> List[Dict[str, Any]]:
    rows = db.fetch_all(
        """
        SELECT name, kind, base_url, model_id, routing_role, status, last_checked_at
        FROM service_instances
        ORDER BY name
        """
    )
    return rows


def collect_gpu_metrics() -> List[Dict[str, Any]]:
    cmd = [
        "nvidia-smi",
        "--query-gpu=index,name,memory.used,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
    ]
    try:
        completed = subprocess.run(cmd, text=True, capture_output=True, timeout=1.5, check=False)
    except (FileNotFoundError, subprocess.SubprocessError):
        return []
    if completed.returncode != 0:
        return []
    rows = []
    for line in completed.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 5:
            continue
        index, name, memory_used, memory_total, gpu_util = parts
        try:
            rows.append(
                {
                    "index": index,
                    "name": name,
                    "memory_used_mb": float(memory_used),
                    "memory_total_mb": float(memory_total),
                    "gpu_utilization_percent": float(gpu_util),
                }
            )
        except ValueError:
            continue
    return rows


def collect_host_metrics() -> Dict[str, Any]:
    cpu_before = _read_cpu_stat()
    net_before = _read_network_counters()
    time.sleep(0.08)
    cpu_after = _read_cpu_stat()
    net_after = _read_network_counters()
    interval = 0.08
    return {
        "cpu": {
            "usage_percent": _cpu_usage_percent(cpu_before, cpu_after),
            "count": os.cpu_count() or 0,
            "load_average": list(os.getloadavg()) if hasattr(os, "getloadavg") else [],
        },
        "memory": _read_memory_metrics(),
        "disk": _read_disk_metrics(),
        "network": _network_rate_metrics(net_before, net_after, interval),
    }


def _read_cpu_stat() -> Dict[str, float]:
    try:
        line = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0]
    except (FileNotFoundError, IndexError, OSError):
        return {}
    parts = line.split()
    if not parts or parts[0] != "cpu":
        return {}
    values = [float(item) for item in parts[1:] if item.isdigit()]
    if len(values) < 5:
        return {}
    idle = values[3] + (values[4] if len(values) > 4 else 0.0)
    return {"idle": idle, "total": sum(values)}


def _cpu_usage_percent(before: Dict[str, float], after: Dict[str, float]) -> float | None:
    if not before or not after:
        return None
    total_delta = after["total"] - before["total"]
    idle_delta = after["idle"] - before["idle"]
    if total_delta <= 0:
        return None
    return max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0))


def _read_memory_metrics() -> Dict[str, Any]:
    values: Dict[str, float] = {}
    try:
        lines = Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    for line in lines:
        key, _, raw = line.partition(":")
        parts = raw.strip().split()
        if not parts:
            continue
        try:
            values[key] = float(parts[0]) * 1024.0
        except ValueError:
            continue
    total = values.get("MemTotal", 0.0)
    available = values.get("MemAvailable", 0.0)
    used = max(total - available, 0.0)
    return {
        "total_bytes": total,
        "available_bytes": available,
        "used_bytes": used,
        "used_percent": (used / total * 100.0) if total else None,
        "swap_total_bytes": values.get("SwapTotal", 0.0),
        "swap_free_bytes": values.get("SwapFree", 0.0),
    }


def _read_disk_metrics() -> List[Dict[str, Any]]:
    paths = ["/", "/tmp", "/mnt/nvme-data", "/mnt/nvme-data/docker-data", "/mnt/nvme-data/containerd"]
    rows = []
    seen = set()
    for item in paths:
        path = Path(item)
        if not path.exists():
            continue
        resolved = str(path.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            continue
        rows.append(
            {
                "path": item,
                "total_bytes": float(usage.total),
                "used_bytes": float(usage.used),
                "free_bytes": float(usage.free),
                "used_percent": (usage.used / (usage.used + usage.free) * 100.0) if (usage.used + usage.free) else None,
            }
        )
    return rows


def _read_network_counters() -> Dict[str, Dict[str, float]]:
    try:
        lines = Path("/proc/net/dev").read_text(encoding="utf-8").splitlines()[2:]
    except OSError:
        return {}
    result: Dict[str, Dict[str, float]] = {}
    for line in lines:
        name, _, raw = line.partition(":")
        iface = name.strip()
        if not iface or iface == "lo":
            continue
        parts = raw.split()
        if len(parts) < 16:
            continue
        try:
            result[iface] = {
                "rx_bytes": float(parts[0]),
                "rx_packets": float(parts[1]),
                "tx_bytes": float(parts[8]),
                "tx_packets": float(parts[9]),
            }
        except ValueError:
            continue
    return result


def _network_rate_metrics(before: Dict[str, Dict[str, float]], after: Dict[str, Dict[str, float]], interval: float) -> Dict[str, Any]:
    interfaces = []
    total_rx = 0.0
    total_tx = 0.0
    for iface, current in sorted(after.items()):
        previous = before.get(iface, current)
        rx_rate = max((current["rx_bytes"] - previous["rx_bytes"]) / interval, 0.0)
        tx_rate = max((current["tx_bytes"] - previous["tx_bytes"]) / interval, 0.0)
        total_rx += rx_rate
        total_tx += tx_rate
        interfaces.append(
            {
                "name": iface,
                "rx_bytes_per_second": rx_rate,
                "tx_bytes_per_second": tx_rate,
                "rx_bytes": current["rx_bytes"],
                "tx_bytes": current["tx_bytes"],
            }
        )
    return {
        "rx_bytes_per_second": total_rx,
        "tx_bytes_per_second": total_tx,
        "interfaces": interfaces,
    }


_PROM_LINE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)$")
_PROM_LABEL_LINE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([-+0-9.eE]+)(?:\s+\d+)?$")
_CADVISOR_CONTAINER_ID = re.compile(r"/(?:docker|cri-containerd)-([0-9a-f]{12,64})\.scope")
_SELECTED_PROM_METRICS = {
    "vllm:num_requests_running": "requests_running",
    "vllm:num_requests_waiting": "requests_waiting",
    "vllm:kv_cache_usage_perc": "kv_cache_usage_percent",
    "vllm:gpu_cache_usage_perc": "gpu_cache_usage_percent",
    "vllm:cpu_cache_usage_perc": "cpu_cache_usage_percent",
    "vllm:avg_prompt_throughput_toks_per_s": "prompt_tokens_per_second",
    "vllm:avg_generation_throughput_toks_per_s": "generation_tokens_per_second",
    "vllm:num_preemptions_total": "preemptions_total",
    "vllm:prefix_cache_queries_total": "prefix_cache_queries_total",
    "vllm:prefix_cache_hits_total": "prefix_cache_hits_total",
    "vllm:external_prefix_cache_queries_total": "external_prefix_cache_queries_total",
    "vllm:external_prefix_cache_hits_total": "external_prefix_cache_hits_total",
    "vllm:prompt_tokens_total": "prompt_tokens_total",
    "vllm:generation_tokens_total": "generation_tokens_total",
}

_CADVISOR_PREVIOUS: Dict[str, Dict[str, float]] = {}


def collect_cadvisor_metrics() -> Dict[str, Any]:
    base_url = os.environ.get("CADVISOR_URL", "http://127.0.0.1:18080/metrics")
    result: Dict[str, Any] = {
        "configured_url": base_url,
        "available": False,
        "containers": [],
        "summary": {
            "container_count": 0,
            "cpu_cores": 0.0,
            "memory_working_set_bytes": 0.0,
            "network_rx_bytes_per_second": 0.0,
            "network_tx_bytes_per_second": 0.0,
        },
        "error": "",
    }
    try:
        response = requests.get(base_url, timeout=0.8)
        response.raise_for_status()
    except requests.RequestException as exc:
        result["error"] = str(exc)
        return result

    result["available"] = True
    containers = _parse_cadvisor_metrics(response.text)
    result["containers"] = sorted(
        containers,
        key=lambda item: (item.get("cpu_cores") or 0.0, item.get("memory_working_set_bytes") or 0.0),
        reverse=True,
    )[:16]
    result["summary"] = {
        "container_count": len(containers),
        "cpu_cores": sum(float(item.get("cpu_cores") or 0.0) for item in containers),
        "memory_working_set_bytes": sum(float(item.get("memory_working_set_bytes") or 0.0) for item in containers),
        "network_rx_bytes_per_second": sum(float(item.get("network_rx_bytes_per_second") or 0.0) for item in containers),
        "network_tx_bytes_per_second": sum(float(item.get("network_tx_bytes_per_second") or 0.0) for item in containers),
    }
    return result


def _parse_cadvisor_metrics(text: str) -> List[Dict[str, Any]]:
    now = time.time()
    records: Dict[str, Dict[str, Any]] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        match = _PROM_LABEL_LINE.match(line.strip())
        if not match:
            continue
        metric_name, raw_labels, raw_value = match.groups()
        if metric_name not in {
            "container_cpu_usage_seconds_total",
            "container_memory_working_set_bytes",
            "container_fs_usage_bytes",
            "container_network_receive_bytes_total",
            "container_network_transmit_bytes_total",
        }:
            continue
        labels = _parse_prometheus_labels(raw_labels)
        container_name = (
            labels.get("container")
            or labels.get("container_name")
            or labels.get("container_label_io_kubernetes_container_name")
            or labels.get("name")
            or labels.get("id")
            or ""
        )
        cgroup_id = labels.get("id", "")
        container_id_match = _CADVISOR_CONTAINER_ID.search(cgroup_id)
        if not (labels.get("container") or labels.get("container_name") or labels.get("container_label_io_kubernetes_container_name")):
            if not container_id_match:
                continue
            container_name = f"container-{container_id_match.group(1)[:12]}"
        pod = labels.get("pod") or labels.get("pod_name") or labels.get("container_label_io_kubernetes_pod_name") or ""
        namespace = labels.get("namespace") or labels.get("container_label_io_kubernetes_pod_namespace") or ""
        image = labels.get("image") or ""
        if not container_name and not pod:
            continue
        if container_name in {"POD", ""} and not image:
            continue
        key = "|".join([namespace, pod, container_name, cgroup_id])
        try:
            value = float(raw_value)
        except ValueError:
            continue
        record = records.setdefault(
            key,
            {
                "namespace": namespace,
                "pod": pod,
                "container": container_name,
                "name": pod or container_name,
                "image": image,
            },
        )
        if metric_name == "container_cpu_usage_seconds_total":
            previous = _CADVISOR_PREVIOUS.get(key, {})
            previous_value = previous.get("cpu_usage_seconds")
            previous_time = previous.get("timestamp")
            cpu_cores = 0.0
            if previous_value is not None and previous_time is not None and now > previous_time:
                cpu_cores = max((value - previous_value) / (now - previous_time), 0.0)
            record["cpu_usage_seconds"] = value
            record["cpu_cores"] = cpu_cores
        elif metric_name == "container_memory_working_set_bytes":
            record["memory_working_set_bytes"] = value
        elif metric_name == "container_fs_usage_bytes":
            record["fs_usage_bytes"] = value
        elif metric_name == "container_network_receive_bytes_total":
            previous = _CADVISOR_PREVIOUS.get(key, {})
            record["network_rx_bytes"] = value
            if "network_rx_bytes" in previous and "timestamp" in previous and now > previous["timestamp"]:
                record["network_rx_bytes_per_second"] = max((value - previous["network_rx_bytes"]) / (now - previous["timestamp"]), 0.0)
        elif metric_name == "container_network_transmit_bytes_total":
            previous = _CADVISOR_PREVIOUS.get(key, {})
            record["network_tx_bytes"] = value
            if "network_tx_bytes" in previous and "timestamp" in previous and now > previous["timestamp"]:
                record["network_tx_bytes_per_second"] = max((value - previous["network_tx_bytes"]) / (now - previous["timestamp"]), 0.0)

    for key, record in records.items():
        previous = _CADVISOR_PREVIOUS.setdefault(key, {})
        previous["timestamp"] = now
        for field in ("cpu_usage_seconds", "network_rx_bytes", "network_tx_bytes"):
            if field in record:
                previous[field] = float(record[field])
    return list(records.values())


def _parse_prometheus_labels(raw: str) -> Dict[str, str]:
    labels: Dict[str, str] = {}
    for match in re.finditer(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"', raw):
        labels[match.group(1)] = match.group(2).replace('\\"', '"')
    return labels


def collect_upstream_metrics(db: Database) -> List[Dict[str, Any]]:
    rows = db.fetch_all(
        """
        SELECT name, kind, base_url, model_id, routing_role
        FROM service_instances
        ORDER BY name
        """
    )
    result = []
    for row in rows:
        if row.get("kind") != "vllm":
            continue
        base = normalize_base_url(row["base_url"])
        root = base[:-3] if base.endswith("/v1") else base.rstrip("/")
        metrics_url = f"{root}/metrics"
        item: Dict[str, Any] = {
            "name": row["name"],
            "kind": row["kind"],
            "model_id": row["model_id"],
            "metrics_url": metrics_url,
            "reachable": False,
            "selected": {},
            "error": "",
        }
        try:
            response = requests.get(metrics_url, timeout=0.8)
            item["status_code"] = response.status_code
            if response.status_code < 400:
                item["reachable"] = True
                item["selected"] = _parse_prometheus_selected(response.text)
            else:
                item["error"] = response.text[:200]
        except requests.RequestException as exc:
            item["error"] = str(exc)
        result.append(item)
    return result


def _parse_prometheus_selected(text: str) -> Dict[str, float]:
    values: Dict[str, float] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        stripped = line.strip()
        label_match = _PROM_LABEL_LINE.match(stripped)
        if label_match:
            metric_name, raw_labels, raw_value = label_match.groups()
            labels = _parse_prometheus_labels(raw_labels)
        else:
            match = _PROM_LINE.match(stripped)
            if not match:
                continue
            metric_name, raw_value = match.groups()
            labels = {}
        try:
            value = float(raw_value)
        except ValueError:
            continue

        if metric_name == "vllm:prompt_tokens_by_source_total":
            source = labels.get("source")
            if source == "local_cache_hit":
                values["prompt_tokens_local_cache_hit_total"] = value
            elif source == "local_compute":
                values["prompt_tokens_local_compute_total"] = value
            continue

        alias = _SELECTED_PROM_METRICS.get(metric_name)
        if not alias:
            continue
        if alias.endswith("_percent"):
            value *= 100.0
        values[alias] = value
    prefix_queries = values.get("prefix_cache_queries_total", 0.0)
    prefix_hits = values.get("prefix_cache_hits_total", 0.0)
    values["prefix_cache_hit_rate_percent"] = (prefix_hits / prefix_queries * 100.0) if prefix_queries else 0.0
    external_queries = values.get("external_prefix_cache_queries_total", 0.0)
    external_hits = values.get("external_prefix_cache_hits_total", 0.0)
    values["external_prefix_cache_hit_rate_percent"] = (external_hits / external_queries * 100.0) if external_queries else 0.0
    local_compute = values.get("prompt_tokens_local_compute_total", 0.0)
    local_cache_hit = values.get("prompt_tokens_local_cache_hit_total", 0.0)
    prompt_total = local_compute + local_cache_hit
    if prompt_total:
        values["prompt_tokens_cache_hit_rate_percent"] = local_cache_hit / prompt_total * 100.0
    return values


def collect_kubernetes_status() -> Dict[str, Any]:
    if os.environ.get("CUSTOMER_SUPPORT_KUBECTL_METRICS", "1") == "0":
        return {"available": False, "disabled": True, "pods": []}
    cmd = ["kubectl", "get", "pods", "-A", "-o", "json"]
    try:
        completed = subprocess.run(cmd, text=True, capture_output=True, timeout=2.0, check=False)
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        return {"available": False, "error": str(exc), "pods": []}
    if completed.returncode != 0:
        return {"available": False, "error": completed.stderr[:300], "pods": []}
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"available": False, "error": "kubectl returned non-json output", "pods": []}

    pods = []
    for item in payload.get("items", []):
        metadata = item.get("metadata", {})
        namespace = metadata.get("namespace", "")
        labels = metadata.get("labels", {}) or {}
        if namespace not in {"aibrix-system", "envoy-gateway-system", "default"}:
            continue
        if namespace == "default" and labels.get("app") != "qwen3-4b-customer":
            continue
        status = item.get("status", {})
        container_statuses = status.get("containerStatuses", []) or []
        ready_containers = sum(1 for container in container_statuses if container.get("ready"))
        restarts = sum(int(container.get("restartCount") or 0) for container in container_statuses)
        pods.append(
            {
                "namespace": namespace,
                "name": metadata.get("name", ""),
                "phase": status.get("phase", ""),
                "ready": f"{ready_containers}/{len(container_statuses)}",
                "restarts": restarts,
                "pod_ip": status.get("podIP", ""),
                "node": item.get("spec", {}).get("nodeName", ""),
                "component": labels.get("app") or labels.get("app.kubernetes.io/name") or labels.get("control-plane") or "",
            }
        )
    return {"available": True, "pods": pods}


def metrics_history(db: Database, limit: int = 200) -> List[Dict[str, Any]]:
    rows = db.fetch_all(
        """
        SELECT source, metrics_json, created_at FROM metrics_samples
        ORDER BY sample_id DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [
        {
            "source": row["source"],
            "metrics": json_loads(row["metrics_json"], {}),
            "created_at": row["created_at"],
        }
        for row in rows
    ]
