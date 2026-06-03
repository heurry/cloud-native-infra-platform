export type Page =
  | "dashboard"
  | "services"
  | "kubernetes"
  | "observability"
  | "aiOps"
  | "knowledge"
  | "benchmarks"
  | "config"
  | "pipelines"
  | "models"
  | "settings";

export const pages: Page[] = [
  "dashboard",
  "services",
  "kubernetes",
  "observability",
  "aiOps",
  "knowledge",
  "benchmarks",
  "config",
  "pipelines",
  "models",
  "settings"
];

export const pageLabels: Record<Page, string> = {
  dashboard: "平台总览",
  services: "模型服务",
  kubernetes: "Kubernetes",
  config: "配置中心",
  pipelines: "发布流水线",
  observability: "可观测性",
  aiOps: "AI Ops",
  knowledge: "知识库 / RAG",
  benchmarks: "压测验证",
  models: "模型注册",
  settings: "平台设置"
};

// Page <-> URL path 映射（react-router）。
// 真实路由让深链、浏览器前进/后退、面包屑成为可能；UI 仍以 Page 为内部标识。
export const pagePaths: Record<Page, string> = {
  dashboard: "/dashboard",
  services: "/services",
  kubernetes: "/kubernetes",
  config: "/config",
  pipelines: "/pipelines",
  observability: "/observability",
  aiOps: "/ai-ops",
  knowledge: "/knowledge",
  benchmarks: "/benchmarks",
  models: "/models",
  settings: "/settings"
};

const pathToPageEntries = Object.entries(pagePaths) as Array<[Page, string]>;

/** 由 URL pathname 解析出 Page；兼容旧 ?page= 取值；无匹配回退 dashboard。 */
export function pageFromPath(pathname: string, legacyPageParam?: string | null): Page {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const matched = pathToPageEntries.find(([, path]) => path === normalized);
  if (matched) return matched[0];

  if (legacyPageParam) {
    if (pages.includes(legacyPageParam as Page)) return legacyPageParam as Page;
    const legacyMap: Record<string, Page> = {
      chat: "aiOps",
      knowledge: "knowledge",
      benchmarks: "benchmarks",
      metrics: "observability",
      evaluations: "models"
    };
    if (legacyMap[legacyPageParam]) return legacyMap[legacyPageParam];
  }
  return "dashboard";
}
