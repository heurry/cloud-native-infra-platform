// A2：手动扩缩副本（drawer 内一个 section）。纯展示 + 受控输入，写交给 useK8sScaling。
import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";

import type { K8sScaling } from "../../lib/useK8sScaling";

const MAX_REPLICAS = 50;

export function ManualScaleSection({
  namespace,
  name,
  desired,
  ready,
  scaling
}: {
  namespace: string;
  name: string;
  desired: number;
  ready: string;
  scaling: K8sScaling;
}) {
  const [replicas, setReplicas] = useState(desired);
  // 切换目标 / 后端期望值变化时重置受控值。
  useEffect(() => setReplicas(desired), [desired, namespace, name]);

  const clamp = (n: number) => Math.max(0, Math.min(MAX_REPLICAS, Math.round(n)));
  const dirty = replicas !== desired;
  const pending = scaling.scale.isPending;

  return (
    <div className="drawer-section">
      <div className="infra-drawer-section-title">手动扩缩副本</div>
      <p className="k8s-scale-hint">当前就绪 {ready} · 期望副本 {desired}</p>
      <div className="k8s-replica-stepper">
        <button type="button" aria-label="减少副本" disabled={pending || replicas <= 0} onClick={() => setReplicas((n) => clamp(n - 1))}>
          <Minus size={16} />
        </button>
        <input
          type="number"
          min={0}
          max={MAX_REPLICAS}
          value={replicas}
          onChange={(e) => setReplicas(clamp(Number(e.target.value)))}
        />
        <button type="button" aria-label="增加副本" disabled={pending || replicas >= MAX_REPLICAS} onClick={() => setReplicas((n) => clamp(n + 1))}>
          <Plus size={16} />
        </button>
      </div>
      <button
        className="infra-action-btn"
        type="button"
        disabled={!dirty || pending}
        onClick={() => scaling.scale.mutate({ namespace, name, replicas })}
      >
        {pending ? "应用中…" : dirty ? `扩缩至 ${replicas} 副本` : "无变更"}
      </button>
    </div>
  );
}
