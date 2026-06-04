// D2：登录遮罩。仅在认证开启且未登录时由 App 渲染，挡住整个应用直到登录。
import { useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";

import type { Auth } from "../../lib/useAuth";

export function LoginModal({ auth }: { auth: Auth }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const pending = auth.login.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (username.trim() && password) {
      auth.login.mutate({ username: username.trim(), password });
    }
  }

  return (
    <div className="login-overlay" role="dialog" aria-modal="true">
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <span className="login-icon"><ShieldCheck size={20} /></span>
          <div>
            <strong>登录</strong>
            <small>平台已开启认证（RBAC）·请使用账户登录</small>
          </div>
        </div>
        <input className="drawer-input" placeholder="用户名" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="drawer-input" type="password" placeholder="口令" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="infra-action-btn" type="submit" disabled={pending || !username.trim() || !password}>
          {pending ? "登录中…" : "登录"}
        </button>
        <p className="login-hint">演示账户：admin / operator / viewer（口令同用户名）。viewer 只读，operator+ 可写。</p>
      </form>
    </div>
  );
}
