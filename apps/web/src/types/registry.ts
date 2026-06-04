// C1：模型注册中心类型（独立 model registry —— 版本化 + 血缘 + 产物 + 运行时绑定）。

export type RegisteredModelVersion = {
  id: string;
  model_id: string;
  version: string;
  base_model: string | null;
  lora_adapter: string | null;
  parent_version: string | null;
  artifact_uri: string | null;
  tags: string[];
  status: string; // registered | active | deprecated
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// 运行时绑定：某 model_id 当前由哪些 service_instances 在 serve。
export type ModelBinding = {
  name: string;
  kind: string;
  status: string;
  base_url: string;
  gpu_id: string | null;
};

export type ModelRegistryList = {
  versions: RegisteredModelVersion[];
  bindings: Record<string, ModelBinding[]>;
};

export type RegisterModelInput = {
  model_id: string;
  version: string;
  base_model?: string;
  lora_adapter?: string;
  parent_version?: string;
  artifact_uri?: string;
  tags?: string[];
  status?: string;
};

export type ModelStatus = "registered" | "active" | "deprecated";
