// C2：存储分层页（薄组合）。冷热数据生命周期：PG 关系层 → MinIO 对象层归档。
import { Archive, RefreshCw } from "lucide-react";

import { PageHeader, PanelHeader } from "../components/common/PlatformPrimitives";
import { StorageTierCards } from "../components/storage/StorageTierCards";
import { StorageArchiveTable } from "../components/storage/StorageArchiveTable";
import { useStorage } from "../lib/useStorage";
import { useGoToPage } from "../lib/useGoToPage";

export function StoragePage() {
  const storage = useStorage();
  const goTo = useGoToPage();

  return (
    <section className="infra-page storage-page">
      <PageHeader
        title="存储分层"
        subtitle="冷热数据生命周期：PG 关系层 → MinIO 对象层归档，保留策略由配置中心驱动"
        actions={
          <div className="storage-actions">
            <button
              className="console-refresh"
              type="button"
              onClick={() => {
                storage.tiers.refetch();
                storage.archives.refetch();
              }}
            >
              <RefreshCw className={storage.tiers.isFetching ? "spinning" : undefined} size={14} /> 刷新
            </button>
            <button
              className="console-refresh primary"
              type="button"
              disabled={storage.run.isPending}
              onClick={() => storage.run.mutate()}
            >
              <Archive size={14} /> {storage.run.isPending ? "归档中…" : "立即归档"}
            </button>
          </div>
        }
      />

      <StorageTierCards storage={storage} onConfigure={() => goTo("config")} />

      <section className="infra-panel storage-archive-panel">
        <PanelHeader title="归档清单" action="冷数据可回溯（对象层）" />
        <StorageArchiveTable storage={storage} />
      </section>
    </section>
  );
}
