import { ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AICopilotPanel } from "./components/layout/AICopilotPanel";
import { AIOpsCopilotPanel } from "./components/layout/AIOpsCopilotPanel";
import { SettingsStatusPanel } from "./components/layout/SettingsStatusPanel";
import { AppSidebar } from "./components/layout/AppSidebar";
import { PlatformTopBar } from "./components/layout/PlatformTopBar";
import { cn } from "./lib/utils";
import { AIOpsPage } from "./pages/AIOpsPage";
import { BenchmarksPage } from "./pages/BenchmarksPage";
import { KubernetesPage } from "./pages/KubernetesPage";
import { ConfigCenterPage } from "./pages/ConfigCenterPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { CustomerSupportPage } from "./pages/CustomerSupportPage";
import { ObservabilityPage } from "./pages/ObservabilityPage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { ModelsPage } from "./pages/ModelsPage";
import { PlatformOverviewPage } from "./pages/PlatformOverviewPage";
import { ServicesPage } from "./pages/ServicesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { pageFromPath, pagePaths, type Page } from "./types/navigation";

export function App() {
  const location = useLocation();
  const navigate = useNavigate();

  // URL 是导航的唯一真实来源；Page 仅作 UI 内部标识。
  const page = pageFromPath(location.pathname, new URLSearchParams(location.search).get("page"));

  // 保留"已访问页常驻挂载"以维持各页（含 Copilot）的本地状态/聊天历史。
  const [visitedPages, setVisitedPages] = useState<Page[]>([page]);
  useEffect(() => {
    setVisitedPages((items) => (items.includes(page) ? items : [...items, page]));
  }, [page]);

  // 根路径或旧 ?page= 链接：规范化到真实路由路径。
  useEffect(() => {
    const normalized = pagePaths[page];
    if (location.pathname !== normalized) {
      navigate(normalized + location.hash, { replace: true });
    }
    // 仅在首次/路径与解析结果不一致时纠正，避免循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setPage(nextPage: Page) {
    navigate(pagePaths[nextPage]);
  }

  return (
    <div className="infra-platform-shell">
      <PlatformTopBar />
      <AppSidebar page={page} setPage={setPage} />
      <main className="infra-main">
        <PageCacheSlot active={page === "dashboard"} mounted={visitedPages.includes("dashboard")}>
          <PlatformOverviewPage setPage={setPage} />
        </PageCacheSlot>
        <PageCacheSlot active={page === "services"} mounted={visitedPages.includes("services")}>
          <ServicesPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "kubernetes"} mounted={visitedPages.includes("kubernetes")}>
          <KubernetesPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "config"} mounted={visitedPages.includes("config")}>
          <ConfigCenterPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "pipelines"} mounted={visitedPages.includes("pipelines")}>
          <PipelinesPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "observability"} mounted={visitedPages.includes("observability")}>
          <ObservabilityPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "aiOps"} mounted={visitedPages.includes("aiOps")}>
          <AIOpsPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "knowledge"} mounted={visitedPages.includes("knowledge")}>
          <KnowledgePage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "support"} mounted={visitedPages.includes("support")}>
          <CustomerSupportPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "benchmarks"} mounted={visitedPages.includes("benchmarks")}>
          <BenchmarksPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "models"} mounted={visitedPages.includes("models")}>
          <ModelsPage />
        </PageCacheSlot>
        <PageCacheSlot active={page === "settings"} mounted={visitedPages.includes("settings")}>
          <SettingsPage />
        </PageCacheSlot>
      </main>
      {/* Keep AI Ops Copilot mounted so chat history survives page changes; toggle via CSS. */}
      <AIOpsCopilotPanel hidden={page !== "aiOps"} setPage={setPage} />
      {page === "settings" && <SettingsStatusPanel />}
      {page !== "aiOps" && page !== "settings" && page !== "support" && <AICopilotPanel page={page} setPage={setPage} />}
    </div>
  );
}

function PageCacheSlot({ active, children, mounted }: { active: boolean; children: ReactNode; mounted: boolean }) {
  if (!mounted) return null;
  return (
    <div aria-hidden={!active} className={cn("page-cache-slot", !active && "inactive")}>
      {children}
    </div>
  );
}
