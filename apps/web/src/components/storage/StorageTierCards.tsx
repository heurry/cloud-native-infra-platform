// C2：分层存储——各层占用卡片（热 Redis / 关系 PG / 对象 MinIO）+ 当前保留策略。
import { Database, HardDrive, Layers, Settings2 } from "lucide-react";

import { ErrorState, Skeleton } from "../common/FeedbackStates";
import { bytes } from "../../lib/format";
import type { Storage } from "../../lib/useStorage";

export function StorageTierCards({ storage, onConfigure }: { storage: Storage; onConfigure: () => void }) {
  const { tiers } = storage;
  if (tiers.isLoading) return <Skeleton rows={3} />;
  if (tiers.isError) return <ErrorState error={tiers.error} onRetry={tiers.refetch} />;
  const data = tiers.data;
  if (!data) return null;

  const retention = data.retention ?? {};

  return (
    <>
      <div className="storage-retention">
        <span className="storage-retention-label"><Settings2 size={14} /> 保留策略（来自配置中心 storage.retention）</span>
        <div className="storage-retention-pills">
          {Object.keys(retention).length === 0 ? (
            <em>未配置 · 使用内置默认</em>
          ) : (
            Object.entries(retention).map(([table, days]) => (
              <span key={table} className="storage-retention-pill">{table}: {days} 天</span>
            ))
          )}
          <button className="link-btn" type="button" onClick={onConfigure}>配置保留期 →</button>
        </div>
        <small className="storage-retention-note">
          自动归档：{data.archive_enabled ? "已开启（周期扫描）" : "未开启（仅手动触发）"}
        </small>
      </div>

      <div className="storage-tier-grid">
        {data.tiers.map((t) => {
          const Icon = t.kind === "cache" ? Layers : t.kind === "relational" ? Database : HardDrive;
          return (
            <section className={`infra-panel storage-tier-card kind-${t.kind}`} key={t.id}>
              <header className="storage-tier-head">
                <span className="storage-tier-icon"><Icon size={18} /></span>
                <div>
                  <strong>{t.label}</strong>
                  <small className={t.enabled ? "ok" : "off"}>{t.enabled ? "在线" : "未启用"}</small>
                </div>
              </header>

              {t.kind === "relational" && (
                <>
                  <div className="storage-tier-metric">
                    <strong>{bytes(t.total_bytes ?? 0)}</strong>
                    <small>PG 物理占用（关键表）</small>
                  </div>
                  <div className="storage-table-list">
                    {(t.tables ?? []).map((row) => (
                      <div className="storage-table-row" key={row.table}>
                        <span>{row.table}</span>
                        <em>{row.rows.toLocaleString()} 行</em>
                        <small>{bytes(row.bytes)}</small>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {t.kind === "object" && (
                <>
                  <div className="storage-tier-metric">
                    <strong>{bytes(t.archived_bytes ?? 0)}</strong>
                    <small>{(t.archived_rows ?? 0).toLocaleString()} 行 · {t.manifests ?? 0} 个归档批次</small>
                  </div>
                  <p className="storage-tier-detail">{t.detail}</p>
                </>
              )}

              {t.kind === "cache" && <p className="storage-tier-detail">{t.detail}</p>}
            </section>
          );
        })}
      </div>
    </>
  );
}
