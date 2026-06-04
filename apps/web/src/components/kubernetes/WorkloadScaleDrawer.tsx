// A2：弹性伸缩管理抽屉（作用域：单个 Deployment）。
//
// 薄组合：把「手动扩缩副本」与「自动扩缩 HPA」两个 section 装进通用右侧抽屉；
// 写逻辑全在 useK8sScaling，本组件不持有业务状态。
import { Drawer } from "../common/Drawer";
import { ManualScaleSection } from "./ManualScaleSection";
import { HpaSection } from "./HpaSection";
import type { K8sScaling } from "../../lib/useK8sScaling";
import type { K8sHPA } from "../../types/platform";

export type ScaleTarget = { namespace: string; name: string; desired: number; ready: string };

export function WorkloadScaleDrawer({
  target,
  hpa,
  scaling,
  onClose
}: {
  target: ScaleTarget;
  hpa: K8sHPA | null;
  scaling: K8sScaling;
  onClose: () => void;
}) {
  return (
    <Drawer open title="弹性伸缩管理" subtitle={`${target.namespace} / ${target.name}`} onClose={onClose}>
      <ManualScaleSection
        namespace={target.namespace}
        name={target.name}
        desired={target.desired}
        ready={target.ready}
        scaling={scaling}
      />
      <HpaSection namespace={target.namespace} targetName={target.name} existing={hpa} scaling={scaling} />
    </Drawer>
  );
}
