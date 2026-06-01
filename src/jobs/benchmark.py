from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List

from src.api.config import PROJECT_ROOT
from src.api.db import Database, json_dumps, utc_now


def append_event(db: Database, run_id: str, event_type: str, payload: Dict[str, Any]) -> None:
    db.execute(
        """
        INSERT INTO benchmark_samples(run_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (run_id, event_type, json_dumps(payload), utc_now()),
    )


def _insert_benchmark_trace(db: Database, run_id: str, endpoint: Dict[str, Any], payload: Dict[str, Any]) -> None:
    total_ms = None
    if payload.get("end_to_end_latency_seconds") is not None:
        total_ms = float(payload["end_to_end_latency_seconds"]) * 1000.0
    ttft_ms = None
    if payload.get("ttft_seconds") is not None:
        ttft_ms = float(payload["ttft_seconds"]) * 1000.0
    generation_ms = None
    if total_ms is not None:
        generation_ms = max(total_ms - (ttft_ms or 0.0), 0.0)
    error = payload.get("error")
    db.execute(
        """
        INSERT OR REPLACE INTO request_traces(
            request_id, session_id, retrieval_ms, queue_or_gateway_ms, ttft_ms, generation_ms,
            total_ms, input_tokens, output_tokens, target_pod, model_id, fallback_reason,
            citation_doc_ids, endpoint_id, status, error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.get("request_id"),
            run_id,
            None,
            None,
            ttft_ms,
            generation_ms,
            total_ms,
            int(payload.get("input_tokens") or 0),
            int(payload.get("output_tokens") or 0),
            payload.get("target_pod") or endpoint.get("name", ""),
            endpoint.get("model_id", ""),
            "",
            "[]",
            endpoint.get("name", ""),
            "error" if error else "ok",
            str(error) if error else None,
            utc_now(),
        ),
    )


def start_serving_benchmark_job(
    *,
    db: Database,
    run_id: str,
    endpoint: Dict[str, Any],
    request: Dict[str, Any],
) -> None:
    thread = threading.Thread(
        target=_run_serving_benchmark,
        kwargs={"db": db, "run_id": run_id, "endpoint": endpoint, "request": request},
        daemon=True,
    )
    thread.start()


def _run_serving_benchmark(*, db: Database, run_id: str, endpoint: Dict[str, Any], request: Dict[str, Any]) -> None:
    output_json = PROJECT_ROOT / "runs" / "benchmark" / f"{run_id}.json"
    output_report = PROJECT_ROOT / "runs" / "benchmark" / f"{run_id}.md"
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_report.parent.mkdir(parents=True, exist_ok=True)
    tokenizer_path = PROJECT_ROOT / "model" / "Qwen3.5-4B"
    workload = str(request.get("workload") or "mixed_peak")

    cmd: List[str] = [
        sys.executable,
        "scripts/11_benchmark_serving.py",
        "--endpoint_label",
        str(endpoint["name"]),
        "--base_url",
        str(endpoint["base_url"]),
        "--model",
        str(endpoint["model_id"]),
        "--concurrency_levels",
        ",".join(str(item) for item in request.get("concurrency_levels", [1, 2, 4])),
        "--requests_per_level",
        str(request.get("requests_per_level", 16)),
        "--prompt_profile",
        workload,
        "--tokenizer_path",
        str(tokenizer_path),
        "--max_tokens",
        str(request.get("max_tokens", 256)),
        "--routing_strategy",
        str(request.get("routing_strategy", "")),
        "--user",
        "" if str(endpoint.get("kind")) == "aibrix" else "benchmark",
        "--output_json",
        str(output_json),
        "--output_report",
        str(output_report),
        "--emit_progress",
    ]
    append_event(db, run_id, "started", {"cmd": cmd})
    db.execute(
        "UPDATE benchmark_runs SET status=?, updated_at=? WHERE run_id=?",
        ("running", utc_now(), run_id),
    )

    try:
        completed = subprocess.Popen(
            cmd,
            cwd=PROJECT_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
        output_lines: List[str] = []
        assert completed.stdout is not None
        for raw_line in completed.stdout:
            line = raw_line.rstrip()
            output_lines.append(line)
            output_lines = output_lines[-400:]
            if not line.startswith("__BENCHMARK_EVENT__ "):
                continue
            try:
                event = json.loads(line.split(" ", 1)[1])
            except json.JSONDecodeError:
                append_event(db, run_id, "progress_parse_error", {"line": line[:1000]})
                continue
            event_type = str(event.get("event_type") or "progress")
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            append_event(db, run_id, event_type, payload)
            if event_type == "request":
                _insert_benchmark_trace(db, run_id, endpoint, payload)
        returncode = completed.wait(timeout=30)
        append_event(
            db,
            run_id,
            "process_exit",
            {
                "returncode": returncode,
                "stdout_tail": "\n".join(output_lines)[-4000:],
                "stderr_tail": "",
            },
        )
        summary: Dict[str, Any] = {}
        if output_json.exists():
            payload = json.loads(output_json.read_text(encoding="utf-8"))
            summary = payload.get("scenarios", [])
        status = "completed" if returncode == 0 else "failed"
        db.execute(
            """
            UPDATE benchmark_runs
            SET status=?, summary_json=?, report_path=?, error=?, updated_at=?
            WHERE run_id=?
            """,
            (
                status,
                json_dumps({"scenarios": summary}),
                str(output_report),
                "\n".join(output_lines)[-1000:] if returncode != 0 else None,
                utc_now(),
                run_id,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - background job must persist failure detail.
        append_event(db, run_id, "error", {"error": str(exc)})
        db.execute(
            "UPDATE benchmark_runs SET status=?, error=?, updated_at=? WHERE run_id=?",
            ("failed", str(exc), utc_now(), run_id),
        )
