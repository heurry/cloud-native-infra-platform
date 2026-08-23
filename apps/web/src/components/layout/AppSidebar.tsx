import {
  Activity,
  Bot,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  GraduationCap,
  HardDrive,
  Headset,
  Home,
  Library,
  Network,
  Rocket,
  Route,
  Server,
  Settings,
  Split,
  Target,
  ThumbsUp,
  type LucideIcon
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { Page } from "../../types/navigation";

type NavItem = { id: Page; label: string; icon: LucideIcon };
type NavSection = { id: string; label: string; items: NavItem[] };

const navSections: NavSection[] = [
  { id: "workbench", label: "工作台", items: [
    { id: "dashboard", label: "平台总览", icon: Home },
    { id: "training", label: "训练微调", icon: GraduationCap },
    { id: "benchmarks", label: "推理优化", icon: Gauge },
    { id: "release", label: "发布中心", icon: Rocket },
    { id: "aiOps", label: "AIOps 诊断", icon: Bot },
  ] },
  { id: "assets", label: "交付资产", items: [
    { id: "datasets", label: "数据资产", icon: FlaskConical },
    { id: "models", label: "模型与版本", icon: Cpu },
    { id: "config", label: "配置与版本", icon: Database },
  ] },
  { id: "platform", label: "运行平台", items: [
    { id: "services", label: "服务与 Workload", icon: Server },
    { id: "pipelines", label: "服务发布流水线", icon: Route },
    { id: "observability", label: "可观测性", icon: Activity },
    { id: "kubernetes", label: "Kubernetes", icon: Network },
    { id: "routing", label: "模型路由", icon: Split },
    { id: "storage", label: "存储归档", icon: HardDrive },
  ] },
  { id: "extensions", label: "AI 应用与评测", items: [
    { id: "knowledge", label: "知识库 / RAG", icon: Library },
    { id: "support", label: "智能客服", icon: Headset },
    { id: "evals", label: "检索评测", icon: Target },
    { id: "feedback", label: "反馈回流", icon: ThumbsUp },
  ] },
  { id: "system", label: "系统", items: [
    { id: "settings", label: "设置", icon: Settings },
  ] },
];

export function AppSidebar({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  return (
    <aside className="infra-sidebar">
      <nav className="infra-nav" aria-label="TwinForge 大模型实验平台导航">
        {navSections.map((section) => (
          <section className="infra-nav-section" key={section.id}>
            <div className="infra-nav-section-header"><span className="infra-nav-section-label">{section.label}</span></div>
            {section.items.map((item) => {
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
          </section>
        ))}
      </nav>
    </aside>
  );
}
