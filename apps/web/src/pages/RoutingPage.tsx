// E3：模型与服务路由策略控制台。管理多版本权重、A/B 灰度、影子流量和实时分布。
import { useState } from "react";
import { Activity, GitBranch, Layers3, Plus, Radio, RefreshCw } from "lucide-react";

import { PageHeader } from "../components/common/PlatformPrimitives";
import { RoutingPolicyList } from "../components/routing/RoutingPolicyList";
import { PolicyDrawer } from "../components/routing/PolicyDrawer";
import { useRouting } from "../lib/useRouting";
import type { RoutingPolicy } from "../types/routing";

export function RoutingPage() {
  const routing = useRouting();
  const [drawer, setDrawer] = useState<{ open: boolean; editing: RoutingPolicy | null }>({ open: false, editing: null });
  const policies = routing.list.data?.policies ?? [];
  const shadowEnabled = routing.list.data?.shadow_enabled ?? false;
  const enabledPolicies = policies.filter((policy) => policy.enabled).length;
  const variantCount = policies.reduce((count, policy) => count + policy.variants.length, 0);
  const shadowPolicies = policies.filter((policy) => Boolean(policy.shadow)).length;
  const liveSamples = policies.reduce((count, policy) => count + (policy.live ?? []).reduce((sum, item) => sum + item.count, 0), 0);

  return (
    <section className="infra-page routing-page">
      <PageHeader
        title="流量策略"
        subtitle="统一管理模型与服务的路由策略，配置多版本权重、A/B、灰度和影子流量，并对照配置权重与最近 1 小时实际分布"
        actions={
          <div className="storage-actions">
            <button className="console-refresh" type="button" onClick={() => routing.list.refetch()}>
              <RefreshCw className={routing.list.isFetching ? "spinning" : undefined} size={14} /> 刷新
            </button>
            <button className="console-refresh primary" type="button" onClick={() => setDrawer({ open: true, editing: null })}>
              <Plus size={14} /> 新建路由策略
            </button>
          </div>
        }
      />

      <section className="routing-overview-grid" aria-label="路由策略概况">
        <article><GitBranch size={18} /><span><small>路由策略</small><strong>{policies.length}</strong><em>{enabledPolicies} 条已启用</em></span></article>
        <article><Layers3 size={18} /><span><small>候选版本 / 实例</small><strong>{variantCount}</strong><em>参与权重分流</em></span></article>
        <article><Activity size={18} /><span><small>近 1 小时请求样本</small><strong>{liveSamples}</strong><em>用于计算实时占比</em></span></article>
        <article><Radio size={18} /><span><small>影子流量策略</small><strong>{shadowPolicies}</strong><em>平台开关：{shadowEnabled ? "已开启" : "已关闭"}</em></span></article>
      </section>

      {!shadowEnabled ? (
        <p className="routing-banner">
          影子流量全局开关 <code>ROUTING_SHADOW_ENABLED=false</code>。当前可以保存影子目标，但不会复制真实请求；
          开启后才会镜像同一请求、丢弃影子响应并单独采集延迟和错误率。A/B、灰度、全量与回滚不受影响。
        </p>
      ) : null}

      <section className="infra-panel routing-policy-panel">
        <header className="routing-policy-toolbar">
          <div><strong>模型与服务路由策略</strong><small>每条策略可绑定多个服务实例或模型版本，并持续对比目标权重与真实请求占比</small></div>
          <div className="routing-weight-legend" aria-label="流量分布图例"><span><i className="cfg" />配置权重</span><span><i className="live" />实时流量</span></div>
        </header>
        <RoutingPolicyList routing={routing} onEdit={(p) => setDrawer({ open: true, editing: p })} />
      </section>

      {drawer.open && <PolicyDrawer routing={routing} editing={drawer.editing} onClose={() => setDrawer({ open: false, editing: null })} />}
    </section>
  );
}
