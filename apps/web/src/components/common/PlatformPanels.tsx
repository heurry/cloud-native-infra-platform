import { type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, type LucideIcon, MoreHorizontal, Sparkles } from "lucide-react";

import { cn } from "../../lib/utils";
import { Donut, Sparkline, StatusDotBreakdown, type SparklineTone, type StatusDotItem } from "./PlatformPrimitives";

/* =====================================================================
 * KpiCardWithChart
 * ---------------------------------------------------------------------
 * Compact (~100px tall) KPI card carrying one visual element:
 *   - sparkline  (trend)
 *   - donut      (percentage / capacity)
 *   - breakdown  (●2 紧急 ●1 警告)
 * Optional delta arrow next to the value.
 * ===================================================================== */

export type KpiTone = "success" | "warning" | "danger" | "ai" | "info";

export type KpiChart =
  | { type: "sparkline"; values: number[]; tone?: SparklineTone }
  | { type: "donut"; value: number; max?: number; tone?: SparklineTone; label?: string };

export type KpiDelta = {
  direction: "up" | "down" | "flat";
  value: string;
  tone?: KpiTone;
};

export type KpiCardWithChartProps = {
  label: string;
  value: string;
  detail?: string;
  chart?: KpiChart;
  breakdown?: StatusDotItem[];
  delta?: KpiDelta;
  tone?: KpiTone;
  icon?: LucideIcon;
  onClick?: () => void;
  className?: string;
};

export function KpiCardWithChart({
  label,
  value,
  detail,
  chart,
  breakdown,
  delta,
  tone,
  icon: Icon,
  onClick,
  className
}: KpiCardWithChartProps) {
  const content = (
    <>
      <div className="kpi-chart-card-head">
        <span className="kpi-chart-card-label">
          {Icon && <Icon size={14} />}
          {label}
        </span>
        {chart && chart.type === "donut" && (
          <Donut
            label={chart.label}
            max={chart.max}
            size={48}
            thickness={5}
            tone={chart.tone ?? tone ?? "info"}
            value={chart.value}
          />
        )}
        {chart && chart.type === "sparkline" && (
          <Sparkline height={28} tone={chart.tone ?? tone ?? "info"} values={chart.values} width={64} />
        )}
      </div>
      <div className="kpi-chart-card-value">
        <strong>{value}</strong>
        {delta && (
          <span className={cn("kpi-chart-card-delta", delta.tone, delta.direction)}>
            {delta.direction === "up" && <ArrowUpRight size={12} />}
            {delta.direction === "down" && <ArrowDownRight size={12} />}
            {delta.value}
          </span>
        )}
      </div>
      <div className="kpi-chart-card-foot">
        {breakdown && breakdown.length > 0 ? (
          <StatusDotBreakdown items={breakdown} />
        ) : (
          detail && <small>{detail}</small>
        )}
      </div>
    </>
  );

  const classes = cn("kpi-chart-card", tone && `tone-${tone}`, className);
  if (onClick) {
    return (
      <button className={classes} onClick={onClick} type="button">
        {content}
      </button>
    );
  }
  return <article className={classes}>{content}</article>;
}

export function KpiChartGrid({ items, className }: { items: KpiCardWithChartProps[]; className?: string }) {
  return (
    <div className={cn("kpi-chart-grid", className)}>
      {items.map((item, index) => (
        <KpiCardWithChart key={`${item.label}-${index}`} {...item} />
      ))}
    </div>
  );
}

/* =====================================================================
 * DiagnosticGrid + SubPanel
 * ---------------------------------------------------------------------
 * Multi-column aggregated diagnostic layout. Pages compose 3-4 SubPanels
 * inside a DiagnosticGrid (along with the TabStrip for tab indicators).
 * ===================================================================== */

export function DiagnosticGrid({
  children,
  columns = 4,
  className
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div className={cn("diagnostic-grid", `cols-${columns}`, className)}>
      {children}
    </div>
  );
}

export function SubPanel({
  title,
  hint,
  children,
  className,
  tone
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
  tone?: KpiTone;
}) {
  return (
    <section className={cn("sub-panel", tone && `tone-${tone}`, className)}>
      <header>
        <h3>{title}</h3>
        {hint && <span>{hint}</span>}
      </header>
      <div className="sub-panel-body">{children}</div>
    </section>
  );
}

/* =====================================================================
 * PriorityActionCard
 * ---------------------------------------------------------------------
 * Copilot decision card. Numbered priority badge + title + recommended
 * tag + 2-line description + risk/ETA meta + own primary CTA.
 * ===================================================================== */

export type PriorityActionMeta = {
  label: string;
  value: string;
  tone?: "neutral" | "warning" | "success" | "danger";
};

export type PriorityActionCardProps = {
  priority: number;
  title: string;
  description: string;
  recommended?: boolean;
  meta?: PriorityActionMeta[];
  primaryAction?: { label: string; onClick?: () => void; tone?: "primary" | "secondary" };
  className?: string;
};

export function PriorityActionCard({
  priority,
  title,
  description,
  recommended,
  meta,
  primaryAction,
  className
}: PriorityActionCardProps) {
  return (
    <article className={cn("priority-action-card", className, recommended && "recommended")}>
      <header>
        <span className="priority-badge">{String(priority).padStart(2, "0")}</span>
        <strong>{title}</strong>
        {recommended && <span className="priority-tag">推荐</span>}
        <button className="priority-row-more" type="button" aria-label="更多">
          <MoreHorizontal size={14} />
        </button>
      </header>
      <p>{description}</p>
      {meta && meta.length > 0 && (
        <dl className="priority-action-meta">
          {meta.map((row) => (
            <div className={cn(row.tone && `tone-${row.tone}`)} key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {primaryAction && (
        <button
          className={cn("priority-action-button", primaryAction.tone === "secondary" ? "secondary" : "primary")}
          onClick={primaryAction.onClick}
          type="button"
        >
          {primaryAction.tone === "secondary" ? null : <Sparkles size={13} />}
          {primaryAction.label}
        </button>
      )}
    </article>
  );
}

export function PriorityActionStack({
  items,
  className
}: {
  items: PriorityActionCardProps[];
  className?: string;
}) {
  return (
    <div className={cn("priority-action-stack", className)}>
      {items.map((item) => (
        <PriorityActionCard key={`pri-${item.priority}-${item.title}`} {...item} />
      ))}
    </div>
  );
}
