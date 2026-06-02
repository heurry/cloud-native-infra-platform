package httpx

import (
	"fmt"
	"strings"

	"github.com/heurry/cloudnative-infra-platform/server/internal/store"
)

// 6A chat：RAG 提示/策略，端口自 legacy src/customer_support/{prompt,policy,memory}.py。
// 偏差（文档化）：请求已设 enable_thinking=false 关闭思考，故不移植 response_filter.py 的
// 166 行流式思考过滤器；memory-aware query 取主分支（短补充 → 携带最近用户轮次）。

const chatSystemPrompt = `你是企业客服问答助手。必须基于提供的知识库片段回答。
如果知识库证据不足、问题涉及账号/订单隐私操作、赔付争议或法律风险，请说明需要转人工。
回答要自然、简洁、可执行，面向真实客户，不要像内部评测报告。
不要在客户回答中输出文档编号、doc_id、[1]、【1】、"根据文档"、"根据知识库" 等引用标记；引用信息由系统在侧边栏单独展示。
不要输出思考过程、推理步骤、分析计划或英文标题。
如果用户只是寒暄问候，请直接友好回应并询问需要什么帮助，不要说知识库证据不足。
如果用户是对上一轮的简短补充，请结合最近对话理解，不要把补充内容孤立解释成其他业务问题。
如果知识库片段与最近对话意图不匹配，不要强行套用相似词命中的知识库内容。
如果用户使用中文提问，必须全程使用简体中文回答；不要夹杂英文，除非英文是商品名或接口名。`

var greetingKeywords = map[string]bool{
	"你好": true, "您好": true, "hello": true, "hi": true, "嗨": true, "在吗": true, "客服在吗": true,
}

var handoffKeywords = []string{"投诉", "赔偿", "赔付", "起诉", "账号冻结", "修改地址", "银行卡", "身份证", "订单号"}

// buildMemoryAwareQuery：短补充轮次携带最近用户需求（简化自 build_memory_aware_query 主分支）。
func buildMemoryAwareQuery(question string, memory []store.ChatMessage) string {
	current := strings.TrimSpace(question)
	if current == "" || len(memory) == 0 || len([]rune(current)) > 16 {
		return current
	}
	recent := []string{}
	for _, m := range memory {
		if m.Role == "user" {
			recent = append(recent, m.Content)
		}
	}
	if len(recent) > 2 {
		recent = recent[len(recent)-2:]
	}
	if len(recent) == 0 {
		return current
	}
	return "上一轮用户需求：" + strings.Join(recent, "；") + "\n当前用户补充：" + current
}

// decideFallback：寒暄 / 无检索命中 / 敏感转人工（复刻 policy.decide_fallback）。
func decideFallback(question string, docs []store.DocHit) string {
	normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(question)), " ", "")
	if greetingKeywords[normalized] {
		return "greeting"
	}
	if len(docs) == 0 {
		return "no_retrieval_hit"
	}
	lowered := strings.ToLower(question)
	for _, kw := range handoffKeywords {
		if strings.Contains(lowered, strings.ToLower(kw)) {
			return "handoff_sensitive_or_account_action"
		}
	}
	return ""
}

// buildFallbackAnswer：复刻 policy.build_fallback_answer 的固定话术。
func buildFallbackAnswer(docs []store.DocHit, reason string) string {
	switch reason {
	case "greeting":
		return "您好，请问有什么可以帮您？"
	case "handoff_sensitive_or_account_action":
		return "这个问题涉及账号、订单、赔付或敏感操作，需要人工客服核验身份和业务状态后处理。"
	}
	if len(docs) > 0 {
		title := docs[0].Title
		if title == "" {
			title = "未命名文档"
		}
		return fmt.Sprintf("我找到了相关资料《%s》，但当前模型服务不可用。请稍后重试，或转人工处理。", title)
	}
	return "当前知识库没有找到足够证据，建议转人工客服进一步确认。"
}

// buildChatMessages：系统提示 + 知识库上下文块 + 最近对话块（复刻 prompt.build_chat_messages）。
func buildChatMessages(question string, docs []store.DocHit, memory []store.ChatMessage, maxContextChars int) []map[string]string {
	if maxContextChars <= 0 {
		maxContextChars = 6000
	}
	context := buildContextBlock(docs, maxContextChars)
	if context == "" {
		context = "未检索到相关知识。"
	}
	history := buildHistoryBlock(memory, 1600)
	if history == "" {
		history = "无"
	}
	user := fmt.Sprintf("最近对话：\n%s\n\n知识库片段：\n%s\n\n当前用户问题：%s", history, context, question)
	return []map[string]string{
		{"role": "system", "content": chatSystemPrompt},
		{"role": "user", "content": user},
	}
}

func buildContextBlock(docs []store.DocHit, maxChars int) string {
	var parts []string
	used := 0
	for i, d := range docs {
		text := fmt.Sprintf("[%d] doc_id=%s category=%s version=%s\ntitle: %s\ncontent: %s",
			i+1, d.DocID, d.Category, d.Version, d.Title, d.Content)
		if used+len(text) > maxChars {
			break
		}
		parts = append(parts, text)
		used += len(text)
	}
	return strings.Join(parts, "\n\n")
}

func buildHistoryBlock(memory []store.ChatMessage, maxChars int) string {
	var parts []string
	used := 0
	for _, m := range memory {
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		role := "客服助手"
		if m.Role == "user" {
			role = "用户"
		}
		text := role + ": " + content
		if used+len(text) > maxChars {
			break
		}
		parts = append(parts, text)
		used += len(text)
	}
	return strings.Join(parts, "\n")
}
