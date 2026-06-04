import { isValidElement, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { DataTableCell, DataTableRow, EventListItem, KpiItem, KeyValueItem, StrategyCardItem } from "../../types/ui";

/* ---------- Mini SVG primitives ---------- */

export type SparklineTone = "info" | "success" | "warning" | "danger" | "ai" | "neutral";

const toneToColor: Record<SparklineTone, string> = {
  info: "#2563eb",
  success: "#16a34a",
  warning: "#ea580c",
  danger: "#dc2626",
  ai: "#7c3aed",
  neutral: "#94a3b8"
};

export function Sparkline({
  values,
  tone = "info",
  width = 64,
  height = 28,
  fillBelow = true,
  className
}: {
  values: number[];
  tone?: SparklineTone;
  width?: number;
  height?: number;
  fillBelow?: boolean;
  className?: string;
}) {
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => {
      const x = index * stepX;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const color = toneToColor[tone];
  const gradientId = `sparkline-${tone}`;
  return (
    <svg
      aria-hidden="true"
      className={cn("infra-sparkline", className)}
      height={height}
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      {fillBelow && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon
            fill={`url(#${gradientId})`}
            points={`0,${height} ${points} ${width},${height}`}
          />
        </>
      )}
      <polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

export function Donut({
  value,
  max = 100,
  size = 52,
  thickness = 6,
  tone = "info",
  label,
  className
}: {
  value: number;
  max?: number;
  size?: number;
  thickness?: number;
  tone?: SparklineTone;
  label?: string;
  className?: string;
}) {
  const safeMax = max || 1;
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * ratio;
  const color = toneToColor[tone];
  return (
    <div className={cn("infra-donut", className)} style={{ height: size, width: size }}>
      <svg aria-hidden="true" height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke="var(--tw-neutral-100)"
          strokeWidth={thickness}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={color}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="round"
          strokeWidth={thickness}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="infra-donut-label">{label ?? `${Math.round(ratio * 100)}%`}</span>
    </div>
  );
}

export type StatusDotItem = {
  tone: "success" | "warning" | "danger" | "info" | "ai" | "neutral";
  count: number | string;
  label: string;
};

export function StatusDotBreakdown({ items, className }: { items: StatusDotItem[]; className?: string }) {
  return (
    <div className={cn("infra-status-dot-list", className)}>
      {items.map((item) => (
        <span className={cn("infra-status-dot", item.tone)} key={item.label}>
          <i />
          <strong>{item.count}</strong>
          <small>{item.label}</small>
        </span>
      ))}
    </div>
  );
}

export type TabItem<TKey extends string = string> = {
  key: TKey;
  label: string;
  badge?: string;
};

export function TabStrip<TKey extends string = string>({
  items,
  active,
  onChange,
  className
}: {
  items: TabItem<TKey>[];
  active: TKey;
  onChange: (key: TKey) => void;
  className?: string;
}) {
  return (
    <div className={cn("tab-strip", className)}>
      {items.map((tab) => (
        <button
          className={cn(active === tab.key && "active")}
          key={tab.key}
          onClick={() => onChange(tab.key)}
          type="button"
        >
          {tab.label}
          {tab.badge && <span className="tab-strip-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export type ClosedLoopStage = {
  id: string;
  label: string;
  detail?: string;
  state?: "done" | "active" | "pending";
};

export function ClosedLoopRibbon({
  stages,
  className,
  rightAction
}: {
  stages: ClosedLoopStage[];
  className?: string;
  rightAction?: { label: string; onClick?: () => void };
}) {
  return (
    <div className={cn("closed-loop-ribbon v2", className)}>
      <div className="closed-loop-track">
        {stages.map((stage, index) => (
          <div className="closed-loop-cell" key={stage.id}>
            <div className={cn("closed-loop-stage", stage.state ?? "pending")}>
              <span className="closed-loop-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{stage.label}</strong>
                {stage.detail && <small>{stage.detail}</small>}
              </div>
            </div>
            {index < stages.length - 1 && (
              <span className="closed-loop-arrow" aria-hidden="true">
                <ChevronRight size={16} />
              </span>
            )}
          </div>
        ))}
      </div>
      {rightAction && (
        <button className="closed-loop-action" onClick={rightAction.onClick} type="button">
          {rightAction.label}
        </button>
      )}
    </div>
  );
}

export function SectionStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("infra-section-stack", className)}>{children}</div>;
}

export function PageTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="infra-page-title">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

// PageHeader：样例图风格控制台页头（标题 + 说明 + 可选 tabs/操作），替代旧阶段徽章。
// （13-前端复刻改造计划 P1：退役工作流隐喻）
export function PageHeader({
  title,
  subtitle,
  tabs,
  actions,
}: {
  title: string;
  subtitle?: string;
  tabs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="console-page-header">
      <div className="console-page-heading">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {tabs && <div className="console-page-tabs">{tabs}</div>}
      {actions && <div className="console-page-actions">{actions}</div>}
    </header>
  );
}

export function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="infra-panel-header">
      <h2>{title}</h2>
      {action && <span>{action}</span>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = String(status || "unknown").toLowerCase();
  const tone = normalized.includes("running") || normalized.includes("success") || normalized.includes("healthy") || normalized.includes("ready") || normalized.includes("enabled") || normalized.includes("serving") || normalized.includes("indexed") || normalized.includes("linked") || normalized.includes("resolved") || normalized.includes("正常") || normalized.includes("成功") || normalized.includes("健康") || normalized.includes("就绪") || normalized.includes("已启用") || normalized.includes("已索引") || normalized.includes("已关联") || normalized.includes("已恢复") || normalized.includes("已解决") || normalized === "pass" || normalized === "ok"
    ? "success"
    : normalized.includes("failed") || normalized.includes("critical") || normalized.includes("unreachable") || normalized.includes("失败") || normalized.includes("严重") || normalized.includes("不可达") || normalized.includes("故障")
      ? "danger"
      : normalized.includes("warning") || normalized.includes("pending") || normalized.includes("告警") || normalized.includes("等待") || normalized.includes("待处理") || normalized.includes("待") || normalized.includes("高") || normalized === "high" || normalized.includes("guarded") || normalized.includes("受控") || normalized.includes("风险")
        ? "warning"
        : normalized.includes("ai") || normalized.includes("agent") || normalized.includes("auto") || normalized.includes("智能") || normalized.includes("copilot") || normalized.includes("推荐")
          ? "ai"
          : normalized.includes("progressing") || normalized.includes("running step") || normalized.includes("执行中") || normalized.includes("进行中") || normalized.includes("investigating") || normalized.includes("排查中") || normalized.includes("queued") || normalized.includes("排队")
            ? "progress"
            : normalized.includes("info") || normalized.includes("提示") || normalized.includes("connected") || normalized.includes("已连接") || normalized.includes("manual") || normalized.includes("人工") || normalized.includes("read-only") || normalized.includes("只读") || normalized.includes("draft") || normalized.includes("草稿") || normalized.includes("open") || normalized.includes("打开")
              ? "info"
              : "neutral";
  return <span className={cn("infra-status-badge", tone)}>{displayStatus(status)}</span>;
}

export function OverviewKpi({
  label,
  value,
  detail,
  tone,
  onClick,
  trend,
  delta,
  deltaTone,
  unit,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "success" | "warning" | "danger" | "ai";
  onClick?: () => void;
  trend?: number[];
  delta?: string;
  deltaTone?: "up" | "down" | "flat";
  unit?: string;
}) {
  // MetricCard 结构：顶行 label + Δ；中行 value + sparkline；底部 detail。
  // 保持 span/strong/small 标签以复用既有 .infra-kpi-card 字号/配色规则（向后兼容）。
  const content = (
    <>
      <div className="metric-top">
        <span>{label}</span>
        {delta && <span className={cn("metric-delta", deltaTone ?? "flat")}>{delta}</span>}
      </div>
      <div className="metric-mid">
        <strong>
          {value}
          {unit && <em className="metric-unit">{unit}</em>}
        </strong>
        {trend && trend.length > 1 && <Sparkline values={trend} tone={tone ?? "info"} width={56} height={22} />}
      </div>
      <small>{detail}</small>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={cn("infra-kpi-card", tone)} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={cn("infra-kpi-card", tone)}>{content}</div>;
}

export function KpiGrid({ items, compact = false, className }: { items: KpiItem[]; compact?: boolean; className?: string }) {
  return (
    <div className={cn("infra-kpi-grid", compact && "compact", className)}>
      {items.map((item) => (
        <OverviewKpi
          delta={item.delta}
          deltaTone={item.deltaTone}
          detail={item.detail}
          key={item.id}
          label={item.label}
          onClick={item.onClick}
          tone={item.tone}
          trend={item.trend}
          unit={item.unit}
          value={item.value}
        />
      ))}
    </div>
  );
}

export function KeyValueGrid({ className, items }: { className?: string; items: KeyValueItem[] }) {
  return (
    <div className={cn("shared-kv-grid", className)}>
      {items.map((item) => (
        <div className={item.tone ? `tone-${item.tone}` : undefined} key={item.id}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.detail && <small>{item.detail}</small>}
          {item.status && <StatusBadge status={item.status} />}
        </div>
      ))}
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  className,
  scrollClassName
}: {
  columns: string[];
  rows: DataTableRow[];
  className?: string;
  scrollClassName?: string;
}) {
  return (
    <div className={scrollClassName}>
      <div className={cn("infra-resource-table", className, "header")}>
        {columns.map((column) => <span key={column}>{column}</span>)}
      </div>
      {rows.map((row) => (
        <div className={cn("infra-resource-table", className)} key={row.id}>
          {row.cells.map((cell, index) => renderTableCell(cell, `${row.id}-${index}`))}
        </div>
      ))}
    </div>
  );
}

export function StrategyCardGrid({ className, items }: { className?: string; items: StrategyCardItem[] }) {
  return (
    <div className={cn("strategy-card-grid", className)}>
      {items.map((item) => (
        <article className={cn("strategy-card", item.tone && `tone-${item.tone}`)} key={item.id}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.description}</small>
          {item.status && <StatusBadge status={item.status} />}
        </article>
      ))}
    </div>
  );
}

export function EventList({ className, events }: { className?: string; events: EventListItem[] }) {
  return (
    <div className={cn("shared-event-list", className)}>
      {events.map((event) => (
        <div className={cn("shared-event-row", event.tone && `tone-${event.tone}`)} key={event.id}>
          {event.status ? <StatusBadge status={event.status} /> : <span className="shared-event-placeholder" />}
          <div>
            <strong>{event.title}</strong>
            {event.meta && <span>{event.meta}</span>}
            {event.description && <p>{event.description}</p>}
          </div>
          {event.time && <small>{event.time}</small>}
        </div>
      ))}
    </div>
  );
}

export function CapabilityCard({
  icon: Glyph,
  title,
  status,
  description,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  status: string;
  description: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div>
        <span className="capability-icon"><Glyph size={18} /></span>
        <StatusBadge status={status} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="capability-card" onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <article className="capability-card">
      {content}
    </article>
  );
}

function renderTableCell(cell: DataTableCell, key: string) {
  if (isValidElement(cell)) {
    return <span className="table-cell-content" key={key}>{cell}</span>;
  }
  if (typeof cell === "object" && cell !== null && "value" in cell) {
    return cell.strong ? <strong key={key}>{cell.value}</strong> : <span key={key}>{cell.value}</span>;
  }
  return <span key={key}>{cell}</span>;
}

function displayStatus(status: string) {
  const value = String(status || "Unknown");
  const labels: Record<string, string> = {
    connected: "已连接",
    critical: "严重",
    design: "设计中",
    draft: "草稿",
    enabled: "已启用",
    disabled: "已禁用",
    failed: "失败",
    guarded: "受控",
    healthy: "健康",
    high: "高",
    hybrid: "混合",
    indexed: "已索引",
    info: "提示",
    investigating: "排查中",
    linked: "已关联",
    low: "低",
    manual: "人工",
    "manual approval": "人工审批",
    medium: "中",
    normal: "正常",
    ok: "正常",
    open: "打开",
    pass: "通过",
    pending: "待处理",
    planned: "规划中",
    progressing: "进行中",
    queued: "排队中",
    ready: "就绪",
    "read-only": "只读",
    resolved: "已解决",
    running: "运行中",
    serving: "服务中",
    staging: "预发",
    success: "成功",
    unreachable: "不可达",
    warm: "温存储",
    warning: "告警"
  };
  return labels[value.toLowerCase()] ?? value;
}
