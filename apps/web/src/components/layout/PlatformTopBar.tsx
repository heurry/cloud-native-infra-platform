import { Activity, AlertTriangle, ChevronDown, HelpCircle, Search, ShieldCheck, Sparkles, UserRound } from "lucide-react";

export function PlatformTopBar() {
  return (
    <header className="infra-topbar">
      <div className="infra-topbar-brand">
        <span className="infra-brand-mark"><Sparkles size={16} /></span>
        <strong>AI 基础设施平台</strong>
      </div>
      <label className="infra-global-search">
        <Search size={15} />
        <input placeholder="搜索服务、资源、配置、文档..." />
        <kbd>⌘ K</kbd>
      </label>
      <div className="infra-topbar-actions">
        <button className="infra-env-select" type="button">
          <span>Prod / us-east-1</span>
          <ChevronDown size={14} />
        </button>
        <button className="infra-icon-action" title="帮助" type="button"><ShieldCheck size={16} /></button>
        <button className="infra-icon-action" title="活动" type="button"><Activity size={16} /></button>
        <button className="infra-icon-action has-dot" title="通知" type="button"><AlertTriangle size={16} /></button>
        <button className="infra-icon-action" title="帮助文档" type="button"><HelpCircle size={16} /></button>
        <span className="infra-user-avatar"><UserRound size={16} /><small>A</small></span>
        <ChevronDown className="infra-user-caret" size={14} />
      </div>
    </header>
  );
}
