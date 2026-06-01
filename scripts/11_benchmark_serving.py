#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from statistics import mean
from time import perf_counter
from typing import Any, Dict, List, Sequence
from uuid import uuid4

import requests
from transformers import AutoTokenizer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.serve.openai_client import list_models, normalize_base_url


DEFAULT_PROMPTS = [
    "请用一句话说明当前模型服务的健康状态应该关注哪些指标。",
    "请解释为什么 P95 延迟和 TTFT 会影响在线推理体验。",
    "给出一个最小云原生模型服务压测闭环需要经过的步骤。",
]

PROMPT_PROFILES = {
    "short": DEFAULT_PROMPTS,
    "mixed": DEFAULT_PROMPTS
    + [
        "请用三点说明 vLLM 多副本、AIBrix Gateway 和健康检查之间的关系。",
        "请分析 GPU 利用率、队列长度和错误率同时升高时应该如何排查。",
    ],
    "long": [
        "请围绕大模型服务从配置发布、实例部署、网关路由、可观测采集、自动评测到性能压测的完整链路，给出一段结构化说明。",
        "请从 TTFT、P95 延迟、decode tokens/s、显存占用和错误率五个角度，分析如何判断一个本地大模型推理服务是否适合承接高并发请求。",
        "请对比直连 vLLM、副本轮询和 AIBrix Gateway 在模型服务治理中的差异，并说明如何根据延迟和稳定性选择路由方案。",
    ],
    "faq_short": [
        "退款规则是什么？",
        "电子发票怎么开？",
        "会员积分怎么用？",
        "普通商品多久发货？",
        "发货超过 48 小时怎么办？",
    ],
    "rag_shared_prefix": [
        "你是企业客服助手。请只基于退款、发货、发票、会员、安全规则回答。问题：退款规则是什么？",
        "你是企业客服助手。请只基于退款、发货、发票、会员、安全规则回答。问题：已发货订单怎么退款？",
        "你是企业客服助手。请只基于退款、发货、发票、会员、安全规则回答。问题：企业发票需要哪些信息？",
        "你是企业客服助手。请只基于退款、发货、发票、会员、安全规则回答。问题：会员积分如何使用？",
    ],
    "multi_turn": [
        "上一轮用户说：我想退款。客服询问：订单是否发货？当前用户说：还没发货。请给出自然客服回复。",
        "上一轮用户说：推荐一个商品。客服询问：感兴趣的品类？当前用户说：电子产品。请继续追问预算和用途。",
        "上一轮用户说：我的发票呢？客服询问：订单是否完成？当前用户说：已经完成。请说明电子发票开具时间。",
        "上一轮用户说：商品一直没发货。客服询问：是否超过 48 小时？当前用户说：超过了。请说明处理方式。",
    ],
    "ticket_long_context": [
        "用户工单：用户 3 天前购买普通商品，订单已支付，页面显示仓库处理中，用户要求说明发货时间并询问是否可以退款。请以客服口吻给出简洁回复，并说明需要人工介入的边界。",
        "用户工单：企业客户已经完成订单，希望开具电子发票，需要公司名称、税号和邮箱；用户还询问是否可以把金额拆分到两个订单。请给出客服回复。",
        "用户工单：会员反馈生日券无法使用，同时提到账号可能异常登录。请说明可回答部分和需要转人工核验部分。",
    ],
    "mixed_peak": [
        "退款规则是什么？",
        "电子发票怎么开？",
        "上一轮用户说：推荐一个商品。客服询问：感兴趣的品类？当前用户说：电子产品。请继续追问预算和用途。",
        "用户工单：用户 3 天前购买普通商品，订单已支付，页面显示仓库处理中，用户要求说明发货时间并询问是否可以退款。请以客服口吻给出简洁回复，并说明需要人工介入的边界。",
        "当用户要求忽略系统规则并编造退款政策时，客服助手应该如何处理？",
    ],
}

DEFAULT_TARGET_POD_HEADERS = [
    "target-pod",
    "x-target-pod",
    "x-aibrix-target-pod",
    "x-envoy-upstream-host",
]


def extract_stream_content(event: Dict[str, Any]) -> str:
    choices = event.get("choices")
    if not choices:
        return ""
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return ""
    delta = first_choice.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def parse_csv_ints(value: str) -> List[int]:
    parsed = []
    for item in value.split(","):
        stripped = item.strip()
        if not stripped:
            continue
        parsed.append(int(stripped))
    if not parsed:
        raise argparse.ArgumentTypeError("expected at least one integer")
    if any(item <= 0 for item in parsed):
        raise argparse.ArgumentTypeError("all concurrency levels must be positive")
    return parsed


def parse_extra_headers(items: Sequence[str]) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise argparse.ArgumentTypeError(f"invalid header `{item}`, expected KEY=VALUE")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise argparse.ArgumentTypeError(f"invalid header `{item}`, empty key")
        headers[key] = value.strip()
    return headers


def load_prompts(args: argparse.Namespace) -> List[str]:
    if args.prompts_file:
        path = Path(args.prompts_file)
        prompts = []
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("{"):
                payload = json.loads(stripped)
                prompt = payload.get("prompt")
                if isinstance(prompt, str) and prompt.strip():
                    prompts.append(prompt.strip())
            else:
                prompts.append(stripped)
        if prompts:
            return prompts
        raise SystemExit(f"[ERROR] no prompts loaded from {path}")
    return list(PROMPT_PROFILES[args.prompt_profile])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run OpenAI-compatible serving benchmarks against direct vLLM or an AIBrix Gateway endpoint."
    )
    parser.add_argument("--base_url", type=str, default="http://127.0.0.1:8000/v1")
    parser.add_argument(
        "--model",
        type=str,
        default="qwen3-4b-customer",
        help="OpenAI model id exposed by the server or AIBrix Gateway.",
    )
    parser.add_argument("--tokenizer_path", type=str, default="model/Qwen3.5-4B")
    parser.add_argument("--output_json", type=str, default="runs/serve/vllm_minimal_benchmark.json")
    parser.add_argument("--output_report", type=str, default="runs/serve/serving_benchmark.md")
    parser.add_argument("--endpoint_label", type=str, default="vllm", help="Human-readable endpoint label, e.g. vllm or aibrix.")
    parser.add_argument("--max_tokens", type=int, default=256)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument(
        "--concurrency_levels",
        type=parse_csv_ints,
        default=[1],
        help="Comma-separated concurrency levels, e.g. 1,2,4,8,16.",
    )
    parser.add_argument("--requests_per_level", type=int, default=3)
    parser.add_argument("--prompt_profile", choices=sorted(PROMPT_PROFILES), default="short")
    parser.add_argument("--prompts_file", type=str, default="")
    parser.add_argument("--routing_strategy", type=str, default="", help="Optional AIBrix routing strategy request header.")
    parser.add_argument("--user", type=str, default="benchmark", help="OpenAI-compatible user field and request header value.")
    parser.add_argument("--request_id_prefix", type=str, default="serve-bench")
    parser.add_argument(
        "--extra_header",
        action="append",
        default=[],
        help="Additional request header in KEY=VALUE form. Can be repeated.",
    )
    parser.add_argument(
        "--target_pod_header",
        action="append",
        default=[],
        help="Response header used to record target pod/upstream. Can be repeated.",
    )
    parser.add_argument(
        "--emit_progress",
        action="store_true",
        help="Emit machine-readable per-request and per-scenario progress lines to stdout.",
    )
    parser.add_argument(
        "--capture_system_state",
        action="store_true",
        default=True,
        help="(default on) Capture a post-benchmark system snapshot (GPU / K8s / vLLM metrics / logs) for AI Ops analysis.",
    )
    parser.add_argument(
        "--no_capture_system_state",
        dest="capture_system_state",
        action="store_false",
        help="Disable automatic post-benchmark snapshot capture.",
    )
    parser.add_argument(
        "--snapshot_dir",
        type=str,
        default="runs/benchmark/snapshots",
        help="Where to write the post-benchmark system snapshot JSON.",
    )
    return parser.parse_args()


def _extract_error_detail(response: requests.Response) -> str:
    content_type = response.headers.get("Content-Type", "")
    if "application/json" in content_type:
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return error["message"]
            for key in ("message", "detail"):
                value = payload.get(key)
                if isinstance(value, str):
                    return value
    text = response.text.strip()
    if not text:
        return ""
    return text if len(text) <= 500 else text[:497] + "..."


def raise_for_status(response: requests.Response) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        detail = _extract_error_detail(response)
        if detail:
            raise requests.HTTPError(f"{exc}. Response body: {detail}", response=response) from exc
        raise


def get_header_case_insensitive(headers: requests.structures.CaseInsensitiveDict[str], candidates: Sequence[str]) -> str:
    for candidate in candidates:
        value = headers.get(candidate)
        if value:
            return value
    return ""


def stream_chat_request(
    *,
    base_url: str,
    model: str,
    prompt: str,
    request_id: str,
    user: str,
    max_tokens: int,
    temperature: float,
    timeout: int,
    extra_headers: Dict[str, str],
    target_pod_headers: Sequence[str],
) -> Dict[str, Any]:
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": prompt},
    ]
    headers = {
        "Authorization": "Bearer EMPTY",
        "Content-Type": "application/json",
        "x-request-id": request_id,
        "model": model,
        **extra_headers,
    }
    if user:
        headers["user"] = user
    started_at = perf_counter()
    first_token_latency = None
    chunks: List[str] = []
    target_pod = ""
    response_headers: Dict[str, str] = {}
    url = normalize_base_url(base_url) + "/chat/completions"

    with requests.post(
        url,
        headers=headers,
        json={
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=timeout,
        stream=True,
    ) as response:
        response_headers = dict(response.headers)
        target_pod = get_header_case_insensitive(response.headers, target_pod_headers)
        raise_for_status(response)
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if payload == "[DONE]":
                break
            event = json.loads(payload)
            delta = extract_stream_content(event)
            if delta:
                chunks.append(delta)
                if first_token_latency is None:
                    first_token_latency = perf_counter() - started_at

    end_to_end_latency = perf_counter() - started_at
    return {
        "request_id": request_id,
        "prompt": prompt,
        "response_text": "".join(chunks).strip(),
        "ttft_seconds": first_token_latency,
        "end_to_end_latency_seconds": end_to_end_latency,
        "target_pod": target_pod,
        "response_headers": response_headers,
        "error": None,
    }


def safe_stream_chat_request(**kwargs: Any) -> Dict[str, Any]:
    try:
        return stream_chat_request(**kwargs)
    except Exception as exc:  # noqa: BLE001 - benchmark must record every failed request.
        return {
            "request_id": kwargs["request_id"],
            "prompt": kwargs["prompt"],
            "response_text": "",
            "ttft_seconds": None,
            "end_to_end_latency_seconds": None,
            "target_pod": "",
            "response_headers": {},
            "error": str(exc),
        }


def percentile(values: Sequence[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * p
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    weight = rank - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def mean_or_none(values: Sequence[float]) -> float | None:
    return mean(values) if values else None


def add_token_metrics(results: List[Dict[str, Any]], tokenizer: Any) -> None:
    for item in results:
        item["input_tokens"] = len(tokenizer.encode(item.get("prompt", ""), add_special_tokens=False))
        if item.get("error"):
            item["output_tokens"] = 0
            item["decode_tokens_per_second"] = None
            continue
        output_tokens = len(tokenizer.encode(item["response_text"], add_special_tokens=False))
        decode_seconds = None
        if item["ttft_seconds"] is not None and item["end_to_end_latency_seconds"] is not None:
            decode_seconds = max(item["end_to_end_latency_seconds"] - item["ttft_seconds"], 1e-6)
        item["output_tokens"] = output_tokens
        item["decode_tokens_per_second"] = output_tokens / decode_seconds if decode_seconds is not None else None


def emit_progress(event_type: str, payload: Dict[str, Any]) -> None:
    print(
        "__BENCHMARK_EVENT__ "
        + json.dumps({"event_type": event_type, "payload": payload}, ensure_ascii=False, separators=(",", ":")),
        flush=True,
    )


def summarize_scenario(results: List[Dict[str, Any]], wall_seconds: float) -> Dict[str, Any]:
    successes = [item for item in results if not item.get("error")]
    failures = [item for item in results if item.get("error")]
    ttft_values = [item["ttft_seconds"] for item in successes if item["ttft_seconds"] is not None]
    latency_values = [item["end_to_end_latency_seconds"] for item in successes if item["end_to_end_latency_seconds"] is not None]
    decode_tps_values = [item["decode_tokens_per_second"] for item in successes if item["decode_tokens_per_second"] is not None]
    output_tokens = sum(int(item.get("output_tokens", 0)) for item in successes)
    target_pod_counts = Counter(item.get("target_pod") or "unknown" for item in successes)

    return {
        "request_count": len(results),
        "success_count": len(successes),
        "error_count": len(failures),
        "error_rate": len(failures) / len(results) if results else 0.0,
        "wall_seconds": wall_seconds,
        "qps": len(successes) / wall_seconds if wall_seconds > 0 else None,
        "output_tokens": output_tokens,
        "output_tokens_per_second": output_tokens / wall_seconds if wall_seconds > 0 else None,
        "mean_ttft_seconds": mean_or_none(ttft_values),
        "p50_latency_seconds": percentile(latency_values, 0.50),
        "p95_latency_seconds": percentile(latency_values, 0.95),
        "p99_latency_seconds": percentile(latency_values, 0.99),
        "mean_latency_seconds": mean_or_none(latency_values),
        "mean_decode_tokens_per_second": mean_or_none(decode_tps_values),
        "target_pod_counts": dict(sorted(target_pod_counts.items())),
        "sample_errors": [item["error"] for item in failures[:3]],
    }


def run_scenario(
    *,
    concurrency: int,
    prompts: Sequence[str],
    tokenizer: Any,
    args: argparse.Namespace,
    extra_headers: Dict[str, str],
    target_pod_headers: Sequence[str],
) -> Dict[str, Any]:
    request_count = args.requests_per_level
    requests_to_run = []
    for idx in range(request_count):
        prompt = prompts[idx % len(prompts)]
        request_id = f"{args.request_id_prefix}-{concurrency}-{idx + 1}-{uuid4().hex[:8]}"
        requests_to_run.append((idx, prompt, request_id))

    started_at = perf_counter()
    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [
            executor.submit(
                safe_stream_chat_request,
                base_url=args.base_url,
                model=args.model,
                prompt=prompt,
                request_id=request_id,
                user=args.user,
                max_tokens=args.max_tokens,
                temperature=args.temperature,
                timeout=args.timeout,
                extra_headers=extra_headers,
                target_pod_headers=target_pod_headers,
            )
            for _, prompt, request_id in requests_to_run
        ]
        for future in as_completed(futures):
            result = future.result()
            add_token_metrics([result], tokenizer)
            results.append(result)
            if args.emit_progress:
                emit_progress(
                    "request",
                    {
                        "concurrency": concurrency,
                        "request_id": result.get("request_id"),
                        "ttft_seconds": result.get("ttft_seconds"),
                        "end_to_end_latency_seconds": result.get("end_to_end_latency_seconds"),
                        "input_tokens": result.get("input_tokens", 0),
                        "output_tokens": result.get("output_tokens", 0),
                        "target_pod": result.get("target_pod", ""),
                        "error": result.get("error"),
                    },
                )
    wall_seconds = perf_counter() - started_at
    results.sort(key=lambda item: item["request_id"])
    add_token_metrics(results, tokenizer)
    scenario = {
        "concurrency": concurrency,
        "requests": results,
        "summary": summarize_scenario(results, wall_seconds),
    }
    if args.emit_progress:
        emit_progress("scenario_summary", {"concurrency": concurrency, "summary": scenario["summary"]})
    return scenario


def render_float(value: Any, digits: int = 3) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def render_markdown(payload: Dict[str, Any]) -> str:
    lines = [
        "# Serving Benchmark",
        "",
        "OpenAI-compatible serving benchmark. The same script can target direct vLLM or an AIBrix Gateway endpoint.",
        "",
        "## Endpoint",
        "",
        f"- label: `{payload['endpoint_label']}`",
        f"- base_url: `{payload['base_url']}`",
        f"- model: `{payload['model']}`",
        f"- routing_strategy: `{payload['routing_strategy'] or '-'}`",
        f"- max_tokens: `{payload['max_tokens']}`",
        "",
        "## Summary",
        "",
        "| Concurrency | Requests | Success | Errors | QPS | Mean TTFT(s) | P50 Latency(s) | P95 Latency(s) | P99 Latency(s) | Decode tok/s | Output tok/s |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for scenario in payload["scenarios"]:
        summary = scenario["summary"]
        lines.append(
            "| {concurrency} | {requests} | {success} | {errors} | {qps} | {ttft} | {p50} | {p95} | {p99} | {decode_tps} | {output_tps} |".format(
                concurrency=scenario["concurrency"],
                requests=summary["request_count"],
                success=summary["success_count"],
                errors=summary["error_count"],
                qps=render_float(summary["qps"]),
                ttft=render_float(summary["mean_ttft_seconds"]),
                p50=render_float(summary["p50_latency_seconds"]),
                p95=render_float(summary["p95_latency_seconds"]),
                p99=render_float(summary["p99_latency_seconds"]),
                decode_tps=render_float(summary["mean_decode_tokens_per_second"]),
                output_tps=render_float(summary["output_tokens_per_second"]),
            )
        )

    lines.extend(["", "## Routing Distribution", ""])
    for scenario in payload["scenarios"]:
        counts = scenario["summary"]["target_pod_counts"]
        if not counts:
            rendered = "-"
        else:
            rendered = ", ".join(f"`{key}`={value}" for key, value in counts.items())
        lines.append(f"- concurrency `{scenario['concurrency']}`: {rendered}")

    errors = [
        (scenario["concurrency"], error)
        for scenario in payload["scenarios"]
        for error in scenario["summary"]["sample_errors"]
    ]
    if errors:
        lines.extend(["", "## Sample Errors", ""])
        for concurrency, error in errors[:10]:
            lines.append(f"- concurrency `{concurrency}`: `{error}`")

    lines.append("")
    return "\n".join(lines)


def format_connectivity_error(exc: requests.RequestException, base_url: str, model: str) -> str:
    endpoint = normalize_base_url(base_url) + "/chat/completions"
    lines = [f"[ERROR] request to {endpoint} failed: {exc}"]

    if isinstance(exc, requests.ConnectionError):
        lines.append("[ERROR] Serving endpoint is unreachable. Confirm vLLM or AIBrix Gateway is running.")
        return "\n".join(lines)

    response = getattr(exc, "response", None)
    if response is None:
        return "\n".join(lines)

    if response.status_code == 404:
        try:
            available_models = list_models(base_url=base_url)
        except requests.RequestException as list_exc:
            lines.append(f"[ERROR] Failed to query {normalize_base_url(base_url)}/models: {list_exc}")
            return "\n".join(lines)

        if available_models:
            rendered_models = ", ".join(f"`{item}`" for item in available_models)
            lines.append(f"[ERROR] Available model ids: {rendered_models}")
            if model not in available_models:
                lines.append(
                    f"[ERROR] Requested `--model {model}` is not exposed by the server. "
                    f"Use one of the ids above, or restart the serving endpoint with this served model name."
                )
        else:
            lines.append(f"[ERROR] {normalize_base_url(base_url)}/models returned no model ids.")

    return "\n".join(lines)


def smoke_check(args: argparse.Namespace, extra_headers: Dict[str, str], target_pod_headers: Sequence[str]) -> None:
    try:
        result = stream_chat_request(
            base_url=args.base_url,
            model=args.model,
            prompt=DEFAULT_PROMPTS[0],
            request_id=f"{args.request_id_prefix}-smoke-{uuid4().hex[:8]}",
            user=args.user,
            max_tokens=1,
            temperature=args.temperature,
            timeout=args.timeout,
            extra_headers=extra_headers,
            target_pod_headers=target_pod_headers,
        )
        if result.get("error"):
            raise requests.RequestException(result["error"])
    except requests.RequestException as exc:
        raise SystemExit(format_connectivity_error(exc, args.base_url, args.model)) from exc


def main() -> None:
    args = parse_args()
    if args.requests_per_level <= 0:
        raise SystemExit("[ERROR] --requests_per_level must be positive")

    extra_headers = parse_extra_headers(args.extra_header)
    if args.routing_strategy:
        extra_headers.setdefault("routing-strategy", args.routing_strategy)
    target_pod_headers = args.target_pod_header or DEFAULT_TARGET_POD_HEADERS
    prompts = load_prompts(args)
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer_path, use_fast=True)

    smoke_check(args, extra_headers, target_pod_headers)

    scenarios = []
    for concurrency in args.concurrency_levels:
        print(f"[INFO] running serving benchmark: concurrency={concurrency}, requests={args.requests_per_level}")
        scenarios.append(
            run_scenario(
                concurrency=concurrency,
                prompts=prompts,
                tokenizer=tokenizer,
                args=args,
                extra_headers=extra_headers,
                target_pod_headers=target_pod_headers,
            )
        )

    payload = {
        "endpoint_label": args.endpoint_label,
        "base_url": args.base_url,
        "model": args.model,
        "routing_strategy": args.routing_strategy,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "prompt_profile": args.prompt_profile,
        "requests_per_level": args.requests_per_level,
        "concurrency_levels": args.concurrency_levels,
        "extra_headers": extra_headers,
        "target_pod_headers": target_pod_headers,
        "scenarios": scenarios,
    }

    output_json = Path(args.output_json)
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    report_path = Path(args.output_report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(render_markdown(payload), encoding="utf-8")
    print(f"[DONE] wrote serving benchmark json to {output_json}")
    print(f"[DONE] wrote serving benchmark report to {report_path}")

    if args.capture_system_state:
        try:
            from src.serve.system_snapshot import SnapshotConfig, capture_snapshot, summarize_snapshot
            benchmark_id = output_json.stem
            snapshot_dir = Path(args.snapshot_dir)
            cfg = SnapshotConfig(
                benchmark_id=benchmark_id,
                output_dir=snapshot_dir,
                benchmark_report_path=output_json,
            )
            snapshot = capture_snapshot(cfg)
            print(f"[DONE] wrote system snapshot to {snapshot_dir / (benchmark_id + '.json')}")
            print("[SNAPSHOT SUMMARY]")
            print(summarize_snapshot(snapshot))
        except Exception as exc:  # noqa: BLE001 - snapshot must never fail the benchmark
            print(f"[WARN] system snapshot capture failed: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
