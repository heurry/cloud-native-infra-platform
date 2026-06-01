import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { StatusBadge } from "../common/PlatformPrimitives";
import { settingsSnapshot } from "../../data/platformSnapshots";
import { api } from "../../lib/api";
import type { Metrics } from "../../types/platform";

// 设置页专用右栏（13-前端复刻改造计划 决策 C）：不是通用 Copilot，而是平台状态栏。
// Go 控制面 API 走真实 /api/health 探测；其余连接态用 snapshot 展示。
export function SettingsStatusPanel() {
  const healthQuery = useQuery({
    queryKey: ["health", "settings-status"],
    queryFn: () => api<{ status?: string }>("/api/health"),
    refetchInterval: 15000,
    retry: false,
  });
  const metricsQuery = useQuery({
    queryKey: ["metrics", "settings-status"],
    queryFn: () => api<Metrics>("/api/metrics/current"),
    refetchInterval: 15000,
    retry: false,
  });
  const aiQuery = useQuery({
    queryKey: ["ai", "settings-status"],
    queryFn: () => api<{ diagnoses?: unknown[] }>("/api/ai/diagnoses?limit=1"),
    refetchInterval: 15000,
    retry: false,
  });
  const legacyQuery = useQuery({
    queryKey: ["legacy", "settings-status"],
    queryFn: () => api<{ documents?: unknown[] }>("/api/knowledge/documents?limit=1"),
    refetchInterval: 15000,
    retry: false,
  });

  const goStatus = statusOf(healthQuery);
  const agentStatus = metricsQuery.isSuccess && metricsQuery.data?.host ? "healthy" : statusOf(metricsQuery);
  const aiStatus = statusOf(aiQuery);
  const legacyStatus = statusOf(legacyQuery);
  const statusMap: Record<string, string> = {
    go: goStatus,
    agent: agentStatus,
    ai: aiStatus,
    legacy: legacyStatus,
  };
  const services = settingsSnapshot.services.map((s) => ({ ...s, status: statusMap[s.id] ?? s.status }));

  return (
    <aside className="infra-copilot settings-status-panel">
      <div className="settings-status-head">
        <span><ShieldCheck size={15} /> 平台状态</span>
        <small>Prod / us-east-1</small>
      </div>

      <div className="settings-status-section">
        <div className="settings-status-title">服务连接</div>
        {services.map((s) => (
          <div className="status-row" key={s.id}>
            <div>
              <div className="status-name">{s.label}</div>
              <div className="status-ep">{s.endpoint}</div>
            </div>
            <StatusBadge status={s.status} />
          </div>
        ))}
      </div>
    </aside>
  );
}

function statusOf(query: { isSuccess: boolean; isError: boolean; isLoading: boolean }) {
  if (query.isSuccess) return "healthy";
  if (query.isError) return "unreachable";
  if (query.isLoading) return "checking";
  return "degraded";
}
