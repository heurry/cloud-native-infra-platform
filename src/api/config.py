from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List

import yaml


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def resolve_project_path(value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return PROJECT_ROOT / path


def read_yaml(path: str | Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Expected mapping YAML at {path}")
    return data


def app_config_path() -> Path:
    return resolve_project_path(os.environ.get("CUSTOMER_SUPPORT_API_CONFIG", "configs/app/customer_support_api.yaml"))


def service_instances_path() -> Path:
    return resolve_project_path(os.environ.get("SERVICE_INSTANCES_CONFIG", "configs/app/service_instances.yaml"))


class AppConfig:
    def __init__(self, payload: Dict[str, Any]) -> None:
        self.payload = payload
        server = payload.get("server", {}) or {}
        storage = payload.get("storage", {}) or {}
        rag = payload.get("rag", {}) or {}
        chat = payload.get("chat", {}) or {}
        cors = payload.get("cors", {}) or {}

        self.host = str(server.get("host", "127.0.0.1"))
        self.port = int(server.get("port", 8088))
        self.database_path = resolve_project_path(str(storage.get("sqlite_path", "runs/app/customer_support.db")))
        self.rag_top_k = int(rag.get("top_k", 4))
        self.max_context_chars = int(rag.get("max_context_chars", 6000))
        self.default_endpoint = str(chat.get("default_endpoint", "aibrix-gateway"))
        self.fallback_endpoint = str(chat.get("fallback_endpoint", "vllm-replica-0"))
        self.default_max_tokens = int(chat.get("default_max_tokens", 256))
        self.temperature = float(chat.get("temperature", 0.0))
        self.request_timeout_seconds = int(chat.get("request_timeout_seconds", 300))
        self.allow_origins = list(cors.get("allow_origins", ["http://127.0.0.1:5173", "http://localhost:5173"]))


def load_app_config() -> AppConfig:
    return AppConfig(read_yaml(app_config_path()))


def load_service_instances() -> List[Dict[str, Any]]:
    path = service_instances_path()
    if not path.exists():
        return []
    payload = read_yaml(path)
    instances = payload.get("instances", [])
    if not isinstance(instances, list):
        raise ValueError(f"`instances` must be a list in {path}")
    return [item for item in instances if isinstance(item, dict)]
