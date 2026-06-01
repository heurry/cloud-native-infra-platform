from src.customer_support.memory import build_memory_aware_query, compact_conversation_memory, is_contextual_followup
from src.customer_support.prompt import build_chat_messages


def test_memory_aware_query_rewrites_short_followup_with_recent_context() -> None:
    history = compact_conversation_memory(
        [
            {"role": "user", "content": "推荐一个商品"},
            {"role": "assistant", "content": "可以，请告诉我您感兴趣的品类或具体需求。"},
        ]
    )

    query = build_memory_aware_query("电子产品", history)

    assert is_contextual_followup("电子产品", history)
    assert "推荐一个商品" in query
    assert "电子产品" in query
    assert "上一轮客服回复" not in query


def test_memory_aware_query_keeps_standalone_question_unchanged() -> None:
    history = compact_conversation_memory([{"role": "user", "content": "你好"}])

    query = build_memory_aware_query("退款规则是什么？", history)

    assert query == "退款规则是什么？"


def test_prompt_includes_recent_conversation_memory() -> None:
    messages = build_chat_messages(
        user_question="电子产品",
        retrieved_documents=[],
        max_context_chars=1000,
        conversation_history=[
            {"role": "user", "content": "推荐一个商品"},
            {"role": "assistant", "content": "请告诉我品类。"},
        ],
    )

    prompt = messages[-1]["content"]
    assert "最近对话" in prompt
    assert "推荐一个商品" in prompt
    assert "当前用户问题：电子产品" in prompt
