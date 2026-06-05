// E2：RAG 评测体系 + 在线反馈回流类型。

export type FeedbackSummary = {
  total_feedback: number;
  up: number;
  down: number;
  usable_samples: number; // 可作 gold 的样本（👍 + 有问题 + 有被引文档）
};

export type FeedbackSample = {
  message_id: string;
  question: string;
  gold_doc_ids: string[];
  rating: string; // up | down
  created_at: string;
};

export type FeedbackDataset = {
  summary: FeedbackSummary;
  samples: FeedbackSample[];
};

export type DocSignal = {
  doc_id: string;
  title: string;
  up: number;
  down: number;
  net: number;
};

export type DocSignalList = {
  docs: DocSignal[];
  rerank_enabled: boolean;
};

export type RagEvalMetrics = {
  num_samples: number;
  retrieval_recall_at_1: number;
  retrieval_recall_at_3: number;
  retrieval_recall_at_5: number;
  source?: string;
};

export type RagEvalSample = {
  message_id: string;
  question: string;
  gold_doc_ids: string[];
  retrieved_doc_ids: string[];
  hit_at_1: boolean;
  hit_at_3: boolean;
  hit_at_5: boolean;
};

export type RagEvalResult = {
  run_id: string;
  status: string;
  metrics: RagEvalMetrics;
  samples: RagEvalSample[];
};

export type RagEvalRun = {
  run_id: string;
  status: string;
  metrics: RagEvalMetrics;
  created_at: string;
};

export type RagEvalHistory = {
  dataset: string;
  runs: RagEvalRun[];
};
