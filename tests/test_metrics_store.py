from src.metrics.store import _parse_prometheus_selected


def test_parse_vllm_kv_and_prefix_cache_metrics() -> None:
    payload = """
vllm:num_requests_running{engine="0",model_name="qwen3-4b-customer"} 2.0
vllm:num_requests_waiting{engine="0",model_name="qwen3-4b-customer"} 3.0
vllm:kv_cache_usage_perc{engine="0",model_name="qwen3-4b-customer"} 0.42
vllm:prefix_cache_queries_total{engine="0",model_name="qwen3-4b-customer"} 100.0
vllm:prefix_cache_hits_total{engine="0",model_name="qwen3-4b-customer"} 35.0
vllm:prompt_tokens_by_source_total{engine="0",model_name="qwen3-4b-customer",source="local_compute"} 80.0
vllm:prompt_tokens_by_source_total{engine="0",model_name="qwen3-4b-customer",source="local_cache_hit"} 20.0
vllm:num_preemptions_total{engine="0",model_name="qwen3-4b-customer"} 1.0
"""

    selected = _parse_prometheus_selected(payload)

    assert selected["requests_running"] == 2.0
    assert selected["requests_waiting"] == 3.0
    assert selected["kv_cache_usage_percent"] == 42.0
    assert selected["prefix_cache_queries_total"] == 100.0
    assert selected["prefix_cache_hits_total"] == 35.0
    assert selected["prefix_cache_hit_rate_percent"] == 35.0
    assert selected["prompt_tokens_cache_hit_rate_percent"] == 20.0
    assert selected["preemptions_total"] == 1.0
