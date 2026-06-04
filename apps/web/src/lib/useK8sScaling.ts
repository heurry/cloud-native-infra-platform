// A2：弹性扩缩容写操作的状态机 hook。
//
// 把「手动扩缩 Deployment / 配置·删除 HPA」三个写 mutation 从页面里抽出，
// 统一处理 toast 反馈 + 写后失效集群快照（让 KubernetesPage 立即看到新状态）。
// 写权限由后端 feature flag + 命名空间守卫强约束；前端仅据 snapshot.writes_enabled 灰显控件。

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { describeError } from "../components/common/FeedbackStates";
import { deleteK8sHpa, scaleK8sDeployment, upsertK8sHpa } from "./api";
import type { ScaleDeploymentInput, UpsertHpaInput } from "../types/platform";

export type K8sScaling = ReturnType<typeof useK8sScaling>;

export function useK8sScaling() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["kubernetes", "snapshot"] });

  const scale = useMutation({
    mutationFn: (input: ScaleDeploymentInput) => scaleK8sDeployment(input),
    onSuccess: (res, input) => {
      toast.success(`${input.name} 已扩缩至 ${res.replicas} 副本`);
      void invalidate();
    },
    onError: (e) => toast.error(`扩缩失败：${describeError(e)}`)
  });

  const upsertHpa = useMutation({
    mutationFn: (input: UpsertHpaInput) => upsertK8sHpa(input),
    onSuccess: (_res, input) => {
      toast.success(`HPA 已应用到 ${input.target_name}`, {
        description: `${input.min_replicas}–${input.max_replicas} 副本 · CPU ${input.target_cpu_util}%`
      });
      void invalidate();
    },
    onError: (e) => toast.error(`HPA 配置失败：${describeError(e)}`)
  });

  const removeHpa = useMutation({
    mutationFn: (vars: { namespace: string; name: string }) => deleteK8sHpa(vars.namespace, vars.name),
    onSuccess: (_res, vars) => {
      toast.success(`HPA ${vars.name} 已删除`);
      void invalidate();
    },
    onError: (e) => toast.error(`HPA 删除失败：${describeError(e)}`)
  });

  return { scale, upsertHpa, removeHpa };
}
