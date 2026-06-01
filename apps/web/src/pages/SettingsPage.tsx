import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, RotateCcw, Save } from "lucide-react";

import { PageHeader, PanelHeader, TabStrip } from "../components/common/PlatformPrimitives";
import { settingsSnapshot } from "../data/platformSnapshots";
import { api } from "../lib/api";

type SettingGroup = {
  id: string;
  title: string;
  items: Array<{ label: string; value: string; detail: string }>;
};

function cloneGroups(): SettingGroup[] {
  return settingsSnapshot.groups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item }))
  }));
}

export function SettingsPage() {
  const snap = settingsSnapshot;
  const [tab, setTab] = useState(0);
  const [editing, setEditing] = useState(false);
  const [groups, setGroups] = useState<SettingGroup[]>(cloneGroups);
  const [savedAt, setSavedAt] = useState("未保存");

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Record<string, unknown>>("/api/health"),
    enabled: false
  });

  const visibleGroups = useMemo(() => {
    const label = snap.tabs[tab];
    if (label === "平台配置") return groups;
    if (label === "安全设置" || label === "权限") return groups.filter((group) => group.id === "network" || group.id === "system");
    if (label === "集群接入") return groups.filter((group) => group.id === "network" || group.id === "storage");
    if (label === "AI 服务") return groups.filter((group) => group.id === "system" || group.id === "storage");
    return groups;
  }, [groups, snap.tabs, tab]);

  async function testConnection() {
    try {
      const result = await healthQuery.refetch();
      if (result.error) throw result.error;
      toast.success("Go 控制面连接正常", { description: JSON.stringify(result.data ?? {}).slice(0, 80) });
    } catch (error) {
      toast.error("Go 控制面连接失败", { description: error instanceof Error ? error.message : "请求失败" });
    }
  }

  function updateItem(groupId: string, label: string, value: string) {
    setGroups((current) => current.map((group) => group.id !== groupId
      ? group
      : {
        ...group,
        items: group.items.map((item) => item.label === label ? { ...item, value } : item)
      }));
  }

  function save() {
    setEditing(false);
    setSavedAt("刚刚");
    toast.success("设置已保存到当前前端会话", { description: "Go 后端暂未提供平台设置写接口" });
  }

  function reset() {
    setGroups(cloneGroups());
    setSavedAt("已重置");
    toast.info("设置已恢复为默认样例值");
  }

  return (
    <section className="infra-page settings-replica">
      <PageHeader
        title="平台设置"
        subtitle="环境配置、访问控制、集成状态与平台连接"
        actions={
          <>
            <button className="console-refresh" onClick={testConnection} type="button">
              <RefreshCw className={healthQuery.isFetching ? "spinning" : undefined} size={14} /> 测试连接
            </button>
            <button className="console-refresh" onClick={reset} type="button">
              <RotateCcw size={14} /> 重置
            </button>
            <button className="console-refresh primary" onClick={() => editing ? save() : setEditing(true)} type="button">
              <Save size={14} /> {editing ? "保存设置" : "编辑设置"}
            </button>
          </>
        }
      />

      <TabStrip items={snap.tabs.map((t, i) => ({ key: String(i), label: t }))} active={String(tab)} onChange={(k) => setTab(Number(k))} />

      <div className="settings-save-state">
        <span>编辑状态：{editing ? "正在编辑" : "只读预览"}</span>
        <span>保存状态：{savedAt}</span>
        <span>后端：{healthQuery.data ? "已连接" : healthQuery.error ? "连接失败" : "未测试"}</span>
      </div>

      <div className="settings-groups">
        {visibleGroups.map((group) => (
          <section className="infra-panel" key={group.id}>
            <PanelHeader title={group.title} action={editing ? "可编辑" : "工作区范围"} />
            <div className="kv-card-grid">
              {group.items.map((item) => (
                <div className="kv-card settings-edit-card" key={item.label}>
                  <div className="kv-label">{item.label}</div>
                  {editing ? (
                    <input value={item.value} onChange={(event) => updateItem(group.id, item.label, event.target.value)} />
                  ) : (
                    <div className="kv-value">{item.value}</div>
                  )}
                  <div className="kv-detail">{item.detail}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <section className="infra-panel">
        <PanelHeader title="访问控制" action="RBAC · 可切换策略" />
        <div className="kv-card-grid kv-card-grid-4">
          {snap.access.map((a) => (
            <div className="kv-card" key={a.title}>
              <div className="kv-label">{a.title}</div>
              <div className="kv-value accent">{a.value}</div>
              <div className="kv-detail">{a.detail}</div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
