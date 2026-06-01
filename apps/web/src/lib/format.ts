export function fmt(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined) return "-";
  return value.toFixed(digits);
}

export function pct(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined) return "-";
  return `${fmt(value, digits)}%`;
}

export function fmtPercentMetric(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined ? "-" : `${fmt(value, digits)}%`;
}

export function bytes(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = Math.max(value, 0);
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next.toFixed(unit === 0 ? 0 : digits)} ${units[unit]}`;
}

export function byteRate(value: number | null | undefined) {
  return `${bytes(value)}/s`;
}

export function formatKubernetesPhase(phase: string) {
  const labels: Record<string, string> = {
    Running: "运行中",
    Pending: "等待中",
    Succeeded: "已完成",
    Failed: "失败",
    Unknown: "未知"
  };
  return labels[phase] ?? phase ?? "-";
}

export function formatTraceStatus(status: string) {
  const labels: Record<string, string> = {
    ok: "成功",
    success: "成功",
    error: "错误",
    failed: "失败",
    timeout: "超时"
  };
  return labels[status] ?? status ?? "-";
}

export function compact(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    notation: Math.abs(value) >= 10000 ? "compact" : "standard"
  }).format(value);
}

export function compactMeta(items: Array<string | null | undefined>) {
  return items.map((item) => String(item || "").trim()).filter(Boolean).join(" · ") || "-";
}

export function relativeTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  const t = date.getTime();
  if (Number.isNaN(t)) return value;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 0) return "刚刚";
  if (diffSec < 60) return `${diffSec}秒前`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  return date.toLocaleDateString("zh-CN");
}

export function shortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(-8);
  }
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
