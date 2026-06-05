import {
  Activity,
  Bot,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Headset,
  Home,
  Library,
  Network,
  Route,
  Server,
  Settings,
  Split,
  Target,
  type LucideIcon
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { Page } from "../../types/navigation";

// 扁平能力域导航（13-前端复刻改造计划 P1）：退役阶段式分组，按样例图重排为资源域。
const navItems: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: "dashboard", label: "平台总览", icon: Home },
  { id: "services", label: "模型服务", icon: Server },
  { id: "kubernetes", label: "Kubernetes", icon: Network },
  { id: "observability", label: "可观测性", icon: Activity },
  { id: "aiOps", label: "AI Ops", icon: Bot },
  { id: "config", label: "配置中心", icon: Database },
  { id: "pipelines", label: "发布流水线", icon: Route },
  { id: "benchmarks", label: "压测验证", icon: Gauge },
  { id: "models", label: "模型注册", icon: Cpu },
  { id: "routing", label: "模型路由", icon: Split },
  { id: "knowledge", label: "知识库 / RAG", icon: Library },
  { id: "support", label: "智能客服", icon: Headset },
  { id: "evals", label: "检索评测", icon: Target },
  { id: "storage", label: "存储分层", icon: HardDrive },
  { id: "settings", label: "设置", icon: Settings }
];

export function AppSidebar({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  return (
    <aside className="infra-sidebar">
      <nav className="infra-nav" aria-label="云原生 AI 设施平台导航">
        {navItems.map((item) => {
          const Glyph = item.icon;
          return (
            <button
              key={item.id}
              className={cn("infra-nav-button", page === item.id && "active")}
              onClick={() => setPage(item.id)}
              type="button"
            >
              <Glyph size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
