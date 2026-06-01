import { useState } from "react";
import { Play } from "lucide-react";

import { KpiGrid, PageHeader, PanelHeader, Sparkline, StatusBadge, TabStrip } from "../components/common/PlatformPrimitives";
import { demoAppsSnapshot } from "../data/platformSnapshots";
import type { KpiItem } from "../types/ui";

function deltaOf(series: number[]): { delta: string; deltaTone: "up" | "down" | "flat" } {
  if (series.length < 2) return { delta: "", deltaTone: "flat" };
  const change = ((series[series.length - 1] - series[0]) / (series[0] || 1)) * 100;
  return { delta: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`, deltaTone: change > 0 ? "up" : change < 0 ? "down" : "flat" };
}

export function DemoAppsPage() {
  const snap = demoAppsSnapshot;
  const [tab, setTab] = useState(0);
  const kpis: KpiItem[] = snap.kpis.map((item) => ({ ...item, ...deltaOf(item.trend) }));
  const activeCat = snap.tabs[tab];
  const featured = tab === 0 ? snap.featured : snap.featured.filter((f) => f.category === activeCat);

  return (
    <section className="infra-page demo-replica">
      <PageHeader
        title="Demo 应用"
        subtitle="业务 Demo 作为平台能力验证工作负载，验证 API / RAG / Gateway / 评测链路"
        actions={
          <button className="console-refresh primary" type="button">
            <Play size={14} /> 启动应用
          </button>
        }
      />

      <KpiGrid className="kpi-cols-5" items={kpis} />

      <TabStrip items={snap.tabs.map((t, i) => ({ key: String(i), label: t }))} active={String(tab)} onChange={(k) => setTab(Number(k))} />

      <section className="infra-panel">
        <PanelHeader title="特色应用" action="精选 Demo" />
        <div className="demo-feature-grid">
          {featured.map((app) => (
            <article className="demo-feature-card" key={app.id}>
              <div className="demo-feature-head">
                <strong>{app.name}</strong>
                <StatusBadge status={app.status} />
              </div>
              <span className="demo-feature-cat">{app.category}</span>
              <p>{app.desc}</p>
              <div className="demo-feature-meta">
                <span>{app.model}</span>
                <span>{app.env}</span>
              </div>
              <div className="demo-feature-foot">
                <Sparkline values={app.trend} tone={app.tone} width={120} height={30} />
                <strong>{app.calls}</strong>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="infra-panel">
        <PanelHeader title="全部应用" action={`${snap.apps.length} 个`} />
        <table className="infra-table">
          <thead><tr>{["应用名称", "场景", "关联服务", "健康", "最近访问", "操作"].map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {snap.apps.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.name}</strong></td>
                <td>{a.scene}</td>
                <td><span className="cell-subtle" style={{ marginTop: 0 }}>{a.service}</span></td>
                <td><StatusBadge status={a.health} /></td>
                <td>{a.lastVisit}</td>
                <td><button className="link-btn" type="button">打开</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="infra-panel demo-note">
        <PanelHeader title="Demo 边界说明" action="非核心产品" />
        <p>
          核心产品是<strong>云原生 AI 基础设施平台</strong>（Serving / 治理 / 可观测 / AI Ops / CI-CD / 存储与元数据）；
          业务 Demo 仅用于验证平台 API、RAG 导入、Gateway 路由、评测与 Benchmark 流程，不作为独立产品能力。
        </p>
      </section>
    </section>
  );
}
