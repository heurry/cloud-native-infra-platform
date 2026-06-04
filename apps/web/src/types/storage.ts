// C2：分层存储生命周期类型。

export type StorageRetention = Record<string, number>; // table -> 保留天数

export type PgTable = { table: string; rows: number; bytes: number };

export type StorageTier = {
  id: string;
  label: string;
  kind: string; // cache | relational | object
  enabled: boolean;
  detail?: string;
  total_bytes?: number;
  tables?: PgTable[];
  manifests?: number;
  archived_rows?: number;
  archived_bytes?: number;
};

export type StorageTiers = {
  retention: StorageRetention;
  archive_enabled: boolean;
  tiers: StorageTier[];
};

export type ArchiveManifest = {
  id: string;
  source_table: string;
  object_key: string;
  row_count: number;
  bytes: number;
  min_ts: string | null;
  max_ts: string | null;
  archived_by: string | null;
  archived_at: string | null;
};

export type ArchiveRunResult = {
  table: string;
  row_count: number;
  bytes: number;
  object_key?: string;
  retention_days: number;
  skipped?: string;
};
