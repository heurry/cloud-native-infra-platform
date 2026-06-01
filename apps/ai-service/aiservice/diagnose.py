"""Structured diagnosis.

Two modes, one contract (DiagnoseResponse):
  * stub —— 确定性、纯函数：直接从 Go 取来的证据推导诊断（无 GPU 也能端到端跑，可单测）
  * live —— 调网关上的 LLM，要求其输出结构化 JSON，再解析回 DiagnoseResponse
`run_diagnose` 按 cfg.stub_mode 调度：auto 时试 live，失败回退 stub。
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from aiservice.config import Config
from aiservice.schemas import (
    DiagnoseRequest,
    DiagnoseResponse,
    EvidenceItem,
    RecommendedAction,
    RelatedResource,
)

# ---- 阈值（与 Go 取证侧/前端语义一致）----
ERROR_RATE_THRESHOLD = 0.02
P95_LATENCY_THRESHOLD_MS = 3000.0


def run_diagnose(req: DiagnoseRequest, cfg: Config) -> DiagnoseResponse:
    start = time.perf_counter()
    resp = _dispatch(req, cfg)
    resp.latency_ms = round((time.perf_counter() - start) * 1000, 2)
    return resp


def _dispatch(req: DiagnoseRequest, cfg: Config) -> DiagnoseResponse:
    mode = cfg.stub_mode
    force_stub = mode == "on" or (mode != "off" and not cfg.llm_base_url)
    if force_stub:
        resp = stub_diagnose(req)
        resp.mode = "stub"
        return resp
    try:
        resp = live_diagnose(req, cfg)
        resp.mode = "live"
        return resp
    except Exception as exc:  # noqa: BLE001 - 上游不稳定时优雅降级
        if mode == "off":
            return DiagnoseResponse(
                status="failed", error=f"{type(exc).__name__}: {exc}",
                mode="live", model_id=cfg.llm_model,
            )
        resp = stub_diagnose(req)
        resp.mode = "stub"
        resp.error = f"llm fallback: {type(exc).__name__}: {exc}"
        return resp


# ========================= stub（确定性，纯函数）=========================


def stub_diagnose(req: DiagnoseRequest) -> DiagnoseResponse:
    """Rule-based diagnosis derived from the evidence bundle. Deterministic."""
    evidence = req.evidence or {}
    metrics: Dict[str, Any] = evidence.get("metrics") or {}
    incidents: List[Dict[str, Any]] = evidence.get("incidents") or []
    deployments: List[Dict[str, Any]] = evidence.get("deployments") or []

    error_rate = _as_float(metrics.get("error_rate"))
    p95 = _as_float(metrics.get("p95_latency_ms"))
    p99 = _as_float(metrics.get("p99_latency_ms"))
    qps = _as_float(metrics.get("qps"))
    req_count = _as_int(metrics.get("request_count"))
    active_incidents = [i for i in incidents if str(i.get("status")) != "resolved"]

    evidence_items: List[EvidenceItem] = []
    if metrics:
        evidence_items.append(EvidenceItem(
            label="请求量", source="metrics",
            detail=f"近 10 分钟 {req_count} 次请求，QPS≈{qps:.3f}",
        ))
        evidence_items.append(EvidenceItem(
            label="错误率", source="metrics",
            detail=f"error_rate={error_rate:.3f}（阈值 {ERROR_RATE_THRESHOLD}）",
        ))
        evidence_items.append(EvidenceItem(
            label="延迟", source="metrics",
            detail=f"P95={p95:.0f}ms，P99={p99:.0f}ms（阈值 {P95_LATENCY_THRESHOLD_MS:.0f}ms）",
        ))
    if active_incidents:
        evidence_items.append(EvidenceItem(
            label="未解决故障", source="incidents",
            detail=f"{len(active_incidents)} 起进行中事件，最高级别 {active_incidents[0].get('severity')}",
        ))

    root_cause, impact, confidence, actions = _reason(error_rate, p95, active_incidents)

    related: List[RelatedResource] = []
    for dep in deployments[:3]:
        related.append(RelatedResource(
            type="deployment", id=_as_str(dep.get("id")), name=_as_str(dep.get("name")),
        ))
    for inc in active_incidents[:3]:
        related.append(RelatedResource(
            type="incident", id=_as_str(inc.get("id")), name=_as_str(inc.get("title")),
        ))

    return DiagnoseResponse(
        status="completed",
        root_cause=root_cause,
        confidence=round(confidence, 3),
        impact=impact,
        evidence=evidence_items,
        recommended_actions=actions,
        related_resources=related,
        model_id="stub",
        endpoint_id="stub",
    )


def _reason(error_rate: float, p95: float, active_incidents: List[Dict[str, Any]]):
    """Return (root_cause, impact, confidence, actions) by priority."""
    if error_rate >= ERROR_RATE_THRESHOLD:
        return (
            f"近窗口错误率 {error_rate:.1%} 超过 {ERROR_RATE_THRESHOLD:.0%} 阈值，推理链路存在失败请求。",
            "部分用户请求失败，影响可用性 SLA。",
            min(0.9, 0.5 + error_rate * 5),
            [
                RecommendedAction(
                    action="检查 vLLM/网关日志定位 5xx 来源（OOM / KV cache 满 / 上游超时）",
                    risk="low", impact="定位根因，无副作用",
                ),
                RecommendedAction(
                    action="必要时回滚最近一次部署或临时降低并发",
                    risk="medium", impact="恢复可用性，可能降低吞吐",
                ),
            ],
        )
    if p95 >= P95_LATENCY_THRESHOLD_MS:
        return (
            f"P95 延迟 {p95:.0f}ms 偏高，存在排队或 KV cache 压力。",
            "长尾延迟影响交互体验。",
            0.7,
            [
                RecommendedAction(
                    action="将路由策略切换为 least-latency / least-kv-cache",
                    risk="low", impact="缓解长尾延迟",
                ),
                RecommendedAction(
                    action="评估扩容副本或降低单请求 max_tokens",
                    risk="medium", impact="提升吞吐，增加成本",
                ),
            ],
        )
    if active_incidents:
        top = active_incidents[0]
        return (
            f"存在未解决故障事件「{top.get('title')}」（severity={top.get('severity')}），可能正在影响服务。",
            "依据事件严重度评估业务影响。",
            0.6,
            [RecommendedAction(
                action="跟进该故障事件的处理时间线并确认缓解措施",
                risk="low", impact="推进故障收敛",
            )],
        )
    return (
        "未发现显著异常：错误率与延迟均在阈值内，系统状态正常。",
        "无明显业务影响。",
        0.55,
        [RecommendedAction(
            action="维持当前配置，持续观测指标趋势",
            risk="low", impact="无",
        )],
    )


# ========================= live（LLM 出 JSON）=========================

SYSTEM_PROMPT = """你是云原生 AI 推理基础设施的运维诊断专家。基于给定证据（指标/事件/部署/配置/k8s），\
定位根因并给出结构化诊断。

严格要求：只输出一个 JSON 对象，不要任何额外文字、解释或 markdown 代码块。键如下：
{
  "root_cause": "一句话根因",
  "confidence": 0.0 到 1.0 之间的数字,
  "impact": "业务影响",
  "evidence": [{"label": "", "detail": "", "source": "metrics|incidents|deployments|kubernetes"}],
  "recommended_actions": [{"action": "", "risk": "low|medium|high", "impact": ""}],
  "related_resources": [{"type": "deployment|incident|config", "id": "", "name": ""}]
}
用简体中文填充文本字段，结论须引用证据中的具体数值。"""


def live_diagnose(req: DiagnoseRequest, cfg: Config) -> DiagnoseResponse:
    from aiservice import llm  # 延迟导入：单测 stub 时无需 requests

    messages = build_messages(req)
    content = llm.chat_completion(
        cfg.llm_base_url, cfg.llm_model, cfg.llm_api_key, messages,
        max_tokens=_opt_max_tokens(req, cfg),
        temperature=_opt_temperature(req, cfg),
        timeout=cfg.request_timeout,
    )
    parsed = _parse_json_object(content)
    if parsed is None:
        # 模型没给合法 JSON → 降级：原文当根因，低置信，仍返回结构化外形。
        return DiagnoseResponse(
            status="completed",
            root_cause=content.strip()[:1000],
            confidence=0.3,
            impact="（模型未输出结构化 JSON，已降级）",
            model_id=cfg.llm_model,
            endpoint_id="aibrix-gateway",
        )
    return _response_from_parsed(parsed, cfg)


def build_messages(req: DiagnoseRequest) -> List[Dict[str, str]]:
    summary = summarize_evidence(req.evidence or {})
    user = f"== 证据摘要 ==\n{summary}\n\n== 运维问题 ==\n{req.question}"
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def summarize_evidence(evidence: Dict[str, Any], max_chars: int = 1800) -> str:
    """Compact the evidence bundle to fit qwen3-4b's context budget."""
    metrics = evidence.get("metrics") or {}
    incidents = evidence.get("incidents") or []
    deployments = evidence.get("deployments") or []
    config_items = evidence.get("config_items") or []
    k8s = evidence.get("kubernetes") or {}

    compact = {
        "metrics": {
            k: metrics.get(k) for k in (
                "request_count", "qps", "error_rate",
                "p95_latency_ms", "p99_latency_ms", "mean_latency_ms",
                "p95_ttft_ms", "total_tokens",
            ) if k in metrics
        },
        "incidents": [
            {"title": i.get("title"), "severity": i.get("severity"), "status": i.get("status")}
            for i in incidents[:5]
        ],
        "deployments": [
            {"name": d.get("name"), "status": d.get("status"), "version": d.get("version")}
            for d in deployments[:5]
        ],
        "config_items": [
            {"config_key": c.get("config_key"), "active_version": c.get("active_version")}
            for c in config_items[:5]
        ],
        "kubernetes_available": bool(k8s.get("available")),
    }
    text = json.dumps(compact, ensure_ascii=False, indent=2)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n...[truncated]"
    return text


def _response_from_parsed(parsed: Dict[str, Any], cfg: Config) -> DiagnoseResponse:
    evidence_items = [
        EvidenceItem(
            label=_as_str(e.get("label")),
            detail=_as_str(e.get("detail")),
            source=_as_str(e.get("source")) or "metrics",
        )
        for e in _as_list(parsed.get("evidence"))
    ]
    actions = [
        RecommendedAction(
            action=_as_str(a.get("action")),
            risk=_as_str(a.get("risk")) or "low",
            impact=_as_str(a.get("impact")),
        )
        for a in _as_list(parsed.get("recommended_actions"))
    ]
    related = [
        RelatedResource(
            type=_as_str(r.get("type")) or "service",
            id=_as_str(r.get("id")) or None,
            name=_as_str(r.get("name")) or None,
        )
        for r in _as_list(parsed.get("related_resources"))
    ]
    return DiagnoseResponse(
        status="completed",
        root_cause=_as_str(parsed.get("root_cause")),
        confidence=_as_optional_float(parsed.get("confidence")),
        impact=_as_str(parsed.get("impact")),
        evidence=evidence_items,
        recommended_actions=actions,
        related_resources=related,
        model_id=cfg.llm_model,
        endpoint_id="aibrix-gateway",
    )


def _parse_json_object(content: str) -> Optional[Dict[str, Any]]:
    """Extract a JSON object from model output (handles prose/code-fence wrapping)."""
    if not content:
        return None
    text = content.strip()
    # 去掉 ```json ... ``` 围栏
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


# ---- coercion helpers（容错，证据来源可能字段缺失/类型不一）----


def _as_float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _as_optional_float(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _as_int(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _as_str(v: Any) -> str:
    return "" if v is None else str(v)


def _as_list(v: Any) -> List[Dict[str, Any]]:
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def _opt_max_tokens(req: DiagnoseRequest, cfg: Config) -> int:
    if req.options and req.options.max_tokens:
        return req.options.max_tokens
    return cfg.default_max_tokens


def _opt_temperature(req: DiagnoseRequest, cfg: Config) -> float:
    if req.options and req.options.temperature is not None:
        return req.options.temperature
    return cfg.default_temperature
