from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Sequence


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self._lock, self.connect() as conn:
            # Idempotent column additions for tables that pre-date AI Ops chat.
            for sql in (
                "ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'customer_support'",
                "ALTER TABLE conversations ADD COLUMN benchmark_id TEXT",
            ):
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError as exc:
                    msg = str(exc)
                    if "duplicate column" in msg or "no such table" in msg:
                        continue
                    raise

            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS knowledge_versions (
                    version TEXT PRIMARY KEY,
                    description TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS documents (
                    doc_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'general',
                    effective_from TEXT,
                    version TEXT NOT NULL DEFAULT 'default',
                    source_uri TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    session_id TEXT PRIMARY KEY,
                    title TEXT,
                    user_role TEXT NOT NULL DEFAULT 'customer',
                    kind TEXT NOT NULL DEFAULT 'customer_support',
                    benchmark_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    message_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES conversations(session_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS request_traces (
                    request_id TEXT PRIMARY KEY,
                    session_id TEXT,
                    retrieval_ms REAL,
                    queue_or_gateway_ms REAL,
                    ttft_ms REAL,
                    generation_ms REAL,
                    total_ms REAL,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    target_pod TEXT,
                    model_id TEXT,
                    fallback_reason TEXT,
                    citation_doc_ids TEXT,
                    endpoint_id TEXT,
                    status TEXT NOT NULL,
                    error TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS message_feedback (
                    feedback_id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    request_id TEXT,
                    rating TEXT NOT NULL,
                    note TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
                    FOREIGN KEY(session_id) REFERENCES conversations(session_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS service_instances (
                    name TEXT PRIMARY KEY,
                    base_url TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    gpu_id TEXT,
                    routing_role TEXT,
                    api_key TEXT NOT NULL DEFAULT 'EMPTY',
                    status TEXT NOT NULL DEFAULT 'unknown',
                    last_checked_at TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS eval_runs (
                    run_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    metrics_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS benchmark_runs (
                    run_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    endpoint_id TEXT,
                    workload TEXT,
                    routing_strategy TEXT,
                    config_json TEXT NOT NULL DEFAULT '{}',
                    summary_json TEXT NOT NULL DEFAULT '{}',
                    report_path TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS benchmark_samples (
                    sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES benchmark_runs(run_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS metrics_samples (
                    sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    metrics_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS audit_events (
                    event_id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL DEFAULT '',
                    actor_role TEXT NOT NULL DEFAULT '',
                    action TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                """
            )

    def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        with self._lock, self.connect() as conn:
            conn.execute(sql, params)

    def executemany(self, sql: str, rows: Iterable[Sequence[Any]]) -> None:
        with self._lock, self.connect() as conn:
            conn.executemany(sql, rows)

    def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> List[Dict[str, Any]]:
        with self._lock, self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def fetch_one(self, sql: str, params: Sequence[Any] = ()) -> Dict[str, Any] | None:
        with self._lock, self.connect() as conn:
            row = conn.execute(sql, params).fetchone()
            return dict(row) if row else None


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, default: Any = None) -> Any:
    if value is None or value == "":
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default
