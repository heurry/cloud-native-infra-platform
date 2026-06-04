// C3：真实服务拓扑（OTel trace 派生的调用图）。

export type CallGraphNode = {
  id: string;
  label: string;
  kind: string; // ingress | control-plane | service | serving | cache | datastore
  requests: number;
  errors: number;
};

export type CallGraphEdge = {
  source: string;
  target: string;
  target_kind: string;
  requests: number; // 近 window 内
  errors: number;
  total: number; // 累计
  qps: number; // 近 window 平均
};

export type CallGraph = {
  self: string;
  window_seconds: number;
  generated_at: string;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
};
