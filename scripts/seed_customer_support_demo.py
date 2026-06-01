from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

import requests


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def post_json(base_url: str, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = requests.post(f"{base_url.rstrip('/')}{path}", json=payload, timeout=20)
    response.raise_for_status()
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed demo customer support knowledge and eval samples into the FastAPI gateway.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8088", help="FastAPI base URL.")
    parser.add_argument("--knowledge", type=Path, default=ROOT / "data/customer_support/knowledge_base.jsonl")
    parser.add_argument("--eval-qa", type=Path, default=ROOT / "data/customer_support/eval_qa.jsonl")
    parser.add_argument("--run-eval", action="store_true", help="Run retrieval eval after loading documents.")
    args = parser.parse_args()

    docs = list(read_jsonl(args.knowledge))
    for doc in docs:
        post_json(args.base_url, "/api/knowledge/documents", doc)
    rebuilt = post_json(args.base_url, "/api/knowledge/rebuild-index", {})

    result: Dict[str, Any] = {
        "documents_loaded": len(docs),
        "index": rebuilt,
    }
    if args.run_eval:
        qa_samples: List[Dict[str, Any]] = list(read_jsonl(args.eval_qa))
        result["eval"] = post_json(
            args.base_url,
            "/api/evals/customer-support",
            {"qa_samples": qa_samples, "top_k": 3},
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
