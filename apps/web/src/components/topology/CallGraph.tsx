// C3：真实调用图渲染（OTel trace 派生）。固定分列布局，连线粗细 ∝ 近 60s 真实 QPS。
// 纯展示：数据由 ServicesPage 轮询 /api/topology/graph 传入。
import type { CallGraph, CallGraphNode } from "../../types/topology";

const NODE_W = 140;
const NODE_H = 48;
const GAP_Y = 28;
const WIDTH = 700;

type Pos = { x: number; y: number; cx: number; cy: number };

const KIND_LABEL: Record<string, string> = {
  ingress: "入口流量",
  "control-plane": "控制面",
  service: "AI 服务",
  serving: "推理网关",
  cache: "缓存",
  datastore: "数据库"
};

export function CallGraph({ data }: { data: CallGraph | undefined }) {
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];

  if (nodes.length === 0 || edges.length === 0) {
    return (
      <div className="callgraph-empty">
        暂无调用流量。产生一些 API / AI Copilot / 压测调用后，这里会按 OTel span 实时画出
        「入口 → 控制面 → ai-service / 推理网关」的真实调用图（连线粗细 = 近 60s QPS）。
      </div>
    );
  }

  const left = nodes.filter((n) => n.kind === "ingress");
  const mid = nodes.filter((n) => n.kind === "control-plane");
  const right = nodes.filter((n) => n.kind !== "ingress" && n.kind !== "control-plane");
  const rows = Math.max(left.length, mid.length, right.length, 1);
  const height = rows * NODE_H + (rows - 1) * GAP_Y + 48;

  const pos: Record<string, Pos> = {};
  const place = (arr: CallGraphNode[], x: number) => {
    const colH = arr.length * NODE_H + Math.max(arr.length - 1, 0) * GAP_Y;
    let y = (height - colH) / 2;
    for (const n of arr) {
      pos[n.id] = { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
      y += NODE_H + GAP_Y;
    }
  };
  place(left, 16);
  place(mid, WIDTH / 2 - NODE_W / 2);
  place(right, WIDTH - NODE_W - 16);

  const maxQps = Math.max(...edges.map((e) => e.qps), 0.0001);

  return (
    <div className="callgraph">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="实时调用图">
        {edges.map((e) => {
          const s = pos[e.source];
          const t = pos[e.target];
          if (!s || !t) return null;
          // 锚点：源右沿 → 目标左沿（按相对位置取边）。
          const x1 = t.cx >= s.cx ? s.x + NODE_W : s.x;
          const x2 = t.cx >= s.cx ? t.x : t.x + NODE_W;
          const active = e.qps > 0;
          const tone = e.errors > 0 ? "danger" : active ? "active" : "idle";
          const width = active ? 1.5 + (e.qps / maxQps) * 6 : 1.25;
          const midX = (x1 + x2) / 2;
          const midY = (s.cy + t.cy) / 2;
          return (
            <g key={`${e.source}->${e.target}`} className={`callgraph-edge ${tone}`}>
              <line
                x1={x1}
                y1={s.cy}
                x2={x2}
                y2={t.cy}
                strokeWidth={width}
                strokeDasharray={active ? undefined : "4 4"}
                vectorEffect="non-scaling-stroke"
              />
              <text x={midX} y={midY - 5} textAnchor="middle" className="callgraph-edge-label">
                {active ? `${e.qps.toFixed(2)} q/s` : `${e.total} 累计`}
              </text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          return (
            <g key={n.id} className={`callgraph-node kind-${n.kind}`}>
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10} />
              <text x={p.cx} y={p.cy - 4} textAnchor="middle" className="callgraph-node-label">{n.label}</text>
              <text x={p.cx} y={p.cy + 13} textAnchor="middle" className="callgraph-node-sub">
                {(KIND_LABEL[n.kind] ?? n.kind)} · {n.requests} 次{n.errors > 0 ? ` · ${n.errors} err` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
