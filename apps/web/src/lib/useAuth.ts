// D2：认证状态机 hook。/api/auth/me 始终 200，返回 {auth_enabled, authenticated, subject, role}，
// 据此决定是否需要登录。login 写入 JWT 并失效全部查询（带令牌重取），logout 清令牌。
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { describeError } from "../components/common/FeedbackStates";
import { api, setAuthToken, setUnauthorizedHandler } from "./api";

export type Me = {
  auth_enabled: boolean;
  authenticated: boolean;
  subject?: string;
  role?: string;
};

export type Auth = ReturnType<typeof useAuth>;

export function useAuth() {
  const qc = useQueryClient();

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<Me>("/api/auth/me"),
    staleTime: 30_000
  });

  // 令牌失效（401）→ 清令牌并刷新身份，露出登录遮罩。
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthToken(null);
      void qc.invalidateQueries({ queryKey: ["auth", "me"] });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const login = useMutation({
    mutationFn: (creds: { username: string; password: string }) =>
      api<{ token: string; subject: string; role: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(creds)
      }),
    onSuccess: (res) => {
      setAuthToken(res.token);
      toast.success(`已登录：${res.subject}（${res.role}）`);
      void qc.invalidateQueries(); // 带令牌重取全部数据
    },
    onError: (e) => toast.error(`登录失败：${describeError(e)}`)
  });

  function logout() {
    setAuthToken(null);
    toast.success("已退出登录");
    void qc.invalidateQueries();
  }

  const data = me.data;
  return {
    me,
    authEnabled: !!data?.auth_enabled,
    authenticated: !!data?.authenticated,
    subject: data?.subject,
    role: data?.role,
    login,
    logout
  };
}
