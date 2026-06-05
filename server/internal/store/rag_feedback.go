package store

import (
	"context"
	"encoding/json"
	"time"
)

// E2：在线反馈回流。把 chat_message_feedback（👍/👎）回流成检索评测数据集与重排信号——
// 全部从既有 chat_* 派生（无新表）：
//   - 评测样本：被 👍 的 assistant 回答 → 问题(取该回答前最近一条用户消息) + gold(被引用的 doc_id)。
//   - 重排信号：被引用文档在 👍/👎 回答中的票数聚合（净分 = 赞 - 踩）。

// FeedbackSample 是一条由反馈派生的检索样本。
type FeedbackSample struct {
	MessageID  string    `json:"message_id"`
	Question   string    `json:"question"`
	GoldDocIDs []string  `json:"gold_doc_ids"`
	Rating     string    `json:"rating"`
	CreatedAt  time.Time `json:"created_at"`
}

// Usable 判定该样本是否可作为检索评测的 gold（必须 👍 且有问题与被引文档）。
func (s FeedbackSample) Usable() bool {
	return s.Rating == "up" && s.Question != "" && len(s.GoldDocIDs) > 0
}

// FeedbackDataset 回流评测数据集（按反馈时间倒序，limit 限量）。
// 问题取该 assistant 回答之前、同会话最近一条 user 消息；gold 取回答 metadata.citation_doc_ids。
func (s *Store) FeedbackDataset(ctx context.Context, limit int) ([]FeedbackSample, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.message_id,
		       COALESCE((SELECT u.content FROM chat_messages u
		                  WHERE u.session_id = m.session_id AND u.role = 'user' AND u.created_at < m.created_at
		                  ORDER BY u.created_at DESC LIMIT 1), '') AS question,
		       COALESCE(m.metadata->'citation_doc_ids', '[]'::jsonb) AS gold,
		       f.rating, f.created_at
		  FROM chat_message_feedback f
		  JOIN chat_messages m ON m.message_id = f.message_id AND m.role = 'assistant'
		 ORDER BY f.created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FeedbackSample{}
	for rows.Next() {
		var fs FeedbackSample
		var gold []byte
		if err := rows.Scan(&fs.MessageID, &fs.Question, &gold, &fs.Rating, &fs.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(gold, &fs.GoldDocIDs)
		out = append(out, fs)
	}
	return out, rows.Err()
}

// DocSignal 是单个文档的反馈重排信号。
type DocSignal struct {
	DocID string `json:"doc_id"`
	Title string `json:"title"`
	Up    int    `json:"up"`
	Down  int    `json:"down"`
	Net   int    `json:"net"`
}

// DocFeedbackSignal 按被引文档聚合 👍/👎 票数（净分降序）——重排信号来源。
func (s *Store) DocFeedbackSignal(ctx context.Context) ([]DocSignal, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT x.doc_id,
		       COALESCE((SELECT d.title FROM kb_documents d WHERE d.doc_id = x.doc_id ORDER BY d.created_at DESC LIMIT 1), '') AS title,
		       count(*) FILTER (WHERE x.rating = 'up')  AS up,
		       count(*) FILTER (WHERE x.rating <> 'up') AS down
		  FROM (
		        SELECT jsonb_array_elements_text(m.metadata->'citation_doc_ids') AS doc_id, f.rating
		          FROM chat_message_feedback f
		          JOIN chat_messages m ON m.message_id = f.message_id AND m.role = 'assistant'
		         WHERE jsonb_typeof(m.metadata->'citation_doc_ids') = 'array'
		       ) x
		 GROUP BY x.doc_id
		 ORDER BY (count(*) FILTER (WHERE x.rating = 'up') - count(*) FILTER (WHERE x.rating <> 'up')) DESC,
		          up DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocSignal{}
	for rows.Next() {
		var d DocSignal
		if err := rows.Scan(&d.DocID, &d.Title, &d.Up, &d.Down); err != nil {
			return nil, err
		}
		d.Net = d.Up - d.Down
		out = append(out, d)
	}
	return out, rows.Err()
}

// FeedbackSummary 是反馈回流概览计数。
type FeedbackSummary struct {
	TotalFeedback int `json:"total_feedback"`
	Up            int `json:"up"`
	Down          int `json:"down"`
	UsableSamples int `json:"usable_samples"` // 可作 gold 的样本数（👍 + 有问题 + 有被引文档）
}

// FeedbackSignalMap 返回 doc_id → 净分，供在线重排加权（命中即微调排序）。
func (s *Store) FeedbackSignalMap(ctx context.Context) (map[string]int, error) {
	sig, err := s.DocFeedbackSignal(ctx)
	if err != nil {
		return nil, err
	}
	m := make(map[string]int, len(sig))
	for _, d := range sig {
		m[d.DocID] = d.Net
	}
	return m, nil
}
