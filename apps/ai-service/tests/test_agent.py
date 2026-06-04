"""E1：agentic 诊断单步推理（stub 脚本）单测——多轮取证 + 收口下结论。"""

from aiservice.agent import run_agent_step
from aiservice.config import Config
from aiservice.schemas import AgentStepRequest, AgentTool


def _stub_cfg() -> Config:
    return Config(
        llm_base_url="", llm_model="stub", llm_api_key="EMPTY", request_timeout=5,
        stub_mode="on", default_max_tokens=256, default_temperature=0.2,
        host="0.0.0.0", port=8200, embed_model="stub", embed_dim=8,
    )


TOOLS = [
    AgentTool(name="recent_metrics"),
    AgentTool(name="open_incidents"),
    AgentTool(name="kubernetes_pods"),
]


def test_stub_requests_tool_before_concluding():
    req = AgentStepRequest(messages=[{"role": "user", "content": "诊断当前服务"}], tools=TOOLS)
    res = run_agent_step(req, _stub_cfg())
    assert res.mode == "stub"
    assert res.final is None
    assert len(res.tool_calls) == 1
    assert res.tool_calls[0].name == "recent_metrics"  # 按 tools 顺序逐个取证


def test_stub_concludes_after_gathering_evidence():
    msgs = [
        {"role": "user", "content": "诊断当前服务"},
        {"role": "tool", "name": "recent_metrics", "content": '{"error_rate":0.05,"p95_latency_ms":1200,"qps":3}'},
        {"role": "tool", "name": "open_incidents", "content": '[{"id":"i1","title":"网关 5xx 升高","severity":"high","status":"open"}]'},
        {"role": "tool", "name": "kubernetes_pods", "content": '{"available":true,"pod_count":5,"not_running":["default/x(Pending)"]}'},
    ]
    res = run_agent_step(AgentStepRequest(messages=msgs, tools=TOOLS), _stub_cfg())
    assert res.final is not None
    assert res.final.root_cause  # 非空根因
    assert res.final.recommended_actions  # 给了建议动作
    # error_rate 0.05 ≥ 0.02 阈值 → 结论应提错误率；非 Running Pod 应入根因前缀
    assert "Pod" in res.final.root_cause and ("错误率" in res.final.root_cause or "0.0" in res.final.root_cause)
