-- Phase 5 / 5B.4c：启用 pgvector 扩展。
-- 单独成一次迁移：golang-migrate 逐文件提交，确保 vector 类型在下一迁移（000007 建表）
-- 之前已落地。若与建表放同一文件，pgx 多语句 Exec 会因新类型/目录在同批次中不可见而失败。
-- 需要带 pgvector 的镜像（compose/helm 用 pgvector/pgvector:pg16）。
CREATE EXTENSION IF NOT EXISTS vector;
