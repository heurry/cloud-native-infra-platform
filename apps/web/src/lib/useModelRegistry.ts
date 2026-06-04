// C1：模型注册中心状态机 hook。
//
// 把「列出版本 / 注册 / 改状态 / 删除 / 上传产物」从页面里抽出，统一 toast + 失效列表。
// 列表含按 model_id 的运行时绑定（bindings），供「运行时绑定」视图直接用。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { describeError } from "../components/common/FeedbackStates";
import {
  deleteModelVersion,
  listModelRegistry,
  registerModelVersion,
  updateModelStatus,
  uploadModelArtifact
} from "./api";
import type { RegisterModelInput } from "../types/registry";

export type ModelRegistry = ReturnType<typeof useModelRegistry>;

export function useModelRegistry() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["model-registry"] });

  const list = useQuery({
    queryKey: ["model-registry"],
    queryFn: listModelRegistry,
    refetchInterval: 15000
  });

  const register = useMutation({
    mutationFn: (input: RegisterModelInput) => registerModelVersion(input),
    onSuccess: (_res, input) => {
      toast.success(`已注册 ${input.model_id} ${input.version}`);
      void invalidate();
    },
    onError: (e) => toast.error(`注册失败：${describeError(e)}`)
  });

  const setStatus = useMutation({
    mutationFn: (vars: { id: string; status: string }) => updateModelStatus(vars.id, vars.status),
    onSuccess: (_res, vars) => {
      toast.success(`状态已更新为 ${vars.status}`);
      void invalidate();
    },
    onError: (e) => toast.error(`状态更新失败：${describeError(e)}`)
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteModelVersion(id),
    onSuccess: () => {
      toast.success("版本已注销");
      void invalidate();
    },
    onError: (e) => toast.error(`注销失败：${describeError(e)}`)
  });

  const uploadArtifact = useMutation({
    mutationFn: (vars: { id: string; file: File }) => uploadModelArtifact(vars.id, vars.file),
    onSuccess: (res) => {
      toast.success("产物已上传至 MinIO", { description: res.artifact_uri });
      void invalidate();
    },
    onError: (e) => toast.error(`产物上传失败：${describeError(e)}`)
  });

  return { list, register, setStatus, remove, uploadArtifact };
}
