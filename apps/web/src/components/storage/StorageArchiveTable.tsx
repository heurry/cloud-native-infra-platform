// C2：归档清单表（冷数据可回溯入口）。每条 = 一次 PG→MinIO 归档批次，可取预签名下载地址。
import { toast } from "sonner";
import { Download } from "lucide-react";

import { describeError, EmptyState, ErrorState, Skeleton } from "../common/FeedbackStates";
import { archiveDownloadURL } from "../../lib/api";
import { bytes, shortTime } from "../../lib/format";
import type { Storage } from "../../lib/useStorage";

export function StorageArchiveTable({ storage }: { storage: Storage }) {
  const { archives } = storage;

  async function download(id: string) {
    try {
      const res = await archiveDownloadURL(id);
      if (res.download_url) window.open(res.download_url, "_blank", "noopener");
      else toast.info(res.note || "对象存储未启用");
    } catch (e) {
      toast.error(`获取下载地址失败：${describeError(e)}`);
    }
  }

  if (archives.isLoading) return <Skeleton rows={3} />;
  if (archives.isError) return <ErrorState error={archives.error} onRetry={archives.refetch} />;
  const rows = archives.data?.archives ?? [];
  if (rows.length === 0) {
    return <EmptyState title="暂无归档批次" description="点击「立即归档」把早于保留期的冷数据下沉到对象层" />;
  }

  return (
    <table className="infra-table storage-archive-table">
      <thead>
        <tr>{["来源表", "行数", "大小", "时间范围", "归档时间", "操作"].map((c) => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td><strong>{m.source_table}</strong></td>
            <td>{m.row_count.toLocaleString()}</td>
            <td>{bytes(m.bytes)}</td>
            <td>
              {m.min_ts ? shortTime(m.min_ts) : "—"} → {m.max_ts ? shortTime(m.max_ts) : "—"}
            </td>
            <td>{m.archived_at ? shortTime(m.archived_at) : "—"}</td>
            <td>
              <button className="link-btn" type="button" onClick={() => void download(m.id)}>
                <Download size={13} /> 下载
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
