// A2：自动扩缩（HPA）配置（drawer 内一个 section）。
//
// 已存在该 Deployment 的 HPA → 预填 + 支持更新/删除；否则为创建。CPU 平均利用率触发水平伸缩。
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import type { K8sScaling } from "../../lib/useK8sScaling";
import type { K8sHPA } from "../../types/platform";

const MAX_REPLICAS = 50;

export function HpaSection({
  namespace,
  targetName,
  existing,
  scaling
}: {
  namespace: string;
  targetName: string;
  existing: K8sHPA | null;
  scaling: K8sScaling;
}) {
  const [min, setMin] = useState(existing?.min_replicas ?? 1);
  const [max, setMax] = useState(existing?.max_replicas ?? 3);
  const [cpu, setCpu] = useState(parseCpuTarget(existing?.metric) ?? 70);

  // 切换目标 / 后端 HPA 变化时同步表单。
  useEffect(() => {
    setMin(existing?.min_replicas ?? 1);
    setMax(existing?.max_replicas ?? 3);
    setCpu(parseCpuTarget(existing?.metric) ?? 70);
  }, [existing, namespace, targetName]);

  const upsertPending = scaling.upsertHpa.isPending;
  const deletePending = scaling.removeHpa.isPending;
  const valid = min >= 1 && max >= min && max <= MAX_REPLICAS && cpu >= 1 && cpu <= 100;

  return (
    <div className="drawer-section">
      <div className="infra-drawer-section-title">自动扩缩（HPA）</div>
      <p className="k8s-scale-hint">
        {existing ? `现有 HPA：${existing.current_replicas}/${existing.desired_replicas} 副本 · ${existing.metric}` : "尚未配置 HPA（按 CPU 平均利用率水平伸缩）"}
      </p>
      <div className="k8s-hpa-form">
        <label>
          <span>最小副本</span>
          <input className="drawer-input" type="number" min={1} max={MAX_REPLICAS} value={min} onChange={(e) => setMin(Math.max(1, Math.round(Number(e.target.value) || 1)))} />
        </label>
        <label>
          <span>最大副本</span>
          <input className="drawer-input" type="number" min={1} max={MAX_REPLICAS} value={max} onChange={(e) => setMax(Math.min(MAX_REPLICAS, Math.round(Number(e.target.value) || 1)))} />
        </label>
        <label>
          <span>目标 CPU%</span>
          <input className="drawer-input" type="number" min={1} max={100} value={cpu} onChange={(e) => setCpu(Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 1)))) } />
        </label>
      </div>
      {!valid && <p className="k8s-scale-error">需满足 1 ≤ 最小 ≤ 最大 ≤ {MAX_REPLICAS}，CPU 1–100%</p>}
      <div className="k8s-hpa-actions">
        <button
          className="infra-action-btn"
          type="button"
          disabled={!valid || upsertPending}
          onClick={() => scaling.upsertHpa.mutate({ namespace, target_name: targetName, min_replicas: min, max_replicas: max, target_cpu_util: cpu })}
        >
          {upsertPending ? "应用中…" : existing ? "更新 HPA" : "创建 HPA"}
        </button>
        {existing && (
          <button
            className="link-btn danger"
            type="button"
            disabled={deletePending}
            onClick={() => scaling.removeHpa.mutate({ namespace, name: existing.name })}
          >
            <Trash2 size={14} /> {deletePending ? "删除中…" : "删除"}
          </button>
        )}
      </div>
    </div>
  );
}

// parseCpuTarget 从 HPA metric 串（如 "cpu 45%/70%"）解析目标利用率（"/" 后部分）。
function parseCpuTarget(metric?: string): number | null {
  if (!metric) return null;
  const m = metric.match(/\/\s*(\d+)%/);
  return m ? Number(m[1]) : null;
}
