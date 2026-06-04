// 检索召回评测数据形状。后端：POST /api/evals/customer-support（同步返回聚合指标 + 逐样本明细）。
export type KnowledgeDoc = {
  doc_id: string;
  title: string;
  category?: string;
  version?: string;
  source_uri?: string;
  created_at?: string;
};

// 一条评测样本：问题 + 它应命中的标准答案文档（gold）。
export type QASample = {
  question: string;
  doc_ids: string[];
};

export type EvalCaseResult = {
  question: string;
  gold_doc_ids: string[];
  retrieved_doc_ids: string[];
  hit_at_1: boolean;
  hit_at_3: boolean;
  hit_at_5: boolean;
};

export type EvalMetrics = {
  num_samples: number;
  retrieval_recall_at_1: number;
  retrieval_recall_at_3: number;
  retrieval_recall_at_5: number;
};

export type EvalRunResult = {
  run_id: string;
  status: string;
  metrics: EvalMetrics;
  samples?: EvalCaseResult[]; // 新后端返回；旧后端可能没有（前端优雅降级）
};
