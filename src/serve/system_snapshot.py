#!/usr/bin/env python3
"""Post-benchmark system state snapshot.

Captures four dimensions for AI-Ops analysis:
  - GPU (nvidia-smi: memory / utilization / processes)
  - Kubernetes (pods + recent events + node pressure)
  - vLLM /metrics endpoints (queue / KV cache / running requests)
  - vLLM + AIBrix gateway log tails (last N lines)

The snapshot is written as a single JSON file. It MUST be tolerant
of partial failures: each capture step catches its own exceptions
and records them in the output so the snapshot is always written.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests


DEFAULT_VLLM_METRICS_ENDPOINTS = [
    ("vllm-replica-0", "http://127.0.0.1:8000/metrics"),
    ("vllm-replica-1", "http://127.0.0.1:8001/metrics"),
    ("aibrix-gateway", "http://127.0.0.1:8010/metrics"),
]

DEFAULT_LOG_TAIL_LINES = 200

# Prometheus metric names we want to surface in the snapshot. Anything
# else is omitted to keep the snapshot small enough for an LLM context.
INTERESTING_VLLM_METRICS = {
    "vllm:num_requests_running",
    "vllm:num_requests_waiting",
    "vllm:num_requests_swapped",
    "vllm:gpu_cache_usage_perc",
    "vllm:kv_cache_usage_perc",
    "vllm:cpu_cache_usage_perc",
    "vllm:prompt_tokens_total",
    "vllm:generation_tokens_total",
    "vllm:e2e_request_latency_seconds_count",
    "vllm:time_to_first_token_seconds_count",
    "vllm:request_prefill_time_seconds_count",
    "vllm:request_decode_time_seconds_count",
    "vllm:prefix_cache_hits_total",
    "vllm:prefix_cache_queries_total",
    "vllm:request_success_total",
}


@dataclass
class SnapshotConfig:
    """Tunable inputs for capture_snapshot."""

    benchmark_id: str
    output_dir: Path
    benchmark_report_path: Optional[Path] = None
    vllm_metrics_endpoints: List[tuple[str, str]] = field(
        default_factory=lambda: list(DEFAULT_VLLM_METRICS_ENDPOINTS)
    )
    log_tail_lines: int = DEFAULT_LOG_TAIL_LINES
    kubectl_namespace: str = "default"
    kubectl_label_selector: str = "app=qwen3-4b-customer"
    aibrix_label_selector: str = "app=gateway-plugins"
    aibrix_namespace: str = "aibrix-system"
    # Read tail-of-file fallbacks when kubectl is unavailable.
    log_file_fallbacks: List[Path] = field(default_factory=list)


def capture_snapshot(config: SnapshotConfig) -> Dict[str, Any]:
    """Run all capture steps and write JSON to disk.

    Returns the snapshot dict so callers can pass it to the LLM
    directly without re-reading the file.
    """
    snapshot: Dict[str, Any] = {
        "schema_version": 1,
        "benchmark_id": config.benchmark_id,
        "benchmark_report_path": (
            str(config.benchmark_report_path)
            if config.benchmark_report_path
            else None
        ),
        "captured_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "host": _capture_host(),
        "gpu": _safe_call(_capture_gpu),
        "kubernetes": _safe_call(_capture_kubernetes, config),
        "vllm": _safe_call(_capture_vllm_metrics, config),
        "logs": _safe_call(_capture_logs, config),
        "listening_ports": _safe_call(_capture_listening_ports),
    }

    config.output_dir.mkdir(parents=True, exist_ok=True)
    out_path = config.output_dir / f"{config.benchmark_id}.json"
    out_path.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return snapshot


# ---------- capture helpers ----------------------------------------------------


def _safe_call(fn, *args, **kwargs) -> Any:
    """Run a capture function but never raise — record the error."""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def _capture_host() -> Dict[str, Any]:
    return {
        "hostname": socket.gethostname(),
        "cwd": os.getcwd(),
    }


# --- GPU ---------------------------------------------------------------------


def _capture_gpu() -> Dict[str, Any]:
    if shutil.which("nvidia-smi") is None:
        return {"available": False, "reason": "nvidia-smi not in PATH"}

    # Query GPUs.
    fields_gpu = [
        "index",
        "name",
        "memory.total",
        "memory.used",
        "memory.free",
        "utilization.gpu",
        "utilization.memory",
        "temperature.gpu",
        "power.draw",
        "power.limit",
    ]
    gpus_raw = subprocess.run(
        [
            "nvidia-smi",
            f"--query-gpu={','.join(fields_gpu)}",
            "--format=csv,noheader,nounits",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    gpus: List[Dict[str, Any]] = []
    for line in gpus_raw.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(fields_gpu):
            continue
        row: Dict[str, Any] = {}
        for key, value in zip(fields_gpu, parts):
            row[key] = _coerce_number(value) if value not in ("", "[N/A]") else None
        gpus.append(row)

    # Query GPU processes.
    fields_proc = ["pid", "process_name", "gpu_uuid", "used_memory"]
    procs_raw = subprocess.run(
        [
            "nvidia-smi",
            f"--query-compute-apps={','.join(fields_proc)}",
            "--format=csv,noheader,nounits",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    processes: List[Dict[str, Any]] = []
    for line in procs_raw.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(fields_proc):
            continue
        row = {key: _coerce_number(val) if key in ("pid", "used_memory") else val for key, val in zip(fields_proc, parts)}
        processes.append(row)

    return {"available": True, "gpus": gpus, "processes": processes}


# --- Kubernetes --------------------------------------------------------------


def _capture_kubernetes(config: SnapshotConfig) -> Dict[str, Any]:
    if shutil.which("kubectl") is None:
        return {"available": False, "reason": "kubectl not in PATH"}

    out: Dict[str, Any] = {"available": True}

    # pods
    pods_raw = _kubectl(
        ["get", "pods", "-A", "-o", "json"],
        timeout=15,
    )
    if pods_raw:
        try:
            data = json.loads(pods_raw)
            out["pods"] = [
                _slim_pod(item) for item in data.get("items", [])
            ]
        except json.JSONDecodeError:
            out["pods_error"] = "kubectl returned non-JSON output"

    # events (most recent 50 warning + most recent 30 normal)
    events_raw = _kubectl(
        ["get", "events", "-A", "--sort-by=.lastTimestamp", "-o", "json"],
        timeout=15,
    )
    if events_raw:
        try:
            data = json.loads(events_raw)
            items = data.get("items", [])
            slimmed = [_slim_event(item) for item in items]
            warnings = [e for e in slimmed if e.get("type") == "Warning"]
            normals = [e for e in slimmed if e.get("type") != "Warning"]
            out["events_warning_recent"] = warnings[-50:]
            out["events_normal_recent"] = normals[-30:]
        except json.JSONDecodeError:
            out["events_error"] = "kubectl returned non-JSON output"

    # node pressure (kubectl top, plus describe nodes for conditions)
    top_raw = _kubectl(["top", "nodes", "--no-headers"], timeout=10)
    if top_raw:
        nodes_top = []
        for line in top_raw.strip().splitlines():
            parts = re.split(r"\s+", line.strip())
            if len(parts) >= 5:
                nodes_top.append({
                    "name": parts[0],
                    "cpu_cores": parts[1],
                    "cpu_percent": parts[2],
                    "memory": parts[3],
                    "memory_percent": parts[4],
                })
        out["nodes_top"] = nodes_top

    # node conditions
    nodes_raw = _kubectl(["get", "nodes", "-o", "json"], timeout=10)
    if nodes_raw:
        try:
            data = json.loads(nodes_raw)
            nodes_info = []
            for item in data.get("items", []):
                conds = item.get("status", {}).get("conditions", [])
                pressure = {
                    c.get("type"): {"status": c.get("status"), "reason": c.get("reason")}
                    for c in conds
                    if c.get("type") in ("MemoryPressure", "DiskPressure", "PIDPressure", "Ready")
                }
                nodes_info.append({
                    "name": item.get("metadata", {}).get("name"),
                    "conditions": pressure,
                    "allocatable": item.get("status", {}).get("allocatable", {}),
                })
            out["nodes"] = nodes_info
        except json.JSONDecodeError:
            out["nodes_error"] = "kubectl returned non-JSON output"

    return out


def _slim_pod(item: Dict[str, Any]) -> Dict[str, Any]:
    """Reduce a pod manifest to the few fields AI Ops cares about."""
    meta = item.get("metadata", {})
    spec = item.get("spec", {})
    status = item.get("status", {})
    container_statuses = status.get("containerStatuses") or []
    restarts = sum((c.get("restartCount") or 0) for c in container_statuses)
    return {
        "name": meta.get("name"),
        "namespace": meta.get("namespace"),
        "phase": status.get("phase"),
        "node": spec.get("nodeName"),
        "ip": status.get("podIP"),
        "start_time": status.get("startTime"),
        "restarts": restarts,
        "ready": all(c.get("ready") for c in container_statuses) if container_statuses else None,
        "container_statuses": [
            {
                "name": c.get("name"),
                "ready": c.get("ready"),
                "restartCount": c.get("restartCount"),
                "state": list((c.get("state") or {}).keys())[:1],
                "lastTerminationReason": (
                    (c.get("lastState") or {}).get("terminated", {}).get("reason")
                ),
            }
            for c in container_statuses
        ],
    }


def _slim_event(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "namespace": item.get("metadata", {}).get("namespace"),
        "type": item.get("type"),
        "reason": item.get("reason"),
        "message": (item.get("message") or "").strip()[:240],
        "object": (item.get("involvedObject") or {}).get("kind") + "/" + (item.get("involvedObject") or {}).get("name", ""),
        "first_seen": item.get("firstTimestamp"),
        "last_seen": item.get("lastTimestamp"),
        "count": item.get("count"),
    }


# --- vLLM metrics ------------------------------------------------------------


def _capture_vllm_metrics(config: SnapshotConfig) -> Dict[str, Any]:
    """Probe each /metrics endpoint.

    Records `reachable` + `status` such that the summary can clearly say:
      - "no metrics endpoint" (HTTP 4xx) — service alive, just doesn't expose Prometheus
      - "connection refused"  (network) — service genuinely down
      - "timeout"             (slow)    — service alive but unresponsive
    Distinguishing these matters: AI Ops mistakes "404" for "service down"
    if we lump everything as "unreachable".
    """
    out: Dict[str, Any] = {"endpoints": []}
    for name, url in config.vllm_metrics_endpoints:
        endpoint_report: Dict[str, Any] = {"name": name, "url": url}
        try:
            resp = requests.get(url, timeout=4)
        except requests.exceptions.ConnectionError as exc:
            endpoint_report["reachable"] = False
            endpoint_report["status"] = "connection_refused"
            endpoint_report["error"] = str(exc)[:200]
            out["endpoints"].append(endpoint_report)
            continue
        except requests.exceptions.Timeout as exc:
            endpoint_report["reachable"] = False
            endpoint_report["status"] = "timeout"
            endpoint_report["error"] = str(exc)[:200]
            out["endpoints"].append(endpoint_report)
            continue
        except Exception as exc:  # noqa: BLE001
            endpoint_report["reachable"] = False
            endpoint_report["status"] = "error"
            endpoint_report["error"] = f"{type(exc).__name__}: {exc}"[:200]
            out["endpoints"].append(endpoint_report)
            continue

        if resp.status_code == 200:
            endpoint_report["reachable"] = True
            endpoint_report["status"] = "ok"
            endpoint_report["metrics"] = _parse_prometheus_text(resp.text)
        elif resp.status_code in (404, 405):
            # Service answers — it just doesn't expose Prometheus /metrics.
            # The pod is healthy.  Common for AIBrix gateway / Envoy variants.
            endpoint_report["reachable"] = False
            endpoint_report["status"] = "no_metrics_endpoint"
            endpoint_report["http_status"] = resp.status_code
        else:
            endpoint_report["reachable"] = False
            endpoint_report["status"] = "http_error"
            endpoint_report["http_status"] = resp.status_code
            endpoint_report["error"] = resp.text[:200]
        out["endpoints"].append(endpoint_report)
    return out


def _parse_prometheus_text(text: str) -> Dict[str, Any]:
    """Extract only the metrics in INTERESTING_VLLM_METRICS as numbers/dicts."""
    bucket: Dict[str, List[Dict[str, Any]]] = {name: [] for name in INTERESTING_VLLM_METRICS}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # metric_name{labels} value [timestamp]
        match = re.match(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([\-+0-9eE\.]+)", line)
        if not match:
            continue
        name = match.group(1)
        if name not in bucket:
            continue
        labels_str = match.group(2) or ""
        value = match.group(3)
        labels = {}
        for kv in re.findall(r'([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"', labels_str):
            labels[kv[0]] = kv[1]
        bucket[name].append({"labels": labels, "value": _coerce_number(value)})
    # Strip empty entries to keep the JSON compact.
    return {k: v for k, v in bucket.items() if v}


# --- Logs --------------------------------------------------------------------


def _capture_logs(config: SnapshotConfig) -> Dict[str, Any]:
    out: Dict[str, Any] = {}

    # vLLM pod logs (via kubectl)
    if shutil.which("kubectl"):
        vllm_log = _kubectl(
            [
                "logs",
                "-n", config.kubectl_namespace,
                "-l", config.kubectl_label_selector,
                "--all-containers",
                f"--tail={config.log_tail_lines}",
            ],
            timeout=15,
        )
        if vllm_log:
            out["vllm_pods"] = _tail_block(vllm_log, config.log_tail_lines)

        gateway_log = _kubectl(
            [
                "logs",
                "-n", config.aibrix_namespace,
                "-l", config.aibrix_label_selector,
                "--all-containers",
                f"--tail={config.log_tail_lines}",
            ],
            timeout=15,
        )
        if gateway_log:
            out["aibrix_gateway"] = _tail_block(gateway_log, config.log_tail_lines)

    # Local log file fallbacks (e.g. when serve is via systemd / direct binary,
    # not k8s).  These augment, never replace, the kubectl output.
    fallback_dump: Dict[str, str] = {}
    for path in config.log_file_fallbacks:
        try:
            if path.exists():
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
                fallback_dump[str(path)] = "\n".join(lines[-config.log_tail_lines:])
        except Exception as exc:  # noqa: BLE001
            fallback_dump[str(path)] = f"[snapshot error] {type(exc).__name__}: {exc}"
    if fallback_dump:
        out["file_fallbacks"] = fallback_dump

    return out


def _tail_block(text: str, lines: int) -> str:
    parts = text.splitlines()
    if len(parts) <= lines:
        return text
    return "\n".join(parts[-lines:])


# --- Listening ports ---------------------------------------------------------


def _capture_listening_ports() -> List[Dict[str, Any]]:
    if shutil.which("ss") is None:
        return []
    raw = subprocess.run(
        ["ss", "-ltnp"],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    rows: List[Dict[str, Any]] = []
    for line in raw.stdout.splitlines()[1:]:
        parts = re.split(r"\s+", line.strip(), maxsplit=5)
        if len(parts) < 5:
            continue
        local_address = parts[3]
        process = parts[5] if len(parts) >= 6 else ""
        rows.append({"local_address": local_address, "process": process})
    return rows


# ---------- common -----------------------------------------------------------


def _kubectl(args: Iterable[str], timeout: int = 15) -> Optional[str]:
    try:
        proc = subprocess.run(
            ["kubectl", *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0 and not proc.stdout:
            return None
        return proc.stdout
    except subprocess.TimeoutExpired:
        return None
    except FileNotFoundError:
        return None


def _coerce_number(value: str) -> Any:
    try:
        if "." in value or "e" in value or "E" in value:
            return float(value)
        return int(value)
    except (ValueError, TypeError):
        return value


# ---------- summary helper used by AI Ops backend ----------------------------


def summarize_snapshot(snapshot: Dict[str, Any], max_chars_per_section: int = 1500) -> str:
    """Build a compact text summary suitable for injecting into an LLM prompt.

    A semantic header is prepended so the analyst LLM correctly interprets the
    snapshot as a POST-benchmark moment (idle), not a live during-load state.
    Without this header, qwen3 reliably mis-reads zero-load metrics as failures.
    """
    lines: List[str] = []
    lines.append(
        "⚠ 阅读说明 (重要):本快照在 benchmark 结束、流量回落到 0 之后才采集。\n"
        "  - vLLM 的 running / waiting / kv_cache_usage = 快照那一刻的瞬时值,\n"
        "    benchmark 已停 → 这些字段为 0 是空闲态,不是服务故障。\n"
        "  - prompt_tokens_total / generation_tokens_total / request_success_total\n"
        "    = 进程启动以来的累计计数,可以反推 benchmark 期间处理的总量。\n"
        "  - GPU 显存常驻 ~21 GB 主要是模型权重 (4B FP16 + 量化激活),\n"
        "    与 KV Cache 利用率独立。\n"
        "  - 想了解 benchmark 进行中的指标趋势,请以上方 Benchmark 报告里\n"
        "    各 concurrency 的 summary 为准,不要拿这里的瞬时 0 值反推。\n"
    )
    lines.append(f"captured_at: {snapshot.get('captured_at')}")
    lines.append(f"benchmark_id: {snapshot.get('benchmark_id')}")

    # GPU
    gpu = snapshot.get("gpu") or {}
    if isinstance(gpu, dict) and gpu.get("available"):
        lines.append("\n[GPU]")
        for g in (gpu.get("gpus") or []):
            lines.append(
                f"  gpu{g.get('index')} {g.get('name')}: "
                f"mem {g.get('memory.used')}/{g.get('memory.total')} MiB "
                f"util {g.get('utilization.gpu')}% temp {g.get('temperature.gpu')}C"
            )
        procs = gpu.get("processes") or []
        if procs:
            lines.append(f"  processes: {len(procs)} active")

    # K8s — current state first, historical events second.  This ordering
    # matters: AI Ops mistakes old Readiness probe events for active incidents.
    k = snapshot.get("kubernetes") or {}
    if isinstance(k, dict) and k.get("available"):
        pods = k.get("pods") or []
        running_pods = [p for p in pods if p.get("phase") == "Running"]
        not_running = [p for p in pods if p.get("phase") and p.get("phase") != "Running"]
        lines.append(f"\n[Kubernetes] 当前状态: {len(running_pods)}/{len(pods)} pods Running"
                     + (f", {len(not_running)} not Running" if not_running else ""))
        for p in not_running[:10]:
            lines.append(f"  ⚠ {p.get('namespace')}/{p.get('name')}: phase={p.get('phase')} restarts={p.get('restarts')} last_terminated={[c.get('lastTerminationReason') for c in (p.get('container_statuses') or []) if c.get('lastTerminationReason')]}")
        warnings = k.get("events_warning_recent") or []
        if warnings:
            lines.append(
                f"  历史 warning 事件 (注意:K8s 默认保留 1 小时,这些可能是过去的瞬时问题,"
                f"如果当前 pods 都 Running,事件多半已自愈): {len(warnings)} 条"
            )
            for ev in warnings[-8:]:
                # last_seen helps the LLM tell stale from fresh.
                last_seen = ev.get("last_seen") or ev.get("first_seen") or "?"
                count = ev.get("count")
                count_part = f" x{count}" if count and count > 1 else ""
                lines.append(
                    f"    [{last_seen}{count_part}] {ev.get('reason')} "
                    f"{ev.get('object')}: {ev.get('message','')[:120]}"
                )

    # vLLM
    v = snapshot.get("vllm") or {}
    if isinstance(v, dict):
        lines.append("\n[vLLM metrics]")
        for endpoint in v.get("endpoints", []):
            if not endpoint.get("reachable"):
                status = endpoint.get("status", "unreachable")
                if status == "no_metrics_endpoint":
                    # Service is alive — it just doesn't expose Prometheus.
                    # Do NOT phrase this as "down" to avoid AI Ops false alarms.
                    lines.append(
                        f"  {endpoint['name']}: 服务可用,但未暴露 /metrics "
                        f"(HTTP {endpoint.get('http_status')}) — 不代表服务故障"
                    )
                elif status == "connection_refused":
                    lines.append(f"  {endpoint['name']}: 连接被拒 (服务可能已停止) — {endpoint.get('error','')[:80]}")
                elif status == "timeout":
                    lines.append(f"  {endpoint['name']}: 超时 (服务存活但无响应) — {endpoint.get('error','')[:80]}")
                else:
                    lines.append(f"  {endpoint['name']}: {status} {endpoint.get('error','')[:80]}")
                continue
            metrics = endpoint.get("metrics") or {}
            # IMPORTANT: do NOT use `a or b` to pick between metric names —
            # a legitimate 0.0 value would be treated as falsy and silently
            # fall through to the next name (or None), making the LLM think
            # the data is missing.  Use explicit None check via _pick_metric.
            running = _pick_metric(metrics, "vllm:num_requests_running")
            waiting = _pick_metric(metrics, "vllm:num_requests_waiting")
            swapped = _pick_metric(metrics, "vllm:num_requests_swapped")
            kv = _pick_metric(metrics, "vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc")
            cpu_cache = _pick_metric(metrics, "vllm:cpu_cache_usage_perc")
            prompt_tot = _pick_metric(metrics, "vllm:prompt_tokens_total")
            gen_tot = _pick_metric(metrics, "vllm:generation_tokens_total")
            success_tot = _pick_metric(metrics, "vllm:request_success_total")
            prefix_hits = _pick_metric(metrics, "vllm:prefix_cache_hits_total")
            prefix_q = _pick_metric(metrics, "vllm:prefix_cache_queries_total")

            line = (
                f"  {endpoint['name']}: "
                f"running={_fmt_metric(running)} "
                f"waiting={_fmt_metric(waiting)} "
                f"swapped={_fmt_metric(swapped)} "
                f"kv_cache_usage={_fmt_metric(kv)} "
                f"cpu_cache_usage={_fmt_metric(cpu_cache)}"
            )
            lines.append(line)
            if prompt_tot is not None or gen_tot is not None or success_tot is not None:
                lines.append(
                    f"    tokens: prompt={_fmt_metric(prompt_tot)} "
                    f"generation={_fmt_metric(gen_tot)} "
                    f"successful_requests={_fmt_metric(success_tot)}"
                )
            if prefix_hits is not None and prefix_q is not None and prefix_q:
                hit_rate = (prefix_hits / prefix_q) if prefix_q else None
                lines.append(
                    f"    prefix_cache: hits={int(prefix_hits)} queries={int(prefix_q)} "
                    f"hit_rate={hit_rate:.2%}" if hit_rate is not None else f"    prefix_cache: hits={prefix_hits} queries={prefix_q}"
                )

    # Logs (truncated to keep prompt manageable)
    logs = snapshot.get("logs") or {}
    for k_log in ("vllm_pods", "aibrix_gateway"):
        v_log = logs.get(k_log)
        if isinstance(v_log, str) and v_log:
            tail = v_log[-max_chars_per_section:]
            lines.append(f"\n[Log: {k_log} — last {len(tail)} chars]")
            lines.append(tail)

    return "\n".join(lines)


def _first_value(metrics: Dict[str, List[Dict[str, Any]]], name: str) -> Any:
    """Return the first sample's value for a Prometheus metric, or None.

    Note: a legitimate value of 0 / 0.0 IS returned (not None). Callers
    must use explicit `is None` checks rather than truthiness if they
    want to distinguish "missing metric" from "metric == 0".
    """
    rows = metrics.get(name) or []
    if not rows:
        return None
    return rows[0].get("value")


def _pick_metric(metrics: Dict[str, List[Dict[str, Any]]], *names: str) -> Any:
    """Try each metric name in order; return the first value that is not None.

    Replaces the `a or b` idiom which mistreated 0.0 as missing.
    """
    for name in names:
        value = _first_value(metrics, name)
        if value is not None:
            return value
    return None


def _fmt_metric(value: Any) -> str:
    """Render a metric value for the LLM summary.

    `None`  → "n/a"     (clearly distinct from numeric 0)
    `0` / `0.0` → "0"   (preserved, not stringified as missing)
    floats  → 4 sig fig
    """
    if value is None:
        return "n/a"
    if isinstance(value, float):
        if value == 0:
            return "0"
        if abs(value) < 0.01 or abs(value) >= 10000:
            return f"{value:.3g}"
        return f"{value:.4g}"
    return str(value)


# ---------- CLI for ad-hoc capture ------------------------------------------


def _main_cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Capture post-benchmark system snapshot.")
    parser.add_argument("--benchmark_id", required=True, help="Identifier (used as filename)")
    parser.add_argument("--output_dir", default="runs/benchmark/snapshots")
    parser.add_argument("--benchmark_report", default=None)
    parser.add_argument("--log_tail_lines", type=int, default=DEFAULT_LOG_TAIL_LINES)
    args = parser.parse_args()

    cfg = SnapshotConfig(
        benchmark_id=args.benchmark_id,
        output_dir=Path(args.output_dir),
        benchmark_report_path=Path(args.benchmark_report) if args.benchmark_report else None,
        log_tail_lines=args.log_tail_lines,
    )
    snapshot = capture_snapshot(cfg)
    print(f"[snapshot] wrote {cfg.output_dir / (cfg.benchmark_id + '.json')}")
    print(summarize_snapshot(snapshot))


if __name__ == "__main__":
    _main_cli()
