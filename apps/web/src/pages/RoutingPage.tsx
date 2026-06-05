// E3：模型路由页（薄组合）。多版本加权（A/B 灰度）+ 影子流量对比，闭合「注册→灰度→评测→全量/回滚」。
import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { ClosedLoopRibbon, PageHeader } from "../components/common/PlatformPrimitives";
import { RoutingPolicyList } from "../components/routing/RoutingPolicyList";
import { PolicyDrawer } from "../components/routing/PolicyDrawer";
import { useRouting } from "../lib/useRouting";
import { useGoToPage } from "../lib/useGoToPage";
import type { RoutingPolicy } from "../types/routing";

export function RoutingPage() {
  const routing = useRouting();
  const goTo = useGoToPage();
  const [drawer, setDrawer] = useState<{ open: boolean; editing: RoutingPolicy | null }>({ open: false, editing: null });
  const shadowEnabled = routing.list.data?.shadow_enabled ?? false;

  return (
    <section className="infra-page routing-page">
      <PageHeader
        title="模型路由 / A-B / 影子流量"
        subtitle="借多版本加权灰度 + 影子对照，闭合「注册 → 灰度发布 → 评测 → 全量 / 回滚」"
        actions={
          <div className="storage-actions">
            <button className="console-refresh" type="button" onClick={() => routing.list.refetch()}>
              <RefreshCw className={routing.list.isFetching ? "spinning" : undefined} size={14} /> 刷新
            </button>
            <button className="console-refresh primary" type="button" onClick={() => setDrawer({ open: true, editing: null })}>
              <Plus size={14} /> 新建策略
            </button>
          </div>
        }
      />

      <ClosedLoopRibbon
        stages={[
          { id: "register", label: "注册版本", detail: "C1 模型注册中心", state: "done" },
          { id: "canary", label: "灰度发布", detail: "加权 A/B 路由", state: "active" },
          { id: "shadow", label: "影子评测", detail: shadowEnabled ? "镜像对照已开启" : "镜像默认关（可开）", state: shadowEnabled ? "active" : "pending" },
          { id: "promote", label: "全量 / 回滚", detail: "一键切换 + 快照回滚", state: "pending" }
        ]}
        rightAction={{ label: "去模型注册 →", onClick: () => goTo("models") }}
      />

      {!shadowEnabled ? (
        <p className="routing-banner">
          影子流量平台开关 <code>ROUTING_SHADOW_ENABLED=false</code>（默认关，避免对 serving 栈加倍负载）。
          加权 A/B 路由、全量/回滚不受影响；开启后配置了影子目标的策略才会真正镜像请求。
        </p>
      ) : null}

      <section className="infra-panel">
        <RoutingPolicyList routing={routing} onEdit={(p) => setDrawer({ open: true, editing: p })} />
      </section>

      {drawer.open && <PolicyDrawer routing={routing} editing={drawer.editing} onClose={() => setDrawer({ open: false, editing: null })} />}
    </section>
  );
}
