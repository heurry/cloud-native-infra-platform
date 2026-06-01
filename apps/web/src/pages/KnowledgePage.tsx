import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, RefreshCw } from "lucide-react";

import { Donut, KpiGrid, PageHeader, PanelHeader, Sparkline, StatusBadge } from "../components/common/PlatformPrimitives";
import { describeError } from "../components/common/FeedbackStates";
import { knowledgeSnapshot } from "../data/platformSnapshots";
import { api } from "../lib/api";
import { fmt } from "../lib/format";
import type { KpiItem } from "../types/ui";

type KnowledgeDocument = { doc_id: string | number; title?: string; category?: string; version?: string; chunks?: number; status?: string; updatedAt?: string; source_uri?: string };
type SearchResult = { doc_id: string | number; title?: string; score?: number };

const emptyForm = { doc_id: "", title: "", category: "", version: "default", source_uri: "", content: "" };

function deltaOf(series: number[]): { delta: string; deltaTone: "up" | "down" | "flat" } {
  if (series.length < 2) return { delta: "", deltaTone: "flat" };
  const change = ((series[series.length - 1] - series[0]) / (series[0] || 1)) * 100;
  return { delta: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`, deltaTone: change > 0 ? "up" : change < 0 ? "down" : "flat" };
}

export function KnowledgePage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const documentsQuery = useQuery({
    queryKey: ["knowledge", "documents"],
    queryFn: () => api<{ documents: KnowledgeDocument[] }>("/api/knowledge/documents?limit=50"),
    select: (payload) => payload.documents ?? [],
  });
  const documents = documentsQuery.data ?? [];

  const searchMutation = useMutation({
    mutationFn: (q: string) => api<{ documents: SearchResult[] }>(`/api/knowledge/search?q=${encodeURIComponent(q)}&top_k=5`),
    onSuccess: (payload) => setResults(payload.documents ?? []),
    onError: (error) => toast.error("检索失败", { description: describeError(error) }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: typeof emptyForm) => api("/api/knowledge/documents", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: async () => {
      toast.success("文档已保存");
      setShowForm(false);
      setForm(emptyForm);
      await queryClient.invalidateQueries({ queryKey: ["knowledge", "documents"] });
    },
    onError: (error) => toast.error("保存失败", { description: describeError(error) }),
  });

  const rebuildMutation = useMutation({
    mutationFn: () => api<{ document_count: number }>("/api/knowledge/rebuild-index", { method: "POST" }),
    onSuccess: (payload) => toast.success(`索引已重建（${payload?.document_count ?? 0} 个文档）`),
    onError: (error) => toast.error("重建索引失败", { description: describeError(error) }),
  });

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    searchMutation.mutate(query.trim());
  }
  function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!form.doc_id.trim() || !form.title.trim() || !form.content.trim()) {
      toast.warning("doc_id / 标题 / 内容 为必填");
      return;
    }
    createMutation.mutate(form);
  }

  // 真实优先；无后端/空库时用 snapshot 兜底展示。
  const tableDocs: KnowledgeDocument[] = documents.length > 0 ? documents : knowledgeSnapshot.documents;
  const kpis: KpiItem[] = knowledgeSnapshot.kpis.map((item) =>
    item.id === "docs" && documents.length > 0
      ? { ...item, value: String(documents.length), ...deltaOf(item.trend) }
      : { ...item, ...deltaOf(item.trend) }
  );
  const idx = knowledgeSnapshot.index;

  return (
    <section className="infra-page knowledge-replica">
      <PageHeader
        title="知识库 / RAG"
        subtitle="文档管理、向量检索与证据溯源"
        actions={
          <>
            <button className="console-refresh" type="button" disabled={rebuildMutation.isPending} onClick={() => rebuildMutation.mutate()}>
              <RefreshCw size={14} /> {rebuildMutation.isPending ? "重建中…" : "重建索引"}
            </button>
            <button className="console-refresh primary" type="button" onClick={() => setShowForm((v) => !v)}>
              <FileText size={14} /> {showForm ? "收起" : "新建文档"}
            </button>
          </>
        }
      />

      <KpiGrid className="kpi-cols-6" items={kpis} />

      {showForm && (
        <section className="infra-panel">
          <PanelHeader title="新建 / 更新文档" action="doc_id 相同则覆盖" />
          <form className="knowledge-doc-form" onSubmit={submitForm}>
            <div className="knowledge-doc-form-grid">
              <label>doc_id*<input value={form.doc_id} onChange={(e) => setForm({ ...form, doc_id: e.target.value })} placeholder="如 doc-101" /></label>
              <label>标题*<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="文档标题" /></label>
              <label>分类<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="如 runbook" /></label>
              <label>版本<input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
              <label>来源 URI<input value={form.source_uri} onChange={(e) => setForm({ ...form, source_uri: e.target.value })} placeholder="docs/..." /></label>
            </div>
            <label className="knowledge-doc-form-content">内容*<textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={5} placeholder="文档正文" /></label>
            <div className="knowledge-doc-form-actions">
              <button className="ghost-button" type="button" onClick={() => { setForm(emptyForm); setShowForm(false); }}>取消</button>
              <button className="primary-button" type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? "保存中…" : "保存文档"}</button>
            </div>
          </form>
        </section>
      )}

      <section className="infra-panel">
        <PanelHeader title="文档列表" action={`${tableDocs.length} 个文档`} />
        <table className="infra-table knowledge-table">
          <thead><tr>{["标题", "分类", "版本", "Chunk", "状态", "更新时间", "来源"].map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {tableDocs.map((doc) => (
              <tr key={String(doc.doc_id)}>
                <td><strong>{doc.title ?? String(doc.doc_id)}</strong></td>
                <td>{doc.category ? <span className="kn-cat-tag">{doc.category}</span> : "-"}</td>
                <td>{doc.version ?? "-"}</td>
                <td>{doc.chunks ?? "-"}</td>
                <td>{doc.status ? <StatusBadge status={doc.status} /> : "-"}</td>
                <td>{doc.updatedAt ?? "实时"}</td>
                <td><span className="cell-subtle" style={{ marginTop: 0 }}>{doc.source_uri ?? "-"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="dashboard-grid">
        <section className="infra-panel col-span-2">
          <PanelHeader title="检索测试" action="lexical / 向量" />
          <form onSubmit={submitSearch} className="knowledge-search-form">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入查询，如：如何申请退款" />
            <button type="submit" disabled={searchMutation.isPending}>{searchMutation.isPending ? "检索中…" : "检索"}</button>
          </form>
          <div className="knowledge-results">
            {results.length > 0 ? (
              results.map((result) => (
                <div key={String(result.doc_id)} className="knowledge-result-row">
                  <strong>{result.title ?? String(result.doc_id)}</strong>
                  <span>{fmt(result.score ?? 0, 3)}</span>
                </div>
              ))
            ) : (
              <p className="knowledge-empty">输入查询并检索以查看匹配文档与得分</p>
            )}
          </div>
        </section>

        <section className="infra-panel">
          <PanelHeader title="索引健康" action="RAG" />
          <div className="index-health">
            <Donut value={idx.coverage} max={100} size={88} thickness={9} tone="success" label={`${idx.coverage}%`} />
            <div className="index-health-meta">
              <div><span>状态</span><StatusBadge status={idx.status} /></div>
              <div><span>嵌入模型</span><strong>{idx.embedModel}</strong></div>
              <div><span>向量维度</span><strong>{idx.dimensions}</strong></div>
              <div><span>最近重建</span><strong>{idx.lastBuilt}</strong></div>
            </div>
          </div>
        </section>
      </div>

      <section className="infra-panel">
        <PanelHeader title="知识分布" action="按分类" />
        <div className="kn-category-grid">
          {knowledgeSnapshot.categories.map((c) => (
            <div className="kn-category-row" key={c.id}>
              <div><strong>{c.label}</strong><small>{c.count} 篇</small></div>
              <Sparkline values={c.trend} tone={c.tone} width={120} height={32} />
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
