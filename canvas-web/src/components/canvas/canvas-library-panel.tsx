import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Pagination, Select, Spin } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Boxes, Images, Maximize2, Minimize2, Search, SlidersHorizontal, X } from "lucide-react";
import { AssetMediaPreview } from "@/components/asset-media-preview";
import { listLibrary, listLibraryCategories, useLibraryItem, type LibraryPayload, type LibraryItem } from "@/services/api/library";
import { resourceThumbnailUrl } from "@/services/api/resources";
import { personalAssetPayload, libraryAssetPayload } from "@/lib/canvas/library-insertion";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { InsertAssetPayload } from "@/types/asset-insertion";
import { getTeam } from "@/services/api/teams";
import { LibraryEditor } from "@/components/library/library-editor";
import { createLibraryTemplate } from "@/lib/canvas/library-template";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import "./canvas-library-panel.css";

type Props = { teamId?: string; templateSource?: { title: string; nodes: CanvasNodeData[]; connections: CanvasConnection[] }; onInsert: (asset: InsertAssetPayload) => void | Promise<unknown>; onTemplate: (payload: LibraryPayload) => void; onClose: () => void };
const tabs = [{ id: "template", title: "模板库" }, { id: "media", title: "素材库" }, { id: "character", title: "虚拟人像库" }, { id: "audio", title: "音频库" }];
export function CanvasLibraryPanel({ teamId, templateSource, onInsert, onTemplate, onClose }: Props) {
    const { message } = App.useApp(); const userId = useUserStore((s) => s.user?.id); const assets = useAssetStore((s) => s.assets);
    const [tab, setTab] = useState("template"); const [scope, setScope] = useState("public"); const [keyword, setKeyword] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1); const [expanded, setExpanded] = useState(false); const [kind, setKind] = useState(""); const [busy, setBusy] = useState("");
    const panel = useRef<HTMLElement>(null); const pageSize = expanded ? 24 : 9;
    const cache = useQueryClient();
    const [templateDraft, setTemplateDraft] = useState<LibraryPayload | null>(null);
    const team = useQuery({ queryKey: ["team", userId, teamId], queryFn: () => getTeam(teamId!), enabled: !!teamId });
    const canSaveTemplate = !!templateSource && ["owner", "admin"].includes(team.data?.membership?.role || "");
    const [category, setCategory] = useState("");
    const [filtersOpen, setFiltersOpen] = useState(false);
    useEffect(() => { setCategory(""); setPage(1); }, [scope, teamId]);
    const categories = useQuery({ queryKey: ["library-categories", userId, scope, teamId, tab], queryFn: () => listLibraryCategories(scope === "team" ? teamId : undefined, tab), enabled: scope !== "mine" });
    useEffect(() => { const timer = window.setTimeout(() => { setSearch(keyword); setPage(1); }, 250); return () => window.clearTimeout(timer); }, [keyword]);
    useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => previous?.focus(); }, []);
    const query = useQuery({ queryKey: ["canvas-library", userId, tab, scope, teamId, kind, category, search, page, pageSize], queryFn: () => listLibrary({ kind: tab === "media" ? kind || "media" : tab, teamId: scope === "team" ? teamId : undefined, recent: scope === "recent", keyword: search, category, page, limit: pageSize }), enabled: scope !== "mine" });
    const own = assets.filter((a) => personalAssetPayload(a) && (tab !== "audio" || a.kind === "audio") && (!kind || a.kind === kind) && (!search || `${a.title} ${a.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase())));
    const selectTab = (value: string) => { setTab(value); setPage(1); setCategory(""); setKind(""); setScope("public"); setKeyword(""); setSearch(""); };
    const insert = async (item: LibraryItem) => {
        setBusy(item.id);
        try { const full = await useLibraryItem(item.id); const payload = JSON.parse(full.payloadJson) as LibraryPayload; if (payload.nodes?.length) onTemplate(payload); else if (payload.asset) await onInsert(libraryAssetPayload(payload.asset)); else throw new Error("此素材内容为空"); message.success("已添加到画布"); }
        catch (e) { message.error((e as Error).message); } finally { setBusy(""); }
    };
    return <section ref={panel} tabIndex={-1} role="dialog" aria-modal="false" aria-label="画布素材库" className={`canvas-library-panel${expanded ? " is-expanded" : ""}`} data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
        <header className="canvas-library-header">
            <div className="canvas-library-navigation">
                <nav aria-label="素材类型">{tabs.map(({ id, title }) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => selectTab(id)}>{title}</button>)}</nav>
                <nav className="canvas-library-scopes" aria-label="素材范围">{[...(["media", "audio"].includes(tab) ? [{ id: "mine", name: "我的" }] : []), { id: "recent", name: "最近" }, ...(teamId ? [{ id: "team", name: "团队" }] : [])].map((s) => <button type="button" key={s.id} aria-pressed={scope === s.id} title={scope === s.id ? "再次点击返回公共库" : s.name} onClick={() => { setScope(scope === s.id ? "public" : s.id); setPage(1); }}>{s.name}</button>)}</nav>
            </div>
            <div className="canvas-library-window-actions"><Button type="text" aria-label={expanded ? "收起素材面板" : "展开素材面板"} icon={expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />} onClick={() => { setExpanded(!expanded); setPage(1); }} /><Button type="text" aria-label="关闭素材库" icon={<X size={18} />} onClick={onClose} /></div>
        </header>
        <div className="canvas-library-panel-search">
            <Input aria-label="搜索素材" placeholder={tab === "template" ? "搜索模板…" : tab === "character" ? "搜索虚拟人像…" : tab === "audio" ? "搜索音频名称或标签…" : "搜索素材名称或标签…"} prefix={<Search size={18} />} value={keyword} allowClear onChange={(e) => setKeyword(e.target.value)} />
            <Button type="text" className="canvas-library-filter-toggle" aria-label="筛选素材" aria-expanded={filtersOpen} aria-pressed={!!category || !!kind} icon={<SlidersHorizontal size={17} />} onClick={() => setFiltersOpen(!filtersOpen)} />
        </div>
        {filtersOpen && <div className="canvas-library-panel-filters">
            {scope !== "mine" && <Select className="canvas-library-category" aria-label="素材分类" value={category} onChange={(value) => { setCategory(value); setPage(1); }} loading={categories.isLoading} options={[{ value: "", label: "全部分类" }, ...(categories.data || []).map((value) => ({ value, label: value }))]} />}
            {tab === "media" && <Select aria-label="筛选素材类型" value={kind} onChange={(v) => { setKind(v); setPage(1); }} options={[{ value: "", label: "全部类型" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }, { value: "text", label: "文本" }]} />}
        </div>}
        <div className="canvas-library-scroll">
            {canSaveTemplate && tab === "template" && scope === "team" && <Button className="mb-3" onClick={() => { try { setTemplateDraft(createLibraryTemplate(templateSource!.nodes, templateSource!.connections)); } catch (e) { message.error((e as Error).message); } }}>将当前画布存为团队模板</Button>}
            {categories.error && scope !== "mine" && <p role="alert" className="text-sm">分类加载失败，仍可搜索素材。</p>}
            {scope !== "mine" && query.isLoading ? <div className="canvas-library-state"><Spin /></div> : scope !== "mine" && query.error ? <div className="canvas-library-state" role="alert"><p>{query.error.message}</p><Button onClick={() => void query.refetch()}>重新加载</Button></div> : <div className="canvas-library-panel-grid">
                {scope === "mine" ? own.slice((page - 1) * pageSize, page * pageSize).map((a) => <button type="button" key={a.id} className="canvas-library-card" onClick={async () => { const payload = personalAssetPayload(a); if (!payload) return; try { await onInsert(payload); message.success("已添加到画布"); } catch (e) { message.error((e as Error).message); } }}>
                    <div className="canvas-library-cover-wrap">
                        <AssetMediaPreview asset={a} alt={a.title} className="canvas-library-cover" fallback={<div className="canvas-library-cover canvas-library-placeholder"><Images size={28} /></div>} />
                        <span className="canvas-library-insert"><span>应用</span></span>
                    </div>
                    <span>{a.title}</span>
                </button>) : query.data?.items.map((item) => <button type="button" key={item.id} disabled={!!busy} aria-busy={busy === item.id} aria-label={`应用 ${item.name}`} className="canvas-library-card" onClick={() => void insert(item)}>
                    <div className="canvas-library-cover-wrap">
                        {item.coverResourceId ? <img loading="lazy" className="canvas-library-cover" alt={item.name} src={resourceThumbnailUrl(item.coverResourceId)} /> : item.kind === "audio" ? <div className="canvas-library-cover canvas-library-audio-cover"><AudioLines size={48} strokeWidth={1.5} aria-hidden="true" /><span>音频素材</span></div> : <div className="canvas-library-cover canvas-library-placeholder"><Boxes size={28} /></div>}
                        <span className="canvas-library-insert"><span>{busy === item.id ? <><Spin size="small" />应用中</> : "应用"}</span></span>
                    </div>
                    <span>{item.name}</span>
                </button>)}
            </div>}
            {(scope === "mine" ? own.length === 0 : !query.isLoading && !query.error && query.data?.total === 0) && <div className="canvas-library-state"><Boxes size={28} /><p>{search ? "没有匹配的素材" : scope === "recent" ? "使用过的公共素材会显示在这里" : "暂无素材"}</p></div>}
        </div>
        <footer><span>{scope === "mine" ? own.length : query.data?.total || 0} 项素材</span><Pagination simple size="small" current={page} pageSize={pageSize} total={scope === "mine" ? own.length : query.data?.total || 0} showSizeChanger={false} hideOnSinglePage onChange={setPage} /></footer>
        {templateDraft && <LibraryEditor item={null} teamId={teamId} initial={{ kind: "template", name: templateSource?.title || "团队模板", payload: templateDraft, published: true }} onClose={() => setTemplateDraft(null)} onSaved={() => { setTemplateDraft(null); void cache.invalidateQueries({ queryKey: ["canvas-library"] }); void cache.invalidateQueries({ queryKey: ["library-management"] }); void cache.invalidateQueries({ queryKey: ["library-categories"] }); }} />}
    </section>;
}
