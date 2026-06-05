// E3：模型路由状态机 hook —— 策略 CRUD + 灰度全量/回滚，统一 toast + 失效列表。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { describeError } from "../components/common/FeedbackStates";
import {
  createRoutingPolicy,
  deleteRoutingPolicy,
  listRoutingPolicies,
  promoteRoutingVariant,
  rollbackRoutingPolicy,
  serviceInstanceNames,
  updateRoutingPolicy
} from "./api";
import type { SavePolicyInput } from "../types/routing";

export type Routing = ReturnType<typeof useRouting>;

export function useRouting() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["routing", "policies"] });

  const list = useQuery({
    queryKey: ["routing", "policies"],
    queryFn: listRoutingPolicies,
    refetchInterval: 15000
  });

  // 候选/影子下拉来源（serving 实例名）。
  const endpoints = useQuery({
    queryKey: ["routing", "endpoints"],
    queryFn: serviceInstanceNames,
    staleTime: 60000
  });

  const save = useMutation({
    mutationFn: (vars: { input: SavePolicyInput; isEdit: boolean }) =>
      vars.isEdit ? updateRoutingPolicy(vars.input.name, vars.input) : createRoutingPolicy(vars.input),
    onSuccess: (_res, vars) => {
      toast.success(vars.isEdit ? `策略 ${vars.input.name} 已更新` : `已创建策略 ${vars.input.name}`);
      void invalidate();
    },
    onError: (e) => toast.error(`保存失败：${describeError(e)}`)
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteRoutingPolicy(name),
    onSuccess: () => {
      toast.success("策略已删除");
      void invalidate();
    },
    onError: (e) => toast.error(`删除失败：${describeError(e)}`)
  });

  const promote = useMutation({
    mutationFn: (vars: { name: string; label: string }) => promoteRoutingVariant(vars.name, vars.label),
    onSuccess: (_res, vars) => {
      toast.success(`已全量到 ${vars.label}`, { description: "其余候选权重已置 0；可一键回滚" });
      void invalidate();
    },
    onError: (e) => toast.error(`全量失败：${describeError(e)}`)
  });

  const rollback = useMutation({
    mutationFn: (name: string) => rollbackRoutingPolicy(name),
    onSuccess: () => {
      toast.success("已回滚到全量前的权重");
      void invalidate();
    },
    onError: (e) => toast.error(`回滚失败：${describeError(e)}`)
  });

  return { list, endpoints, save, remove, promote, rollback };
}
