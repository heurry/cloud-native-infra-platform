from src.customer_support.response_filter import StreamingAnswerFilter, strip_customer_citations, strip_thinking_text


def test_strip_thinking_process_with_final_answer() -> None:
    text = """Thinking Process:
1. Analyze the request.
2. Scan docs.

Final Answer:
退款规则：支付后 7 天内，未发货商品可申请退款。[refund-policy-v1]"""

    assert strip_thinking_text(text) == "退款规则：支付后 7 天内，未发货商品可申请退款。"


def test_strip_thinking_process_without_answer_marker_returns_empty() -> None:
    text = "Thinking Process:\n1. Analyze the request.\n2. Scan docs."

    assert strip_thinking_text(text) == ""


def test_streaming_filter_buffers_split_thinking_prefix() -> None:
    flt = StreamingAnswerFilter()

    assert flt.feed("Thinking") == []
    assert flt.feed(" Process:\n1. Analyze.\n\nAnswer:") == []
    output = flt.feed(" 退款规则：未发货商品 7 天内可申请退款。")

    assert output == ["退款规则：未发货商品 7 天内可申请退款。"]
    assert flt.finish() == []


def test_streaming_filter_passes_normal_chinese_answer() -> None:
    flt = StreamingAnswerFilter()

    assert flt.feed("退款规则：") == ["退款规则："]
    assert flt.feed("未发货商品 7 天内可申请退款。") == ["未发货商品 7 天内可申请退款。"]
    assert flt.finish() == []


def test_strip_customer_citations_removes_internal_source_markers() -> None:
    text = "根据文档 [1]，订单支付后 7 天内，未发货商品可申请退款。[refund-policy-v1]"

    assert strip_customer_citations(text) == "订单支付后 7 天内，未发货商品可申请退款。"


def test_streaming_filter_buffers_and_removes_leading_source_marker() -> None:
    flt = StreamingAnswerFilter()

    assert flt.feed("根据") == []
    assert flt.feed("文档 [1]，订单支付后 ") == ["订单支付后 "]
    assert flt.feed("7 天内可申请退款。") == ["7 天内可申请退款。"]
    assert flt.finish() == []


def test_streaming_filter_does_not_drop_policy_word_after_prefix() -> None:
    flt = StreamingAnswerFilter()

    assert flt.feed("您好！") == ["您好！"]
    assert flt.feed("根据") == ["根据"]
    assert flt.feed("我们的") == ["我们的"]
    assert flt.feed("退款") == ["退款"]
    assert flt.feed("政策") == ["政策"]
    assert flt.feed("，未发货商品可申请退款。") == ["，未发货商品可申请退款。"]
