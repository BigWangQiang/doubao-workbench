import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Select, Tag } from "antd";
import { ArrowRight, BookOpen, Check, ChevronDown, Clapperboard, Copy, Download, FileText, History, LoaderCircle, Minus, Pencil, Plus, Save, Sparkles, Upload, Users } from "lucide-react";
import { nanoid } from "nanoid";
import { ModelPicker } from "@/components/model-picker";
import { GenerationCostIndicator } from "@/components/generation-cost-indicator";
import { WorkspaceSignalIcon } from "@/components/ui/aceternity/workspace-signal-icon";
import { ScreenplayEpisodeEditor, ScreenplaySettings } from "./canvas-screenplay-editor";
import { emptyEpisode, SCREENPLAY_SOURCE_LIMIT, screenplayBusy, screenplayText, validateScreenplay } from "@/lib/canvas/canvas-screenplay";
import { requestCreditEstimate } from "@/constant/credits";
import { localizeErrorMessage } from "@/lib/generation-error";
import { modelOptionName, resolveModelChannel, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ScreenplayDocument, ScreenplayGenerationRequest, ScreenplayWorkflow } from "@/types/canvas-screenplay";
import "./canvas-screenplay.css";

type Props = {
    node: CanvasNodeData; nodes: CanvasNodeData[]; open: boolean; onMinimize: () => void;
    onSave: (doc: ScreenplayDocument, revision: number, label?: string) => ScreenplayWorkflow;
    onGenerate: (request: ScreenplayGenerationRequest) => Promise<unknown>;
    onApprove: (revision: number) => void; onExtract: () => unknown; onRecover: () => Promise<unknown>; onCancelTask: () => Promise<unknown>;
    onResolveResult: (copy: boolean, resetUnconfirmed?: boolean) => void; onOpenStoryboard: (id: string) => void;
};
const actionLabels = { outline: "生成故事大纲", write_novel: "生成本集完整小说", rewrite_novel: "改写本集小说正文", adapt_episode: "小说改编为分场剧本", write_episode: "生成本集分场剧本", rewrite_scene: "改写选中场次", continue_episode: "续写分场剧本", storyboard: "拆成分镜表" };
const activeActionLabels = { outline: "AI 正在规划故事大纲", write_novel: "AI 正在撰写完整小说正文", rewrite_novel: "AI 正在改写小说正文", adapt_episode: "AI 正在将小说改编为分场剧本", write_episode: "AI 正在撰写分场剧本", rewrite_scene: "AI 正在改写场次", continue_episode: "AI 正在续写分场剧本", storyboard: "AI 正在拆分镜头" };
const taskStatusLabels = { submitting: "提交中", unknown: "待确认", running: "创作中", succeeded: "已完成", failed: "失败", cancelled: "已取消", conflict: "结果待处理", invalid: "结果格式异常" };
export function CanvasScreenplayWorkspace({ node, nodes, open, onMinimize, onSave, onGenerate, onApprove, onExtract, onRecover, onCancelTask, onResolveResult, onOpenStoryboard }: Props) {
    const { message, modal } = App.useApp(), config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const workflow = node.metadata!.screenplay!, doc = workflow.document;
    const [draft, setDraft] = useState(doc), [dirty, setDirty] = useState(false);
    const [tab, setTab] = useState<"settings" | "episode" | "history">("settings");
    const [episodeView, setEpisodeView] = useState<"novel" | "scenes">("novel");
    const [inspectorTab, setInspectorTab] = useState<"ai" | "assets" | "production">("ai");
    const [episodeId, setEpisodeId] = useState<string>(), [sceneId, setSceneId] = useState<string>();
    const [instruction, setInstruction] = useState(""), [submitting, setSubmitting] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const busy = screenplayBusy(workflow) || submitting;
    const activeEpisodeNumber = doc.episodes.findIndex((episode) => episode.id === workflow.task?.episodeId) + 1;
    const activeTaskLabel = workflow.task?.status === "unknown" ? "正在确认任务状态" : workflow.task?.status === "submitting" || submitting ? "正在提交创作任务" : workflow.task ? activeActionLabels[workflow.task.action] : "AI 正在创作";
    const selectedEpisode = draft.episodes.find((episode) => episode.id === episodeId) || draft.episodes[0];
    const selectedScene = selectedEpisode?.scenes.find((scene) => scene.id === sceneId) || selectedEpisode?.scenes[0];
    const model = config.textModel;
    const channel = resolveModelChannel(config, model);
    const estimate = requestCreditEstimate({ channelMode: channel.scope === "system" ? "remote" : "local", modelCosts: channel.modelCosts, model: modelOptionName(model) });
    const storyboards = nodes.filter((item) => item.metadata?.screenplaySource?.nodeId === node.id && item.type === CanvasNodeType.Script);
    const approved = workflow.approvedRevision === doc.revision && !dirty;
    const sceneCount = draft.episodes.reduce((count, episode) => count + episode.scenes.length, 0);
    const canOutline = !draft.episodes.some((episode) => episode.scenes.length > 0 || episode.novelText?.trim());
    const episodeNumber = Math.max(1, draft.episodes.findIndex((episode) => episode.id === selectedEpisode?.id) + 1);
    useEffect(() => { if (!dirty) setDraft(doc); }, [doc, dirty]);
    const edit = (next: ScreenplayDocument) => { setDraft(next); setDirty(true); };
    const saveDraft = () => {
        if (!dirty) return doc;
        const saved = onSave(draft, draft.revision); setDraft(saved.document); setDirty(false); return saved.document;
    };
    const attempt = async (action: () => unknown | Promise<unknown>) => { try { return await action(); } catch (error) { message.error(localizeErrorMessage(error, "操作失败")); } };
    const confirmScenesSync = () => void attempt(() => {
        if (!selectedEpisode) throw new Error("请选择目标分集");
        const saved = saveDraft();
        const next = onSave({ ...saved, episodes: saved.episodes.map((episode) => episode.id === selectedEpisode.id ? { ...episode, scenesNeedAdaptation: false } : episode) }, saved.revision, "分场校对同步");
        setDraft(next.document); setDirty(false); message.success("已保存并标记分场同步");
    });
    const run = (request: ScreenplayGenerationRequest) => {
        const replacesScenes = request.action === "adapt_episode" && Boolean(draft.episodes.find((episode) => episode.id === request.episodeId)?.scenes.length);
        modal.confirm({ title: actionLabels[request.action], content: <div className="screenplay-confirm"><p>提交 1 次文本推理，按当前模型和后台价格计费。</p><GenerationCostIndicator estimate={estimate} /><p>{request.action === "storyboard" ? "只创建分镜表，图片和视频需要另行生成。" : replacesScenes ? "将按当前小说重新生成并替换本集分场剧本；原场次保留在历史版本，小说正文及既有分镜不会被覆盖。" : request.action === "rewrite_novel" ? "将替换本集小说正文，旧正文保留在历史版本；已有场次保留并提示待同步。" : "结果只写入本次指定范围。"}</p></div>, okText: replacesScenes ? "确认替换并改编" : "确认生成", cancelText: "取消", onOk: async () => {
            setSubmitting(true);
            try { saveDraft(); await onGenerate({ ...request, instruction, model, replaceExistingScenes: replacesScenes }); if (request.action === "write_novel" || request.action === "rewrite_novel") setEpisodeView("novel"); if (request.action === "adapt_episode") setEpisodeView("scenes"); message.success("已提交，可最小化继续创作"); }
            catch (error) { message.error(localizeErrorMessage(error, "生成失败")); throw error; }
            finally { setSubmitting(false); }
        } });
    };
    const exportText = () => {
        const blob = new Blob([screenplayText(draft)], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = `${draft.title.replace(/[\\/:*?"<>|]/g, "_") || "剧本"}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const exportDocument = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "screenplay.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const exportNovel = () => {
        if (!selectedEpisode?.novelText?.trim()) { message.warning("当前集还没有小说正文"); return; }
        const url = URL.createObjectURL(new Blob([selectedEpisode.novelText], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${selectedEpisode.title.replace(/[\\/:*?"<>|]/g, "_") || "本集"}·小说正文.txt`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return <Modal open={open} onCancel={onMinimize} closable={false} mask={{ closable: false }} footer={null} centered width="min(1480px, 96vw)" className="canvas-screenplay-workspace" styles={{ container: { padding: 0, overflow: "hidden", borderRadius: "var(--r-2xl)" }, body: { padding: 0 } }}>
        <div className="screenplay-workspace" data-canvas-no-zoom data-canvas-wheel-scroll>
            <header className="screenplay-header">
                <WorkspaceSignalIcon variant="canvas" size="sm" />
                <div className="screenplay-title"><label><Input aria-label="剧本名称" value={draft.title} maxLength={200} onChange={(event) => edit({ ...draft, title: event.target.value })} /><Pencil aria-hidden="true" /></label><span>剧本工作区 <span className="screenplay-title-divider">/</span> v{doc.revision}</span></div>
                <span className="screenplay-save-status" data-state={dirty ? "dirty" : approved ? "approved" : "saved"}>{dirty ? <Pencil aria-hidden="true" /> : <Check aria-hidden="true" />}{dirty ? "待保存" : approved ? "已确认" : "已保存"}</span>
                <div className="screenplay-actions screenplay-header-actions">
                    <Button type="text" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()}>导入文本</Button>
                    <Dropdown trigger={["click"]} menu={{ items: [{ key: "novel", label: "导出本集小说正文", icon: <BookOpen className="size-4" />, disabled: !selectedEpisode?.novelText?.trim(), onClick: exportNovel }, { key: "markdown", label: "导出完整 Markdown", icon: <FileText className="size-4" />, onClick: exportText }, { key: "json", label: "导出可编辑 JSON", icon: <Download className="size-4" />, onClick: exportDocument }] }}><Button type="text" icon={<Download className="size-4" />}>导出<ChevronDown className="size-3.5" /></Button></Dropdown>
                    <Button className="screenplay-secondary-action" icon={<Clapperboard className="size-4" />} onClick={() => setInspectorTab("production")}>进入制作</Button>
                    <Button disabled={!dirty} icon={<Save className="size-4" />} onClick={() => void attempt(() => { saveDraft(); message.success("剧本已保存到画布"); })}>保存</Button>
                    <Button type="text" icon={<Minus className="size-4" />} onClick={onMinimize}>最小化</Button>
                </div>
            </header>
            {dirty && draft.revision !== doc.revision ? <Alert type="warning" showIcon title="剧本已有新版本，当前草稿不会覆盖它" action={<Button onClick={() => { setDraft(doc); setDirty(false); }}>载入最新版本</Button>} /> : null}
            {workflow.task ? <details className="screenplay-task" data-busy={busy || undefined} open={busy || Boolean(workflow.task.error) || undefined} onToggle={(event) => { if (busy && !event.currentTarget.open) event.currentTarget.open = true; }}>
                <summary className="screenplay-task-heading" onClick={(event) => { if (busy) event.preventDefault(); }}>
                    <span>{busy ? <LoaderCircle className="screenplay-busy-icon" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{actionLabels[workflow.task.action]}<span className="screenplay-task-status" role="status">{busy ? activeTaskLabel : taskStatusLabels[workflow.task.status]}</span>{busy && activeEpisodeNumber > 0 ? <span>第 {activeEpisodeNumber} 集</span> : null}</span>
                    {busy ? <span className="screenplay-task-hint">可最小化继续创作</span> : <ChevronDown aria-hidden="true" />}
                </summary>
                <div className="screenplay-task-body">
                    {busy ? <div className="screenplay-task-progress" role="progressbar" aria-label={activeTaskLabel}><span /></div> : null}
                    <div className="screenplay-actions">
                        {busy ? <><Button size="small" onClick={() => void attempt(onRecover)}>恢复状态</Button><Button size="small" disabled={!workflow.task.taskId} onClick={() => void attempt(onCancelTask)}>取消任务</Button></> : null}
                        {workflow.task.resultText ? <><Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void attempt(() => navigator.clipboard.writeText(workflow.task!.resultText!))}>复制原始结果</Button>{workflow.task.action !== "storyboard" ? <Button size="small" onClick={() => void attempt(() => onResolveResult(true))}>结果另存为剧本</Button> : null}</> : null}
                        {!busy ? <Button size="small" onClick={() => workflow.task?.resultText ? modal.confirm({ title: "放弃保留的生成结果？", content: "当前剧本和任务中心的原记录保留。", okText: "放弃结果", cancelText: "取消", onOk: () => onResolveResult(false) }) : onResolveResult(false)}>清除界面记录</Button> : null}
                    </div>
                    {workflow.task.error ? <Alert type={busy ? "warning" : "error"} title={localizeErrorMessage(workflow.task.error, "剧本任务处理失败，请稍后重试。")} showIcon /> : null}
                </div>
            </details> : null}
            {workflow.task?.status === "unknown" ? <Alert type="warning" title="提交结果未确认，请先恢复状态或检查任务中心" description="确认没有创建任务后可重置；重置不会取消服务器上可能存在的任务。" action={<Button onClick={() => modal.confirm({ title: "已在任务中心确认未提交？", content: "如果服务器已有任务，重置后再次生成可能重复计费。建议优先恢复状态。", okText: "已确认，重置记录", cancelText: "继续保留", onOk: () => onResolveResult(false, true) })}>重置未确认记录</Button>} /> : null}
            <div className="screenplay-layout">
                <nav className="screenplay-nav" aria-label="剧本导航">
                    <span className="screenplay-eyebrow">创作目录</span>
                    <button type="button" aria-current={tab === "settings" ? "page" : undefined} data-active={tab === "settings"} onClick={() => { setTab("settings"); setInspectorTab("ai"); }}><BookOpen aria-hidden="true" />故事设定与大纲</button>
                    <div className="screenplay-nav-section"><span>分集正文 <b>{draft.episodes.length}</b></span><Button type="text" aria-label="添加分集" icon={<Plus className="size-4" />} onClick={() => { const episode = emptyEpisode(draft.episodes.length + 1); edit({ ...draft, episodes: [...draft.episodes, episode] }); setEpisodeId(episode.id); setEpisodeView("novel"); setTab("episode"); setInspectorTab("ai"); }} /></div>
                    <div className="screenplay-episode-list">{draft.episodes.map((episode, index) => <button type="button" key={episode.id} aria-current={tab === "episode" && selectedEpisode?.id === episode.id ? "page" : undefined} data-active={tab === "episode" && selectedEpisode?.id === episode.id} onClick={() => { setEpisodeId(episode.id); setSceneId(undefined); setEpisodeView("novel"); setTab("episode"); setInspectorTab("ai"); }}><span className="screenplay-episode-number">{String(index + 1).padStart(2, "0")}</span><span className="screenplay-episode-label">{episode.title}<small>{episode.novelText?.trim() ? `小说 ${episode.novelText.length.toLocaleString()} 字` : "小说待创作"}{episode.scenes.length ? ` · ${episode.scenes.length} 场${episode.scenesNeedAdaptation ? "待同步" : ""}` : ""}</small></span>{episode.novelText?.trim() && episode.scenes.length && !episode.scenesNeedAdaptation ? <Check className="screenplay-episode-check" aria-label="已有小说与分场" /> : null}</button>)}{!draft.episodes.length ? <div className="screenplay-nav-empty"><FileText aria-hidden="true" /><span>还没有分集</span><small>生成大纲后，分集会列在这里</small></div> : null}</div>
                    <button type="button" className="screenplay-history-button" aria-current={tab === "history" ? "page" : undefined} data-active={tab === "history"} onClick={() => setTab("history")}><History aria-hidden="true" />历史版本<span className="screenplay-count">{workflow.history.length}</span></button>
                </nav>
                <main className="screenplay-main" data-canvas-wheel-scroll>{tab === "settings" ? <ScreenplaySettings document={draft} onChange={edit} /> : tab === "history" ? <div className="screenplay-history"><h2>历史版本</h2><p>保留最近 12 次保存，可恢复为新的修订版本。</p>{workflow.history.length ? [...workflow.history].reverse().map((entry) => <div className="screenplay-history-row" key={entry.id}><div><strong>v{entry.document.revision} · {entry.label}</strong><p>{new Date(entry.createdAt).toLocaleString()}</p></div><Button disabled={busy || dirty} onClick={() => modal.confirm({ title: "恢复这个版本？", content: "当前内容会先保存到历史记录，已产出的分镜会标记待同步。", okText: "恢复", cancelText: "取消", onOk: () => { const restored = onSave(entry.document, doc.revision, "恢复历史版本"); setDraft(restored.document); setDirty(false); } })}>恢复</Button></div>) : <Empty description="还没有历史版本" />}</div> : selectedEpisode ? <ScreenplayEpisodeEditor document={draft} episode={selectedEpisode} view={episodeView} onViewChange={setEpisodeView} selectedSceneId={selectedScene?.id} onSelectScene={setSceneId} onConfirmScenesSync={confirmScenesSync} onChange={(episode) => edit({ ...draft, episodes: draft.episodes.map((item) => item.id === episode.id ? episode : item) })} /> : <Empty description="先生成大纲或添加分集" />}</main>
                <aside className="screenplay-inspector" data-canvas-wheel-scroll>
                    <div className="screenplay-inspector-tabs" role="group" aria-label="创作工具">
                        <button type="button" aria-pressed={inspectorTab === "ai"} onClick={() => setInspectorTab("ai")}><Sparkles aria-hidden="true" />AI 编剧</button>
                        <button type="button" aria-pressed={inspectorTab === "assets"} onClick={() => setInspectorTab("assets")}><Users aria-hidden="true" />资产{draft.assets.length ? <span>{draft.assets.length}</span> : null}</button>
                        <button type="button" aria-pressed={inspectorTab === "production"} onClick={() => setInspectorTab("production")}><Clapperboard aria-hidden="true" />制作</button>
                    </div>
                    <div className="screenplay-inspector-content">
                    {inspectorTab === "ai" ? <section className="screenplay-ai-panel">
                        <div className="screenplay-inspector-heading"><h3>{tab === "episode" ? `第 ${episodeNumber} 集 · AI 辅助` : "故事创作"}</h3><p>{tab === "episode" ? episodeView === "novel" ? "从分集大纲展开完整小说，再改编为分场剧本。" : "根据小说改编分场，或调整现有动作与对白。" : canOutline ? "根据故事设定，生成大纲与分集。" : "大纲 → 小说正文 → 分场剧本 → 分镜表"}</p></div>
                        <div className="screenplay-field"><span>编剧模型</span><ModelPicker config={config} capability="text" value={model} fullWidth popoverPlacement="bottomRight" autoAdjustOverflow onChange={(value) => updateConfig("textModel", value)} /></div>
                        {draft.episodes.length ? <div className="screenplay-field"><span>当前分集</span><Select aria-label="当前分集" value={selectedEpisode?.id} options={draft.episodes.map((episode, index) => ({ value: episode.id, label: `${String(index + 1).padStart(2, "0")} · ${episode.title}` }))} onChange={(id) => { setEpisodeId(id); setSceneId(undefined); setEpisodeView("novel"); setTab("episode"); }} /></div> : null}
                        <label className="screenplay-field"><span>本次补充要求 <small>选填</small></span><Input.TextArea value={instruction} maxLength={12000} onChange={(event) => setInstruction(event.target.value)} rows={3} placeholder="例如：加强人物冲突，结尾留下悬念" /></label>
                        {tab === "episode" && episodeView === "scenes" && selectedScene ? <p className="screenplay-note screenplay-selection-note">当前场次 · {selectedScene.title || "未命名场次"}</p> : null}
                    </section> : null}
                    {inspectorTab === "assets" ? <section>
                        <div className="screenplay-section-title"><h3>人物与场景</h3><Button type="text" aria-label="添加资产" icon={<Plus className="size-4" />} onClick={() => edit({ ...draft, assets: [...draft.assets, { id: nanoid(), kind: "character", name: "新人物", description: "" }] })} /></div>
                        <p className="screenplay-note">管理故事资产，绑定画布上的人物或参考图。</p>
                        {draft.assets.map((asset) => <div className="screenplay-asset" key={asset.id}><div className="screenplay-asset-title"><Select aria-label="资产类型" value={asset.kind} options={[{ value: "character", label: "人物" }, { value: "location", label: "场景" }, { value: "prop", label: "道具" }]} onChange={(kind) => edit({ ...draft, assets: draft.assets.map((item) => item.id === asset.id ? { ...item, kind } : item) })} /><Input aria-label="资产名称" value={asset.name} maxLength={100} onChange={(event) => edit({ ...draft, assets: draft.assets.map((item) => item.id === asset.id ? { ...item, name: event.target.value } : item) })} /></div><Input.TextArea aria-label={`${asset.name}设定`} value={asset.description} maxLength={5000} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event) => edit({ ...draft, assets: draft.assets.map((item) => item.id === asset.id ? { ...item, description: event.target.value } : item) })} /><Select className="screenplay-asset-binding" aria-label={`绑定${asset.name}资产`} allowClear showSearch optionFilterProp="label" placeholder="绑定画布上的人物 / 参考图" value={asset.referenceNodeId} options={nodes.filter((item) => item.id !== node.id && (item.type === CanvasNodeType.Image || item.metadata?.characterAssetId || item.metadata?.screenplaySource?.assetId)).map((item) => ({ label: item.title, value: item.id }))} onChange={(referenceNodeId) => edit({ ...draft, assets: draft.assets.map((item) => item.id === asset.id ? { ...item, referenceNodeId } : item) })} /></div>)}
                        {!draft.assets.length ? <div className="screenplay-inspector-empty"><Users aria-hidden="true" /><strong>故事角色，即将在此登场</strong><p>生成大纲后自动整理，也可以手动添加。</p><Button icon={<Plus className="size-4" />} onClick={() => edit({ ...draft, assets: [...draft.assets, { id: nanoid(), kind: "character", name: "新人物", description: "" }] })}>添加人物或场景</Button></div> : null}
                    </section> : null}
                    {inspectorTab === "production" ? <section className="screenplay-production">
                        <div className="screenplay-inspector-heading"><span className="screenplay-eyebrow">从文字到画面</span><h3>准备进入制作</h3><p>确认剧本后，提取资产并拆分镜头。</p></div>
                        <div className="screenplay-production-step"><span className="screenplay-step-number">01</span><div><strong>确认剧本</strong><p className="screenplay-note">当前版本 v{doc.revision}{dirty ? " · 有未保存修改" : approved ? " · 已确认" : " · 待确认"}</p></div></div>
                        <Button block disabled={busy || approved} icon={<Check className="size-4" />} onClick={() => void attempt(() => { const saved = saveDraft(); onApprove(saved.revision); message.success("当前剧本已确认"); })}>{approved ? "当前版本已确认" : "确认当前剧本"}</Button>
                        <div className="screenplay-production-step"><span className="screenplay-step-number">02</span><div><strong>提取故事资产</strong><p className="screenplay-note">{draft.assets.length} 项人物、场景与道具设定</p></div></div>
                        <Button block disabled={busy || !approved || !draft.assets.length} icon={<Users className="size-4" />} onClick={() => void attempt(onExtract)}>提取资产到画布</Button>
                        <div className="screenplay-production-step"><span className="screenplay-step-number">03</span><div><strong>生成分镜表</strong><p className="screenplay-note">{selectedEpisode ? `第 ${episodeNumber} 集 · ${selectedEpisode.scenes.length} 个场次` : "请先创作分集正文"}</p></div></div>
                        <Button block type="primary" className="screenplay-primary-action" disabled={busy || !approved || !selectedEpisode?.scenes.length} icon={<Clapperboard className="size-4" />} onClick={() => run({ action: "storyboard", episodeId: selectedEpisode?.id })}>将当前集拆成分镜</Button>
                        {storyboards.length ? <div className="screenplay-section-title"><h3>已生成分镜</h3><span>{storyboards.length}</span></div> : null}{storyboards.map((item) => <button type="button" className="screenplay-storyboard-link" key={item.id} onClick={() => onOpenStoryboard(item.id)}><FileText aria-hidden="true" /><span>{item.title}</span>{item.metadata?.screenplaySource?.stale ? <Tag color="warning">源剧本已更新</Tag> : <ArrowRight aria-hidden="true" />}</button>)}
                    </section> : null}
                    </div>
                    {inspectorTab === "ai" ? <div className="screenplay-generation-controls" aria-label="剧本生成操作">
                        <div className="screenplay-cost"><span>单次推理预估</span><GenerationCostIndicator estimate={estimate} compact /></div>
                        {tab === "episode" ? <>
                            {episodeView === "novel" ? <>
                                <Button block type="primary" className="screenplay-primary-action" disabled={busy || !selectedEpisode} icon={<Sparkles className="size-4" />} onClick={() => run({ action: selectedEpisode?.novelText?.trim() ? "rewrite_novel" : "write_novel", episodeId: selectedEpisode?.id })}>{selectedEpisode?.novelText?.trim() ? "按要求改写本集小说" : `生成第 ${episodeNumber} 集完整小说`}</Button>
                                <Button block className="screenplay-secondary-action" disabled={busy || !selectedEpisode?.novelText?.trim()} icon={<ArrowRight className="size-4" />} onClick={() => run({ action: "adapt_episode", episodeId: selectedEpisode?.id })}>{selectedEpisode?.scenes.length ? "按小说重新改编分场" : "将小说改编为分场剧本"}</Button>
                            </> : <>
                                <Button block type="primary" className="screenplay-primary-action" disabled={busy || !selectedEpisode || (!selectedEpisode.scenes.length && !selectedEpisode.novelText?.trim())} icon={<Sparkles className="size-4" />} onClick={() => run({ action: selectedEpisode?.scenes.length ? "continue_episode" : "adapt_episode", episodeId: selectedEpisode?.id })}>{selectedEpisode?.scenes.length ? "续写分场剧本" : "将小说改编为分场剧本"}</Button>
                                <Button block className="screenplay-secondary-action" disabled={busy || !selectedScene} icon={<Pencil className="size-4" />} onClick={() => run({ action: "rewrite_scene", episodeId: selectedEpisode?.id, sceneId: selectedScene?.id })}>改写选中场次</Button>
                            </>}
                        </> : <>
                            {canOutline ? <Button block type="primary" className="screenplay-primary-action" disabled={busy} icon={<Sparkles className="size-4" />} onClick={() => run({ action: "outline" })}>{draft.outline ? "重新生成大纲与分集" : "生成大纲与分集"}</Button> : null}
                            {draft.episodes.length ? <Button block type={canOutline ? "default" : "primary"} className={canOutline ? "screenplay-secondary-action" : "screenplay-primary-action"} icon={<ArrowRight className="size-4" />} onClick={() => { setEpisodeView("novel"); setTab("episode"); setInspectorTab("ai"); }}>创作分集小说与剧本</Button> : null}
                        </>}
                        <p className="screenplay-note">生成前确认费用，切换分集不扣积分。</p>
                    </div> : null}
                </aside>
            </div>
            <footer className="screenplay-footer"><span><FileText aria-hidden="true" />{draft.episodes.length} 集<span>·</span>{sceneCount} 场<span>·</span>{draft.assets.length} 项资产</span><span data-busy={busy || undefined}>{busy ? <><LoaderCircle className="screenplay-busy-icon" aria-hidden="true" />{activeTaskLabel}</> : dirty ? "修改后记得保存" : "剧本已保存至画布"}</span></footer>
            <input ref={fileInput} type="file" hidden accept=".txt,.md,.json,text/plain,application/json" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; await attempt(async () => { if (file.size > 1024 * 1024) throw new Error("文本文件不能超过 1MB"); const text = await file.text(); if (file.name.toLowerCase().endsWith(".json")) { const imported = validateScreenplay(JSON.parse(text)); edit({ ...imported, revision: draft.revision }); } else { if (text.length > SCREENPLAY_SOURCE_LIMIT) throw new Error("素材超过 60000 字，请按章节拆分后导入"); edit({ ...draft, source: text }); } setTab("settings"); message.success("已载入编辑草稿，请保存后使用"); }); }} />
        </div>
    </Modal>;
}
