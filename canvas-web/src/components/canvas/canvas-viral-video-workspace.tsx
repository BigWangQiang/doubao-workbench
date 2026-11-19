import { useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, InputNumber, Modal, Progress, Select, Tabs, Tag } from "antd";
import { AlertCircle, Check, Clapperboard, FileText, Grid2x2, Image as ImageIcon, Info, Minus, Pencil, Play, RefreshCw, Replace, ScanEye, Upload, Video } from "lucide-react";
import { PersistentResourceImage } from "@/components/persistent-resource-image";
import { ModelPicker } from "@/components/model-picker";
import { GenerationCostIndicator } from "@/components/generation-cost-indicator";
import { modelDisplayName, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { estimateViralVideoGeneration } from "@/lib/canvas/canvas-viral-video-pricing";
import { VIRAL_VIDEO_ANALYSIS_CREDITS, VIRAL_VIDEO_ANALYSIS_MODEL_LABEL } from "@/lib/canvas/canvas-viral-video-policy";
import { updateViralVideoGlobalPrompt, viralVideoAnalysisErrorMessage } from "@/lib/canvas/canvas-viral-video";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { ViralVideoWorkflow } from "@/types/canvas-viral-video";
import "./canvas-viral-video.css";

type Props = {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    open: boolean;
    onMinimize: () => void;
    onRetry: () => void;
    onArrangeAssets: () => void;
    onReplaceAsset: (assetId: string, nodeId?: string) => void;
    onUploadAsset: (assetId: string, file: File) => Promise<void>;
    onUpdatePlan: (rows: StoryboardRow[], workflow?: ViralVideoWorkflow) => void;
    onPreview: (rowIds: string[]) => Promise<void>;
    onGenerateVideos: (rowIds: string[]) => Promise<void>;
    onCompose: (nodeIds: string[]) => void;
    onOpenStoryboard: () => void;
};

const ASSET_LABELS = { character: "人物", product: "产品", scene: "场景", prop: "道具", style: "风格" };
const WORKFLOW_STEPS = ["视频反推", "替换资产", "分镜预览", "生成视频", "合成成片"];

export function CanvasViralVideoWorkspace({ node, nodes, open, onMinimize, onRetry, onArrangeAssets, onReplaceAsset, onUploadAsset, onUpdatePlan, onPreview, onGenerateVideos, onCompose, onOpenStoryboard }: Props) {
    const { message, modal } = App.useApp();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [tab, setTab] = useState("prompt");
    const [editing, setEditing] = useState<StoryboardRow | null>(null);
    const [promptDraft, setPromptDraft] = useState<string | null>(null);
    const [uploading, setUploading] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const uploadTarget = useRef<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const workflow = node.metadata!.viralVideo!;
    const analysis = workflow.analysis;
    const script = nodes.find((item) => item.id === workflow.storyboardNodeId);
    const rows = script?.metadata?.storyboard?.rows || [];
    const candidates = nodes.filter((item) => item.type === CanvasNodeType.Image && !item.metadata?.viralVideoAnalysisNodeId && (item.metadata?.content || item.metadata?.storageKey));
    const imageModel = config.imageModel || config.model;
    const videoModel = config.videoModel || config.model;
    const imageReady = (row: StoryboardRow) => Boolean(nodes.find((item) => item.id === row.imageNodeId)?.metadata?.content);
    const videoNode = (row: StoryboardRow) => nodes.find((item) => item.id === row.videoNodeId);
    const completedVideos = rows.flatMap((row) => { const video = videoNode(row); return video?.metadata?.content ? [video.id] : []; });
    const generatedImages = rows.filter(imageReady).length;
    const analyzing = workflow.stage === "sampling" || workflow.stage === "analyzing";
    const busyBatch = script?.metadata?.generationBatches?.some((batch) => batch.items.some((item) => ["waiting", "submitting", "queued", "running"].includes(item.status))) || false;
    const hasPlan = workflow.stage === "ready" && Boolean(script) && rows.length > 0;
    const blocked = submitting || busyBatch || Boolean(uploading) || !hasPlan;
    const missingImages = rows.filter((row) => !imageReady(row));
    const missingVideos = rows.filter((row) => !videoNode(row)?.metadata?.content);
    const tryAction = (action: () => void) => { try { action(); } catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); } };
    const submit = async (action: () => Promise<void>) => {
        if (blocked) return;
        setSubmitting(true);
        try { await action(); } catch (error) { message.error(error instanceof Error ? error.message : "提交失败"); } finally { setSubmitting(false); }
    };
    const confidenceLabels = { high: "高", medium: "中", low: "低" };
    const failed = workflow.stage === "error";
    const currentStep = analyzing || failed ? 0 : completedVideos.length === rows.length && rows.length ? 4 : generatedImages === rows.length && rows.length ? 3 : generatedImages ? 2 : 1;
    const progress = Math.min(100, Math.max(0, workflow.progress || 0));
    const source = nodes.find((item) => item.id === workflow.sourceNodeId);
    const previewFrames = [...new Set([0, Math.floor(workflow.frames.length / 2), workflow.frames.length - 1])].flatMap((index) => workflow.frames[index] ? [workflow.frames[index]] : []);

    return (
        <>
            <Modal
                title={<div className="canvas-viral-workspace-header"><div className="canvas-viral-workspace-brand"><span className="canvas-viral-brand-icon"><Clapperboard className="size-5" aria-hidden="true" /></span><div><h2>爆款复刻工作区</h2><p>{source?.title || "参考视频"}</p></div></div><button type="button" className="canvas-viral-minimize" aria-label="最小化复刻工作区" title="收起到画布，任务继续进行" onClick={onMinimize}><Minus className="size-4" aria-hidden="true" /><span>最小化</span></button></div>}
                open={open}
                onCancel={onMinimize}
                closable={false}
                mask={{ closable: false }}
                footer={null}
                centered
                width="min(1120px, 96vw)"
                className="canvas-viral-workspace"
                styles={{ container: { padding: 0, overflow: "hidden" }, header: { padding: "var(--space-5) var(--space-6)", marginBottom: 0, background: "transparent" }, body: { maxHeight: "min(76dvh, calc(100dvh - var(--space-24)))", overflowY: "auto" } }}
            >
                <div className="canvas-viral-workspace-body" data-canvas-no-zoom data-canvas-wheel-scroll>
                    <ol className="canvas-viral-steps" aria-label="复刻流程">
                        {WORKFLOW_STEPS.map((label, index) => <li key={label} data-state={index < currentStep ? "complete" : index === currentStep ? failed ? "error" : "current" : "pending"} aria-current={index === currentStep ? "step" : undefined}><span className="canvas-viral-step-number">{index < currentStep ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}</span><span>{label}</span></li>)}
                    </ol>
                    {analyzing || failed ? (
                        <section className="canvas-viral-analysis-state" data-stage={workflow.stage} aria-label="视频分析状态">
                            <div className="canvas-viral-analysis-main">
                                <div className="canvas-viral-state-heading"><span className="canvas-viral-status-icon">{failed ? <AlertCircle className="size-5" aria-hidden="true" /> : <ScanEye className="size-5" aria-hidden="true" />}</span><div><span className="canvas-viral-eyebrow">视频反推</span><h3>{workflow.stage === "sampling" ? "正在提取参考画面" : failed ? "分析暂未完成" : "AI 正在拆解视频"}</h3></div>{analyzing ? <strong className="canvas-viral-state-percent">{workflow.progress === undefined ? "进行中" : <>{progress}<small>%</small></>}</strong> : null}</div>
                                <p className="canvas-viral-state-description">{failed ? "查看下方原因，调整后可重新分析。" : workflow.stage === "sampling" ? "提取关键画面，为提示词与分镜提供参考。" : "正在整理整片提示词、连续分镜与可替换资产。"}</p>
                                {analyzing ? <Progress percent={progress} status="active" showInfo={false} strokeColor="var(--viral-accent)" railColor="var(--viral-track)" aria-label={workflow.stage === "sampling" ? "提取画面进度" : "AI 分析进度"} /> : null}
                                <dl className="canvas-viral-analysis-metrics"><div><dt>{failed ? "上次分析模型" : "分析模型"}</dt><dd title={modelDisplayName(config, workflow.model)}>{modelDisplayName(config, workflow.model)}</dd></div><div><dt>参考画面</dt><dd>{workflow.frames.length ? `${workflow.frames.length} 帧` : "提取中"}</dd></div><div><dt>视频时长</dt><dd>{workflow.durationSeconds ? `${workflow.durationSeconds.toFixed(1)} 秒` : "读取中"}</dd></div></dl>
                                {workflow.error ? <Alert type="error" showIcon title="本次分析未能生成完整方案" description={viralVideoAnalysisErrorMessage(workflow.error)} /> : null}
                                {workflow.pollingError ? <Alert type="warning" showIcon title="正在重新读取任务状态" description={workflow.pollingError} /> : null}
                                {failed ? <div className="canvas-viral-retry"><div className="canvas-viral-retry-model"><span className="text-xs text-foreground/55">固定分析模型</span><strong className="text-sm font-medium">{VIRAL_VIDEO_ANALYSIS_MODEL_LABEL}</strong></div><Button type="primary" icon={<RefreshCw className="size-4" />} onClick={() => modal.confirm({ title: "重新分析视频", content: `使用 ${VIRAL_VIDEO_ANALYSIS_MODEL_LABEL} 提交 1 个新的视觉分析任务，固定收取 ${VIRAL_VIDEO_ANALYSIS_CREDITS} 积分。原任务记录保留。`, okText: "重新分析", cancelText: "取消", onOk: onRetry })}>重新分析<GenerationCostIndicator estimate={estimateViralVideoGeneration(config, "text", [])} /></Button><span>每次反推固定 {VIRAL_VIDEO_ANALYSIS_CREDITS} 积分</span></div> : <p className="canvas-viral-background-hint">可以最小化继续创作，分析将在后台进行。</p>}
                            </div>
                            <aside className="canvas-viral-evidence"><div className="canvas-viral-section-heading"><span>参考画面</span><span>{workflow.frames.length ? `${workflow.frames.length} 帧已准备` : "准备中"}</span></div>{previewFrames.length ? <div className="canvas-viral-evidence-frames">{previewFrames.map((frame) => <figure key={frame.storageKey}><PersistentResourceImage src="" storageKey={frame.storageKey} thumbnail alt={`${frame.timeSeconds.toFixed(1)} 秒参考画面`} /><figcaption>{frame.timeSeconds.toFixed(1)}s</figcaption></figure>)}</div> : <div className="canvas-viral-evidence-empty"><Video className="size-8" aria-hidden="true" /><span>正在准备视频画面</span></div>}<div className="canvas-viral-evidence-outputs"><span><FileText className="size-4" aria-hidden="true" />整片提示词</span><span><Clapperboard className="size-4" aria-hidden="true" />连续分镜表</span><span><Replace className="size-4" aria-hidden="true" />可替换资产</span></div></aside>
                            <p className="canvas-viral-analysis-note"><Info className="size-4 shrink-0" aria-hidden="true" />基于抽样画面分析，镜头时间为估计值；音轨与对白不在本次分析范围内。</p>
                        </section>
                    ) : analysis ? (
                        <>
                            <div className="canvas-viral-plan-summary">
                                <div className="min-w-0 flex-1"><h3 className="text-base font-medium">{analysis.summary}</h3><p className="mt-2 text-sm text-foreground/65">{analysis.hook}</p></div>
                                <div className="flex flex-wrap items-center gap-2"><Tag>{rows.length} 个镜头</Tag><Tag>{analysis.assets.length} 项资产</Tag><Button icon={<Grid2x2 className="size-4" />} disabled={!analysis.assets.length} onClick={() => tryAction(() => { onArrangeAssets(); onMinimize(); message.success("参考图已按每行 4 张整理为宫格"); })}>整理参考图（4列）</Button></div>
                            </div>
                            {!script ? <Alert type="error" title="分镜表节点已删除，请重新创建复刻流程" /> : null}
                            <Tabs className="canvas-viral-plan-tabs" activeKey={tab} onChange={setTab} items={[
                                { key: "prompt", label: <span className="inline-flex items-center gap-2"><FileText className="size-4" />整片提示词</span>, children: <div className="space-y-3"><label className="block text-sm font-medium" htmlFor="viral-global-prompt">整片风格与叙事约束</label><Input.TextArea id="viral-global-prompt" value={promptDraft ?? workflow.promptOverride ?? analysis.globalPrompt} onChange={(event) => setPromptDraft(event.target.value)} autoSize={{ minRows: 5, maxRows: 10 }} disabled={blocked} /><div className="flex flex-wrap items-center gap-3"><Button disabled={blocked || promptDraft === null} onClick={() => tryAction(() => { if (!promptDraft?.trim()) throw new Error("整片提示词不能为空"); const next = updateViralVideoGlobalPrompt(workflow, promptDraft, rows, nodes); onUpdatePlan(next.rows, next.workflow); setPromptDraft(null); message.success("已同步整片提示词与全部镜头"); })}>同步到全部分镜</Button><span className="text-xs text-foreground/55">完整逐镜提示词已写入画布「整片复刻提示词」文本节点。</span></div><Alert type="info" showIcon title="反推提示词是对可见画面的近似描述" description={["镜头边界由抽样估计；未分析音轨，未知对白留空。", ...analysis.limitations].join(" ")} /></div> },
                                { key: "assets", label: <span className="inline-flex items-center gap-2"><Replace className="size-4" />替换资产</span>, children: <div className="space-y-3"><p className="text-sm text-foreground/65">选择画布中的图片或上传自己的资产。替换会同步相关镜头，并保留之前生成的素材。</p>{analysis.assets.length ? analysis.assets.map((asset) => {
                                    const original = nodes.find((item) => item.id === workflow.assetNodeIds[asset.id]);
                                    const boundId = workflow.bindings[asset.id];
                                    const replacement = boundId ? nodes.find((item) => item.id === boundId) : undefined;
                                    return <div key={asset.id} className="grid gap-4 border-b border-border py-4 sm:grid-cols-2"><div className="flex min-w-0 gap-3">{original ? <PersistentResourceImage src={original.metadata?.content || ""} storageKey={original.metadata?.storageKey} alt={`${asset.name}的原视频证据帧`} className="h-24 w-24 shrink-0 rounded-lg bg-foreground/5 object-contain" /> : null}<div className="min-w-0"><span className="text-sm font-medium">{asset.name}</span><Tag className="ml-2">{ASSET_LABELS[asset.kind]}</Tag><p className="mt-2 text-xs text-foreground/65">{asset.description}</p><p className="mt-1 text-xs text-foreground/45">原图为证据帧，未单独抠图</p></div></div><div className="space-y-2"><Select className="w-full" aria-label={`替换${asset.name}`} disabled={blocked || Boolean(uploading)} value={boundId || ""} onChange={(value) => tryAction(() => onReplaceAsset(asset.id, value || undefined))} options={[{ label: "保留原视频参考", value: "" }, ...candidates.map((item) => ({ label: item.title, value: item.id }))]} /><div className="flex flex-wrap items-center gap-3"><Button size="small" icon={<Upload className="size-4" />} disabled={blocked || Boolean(uploading)} loading={uploading === asset.id} onClick={() => { uploadTarget.current = asset.id; fileInput.current?.click(); }}>上传我的资产</Button>{replacement ? <PersistentResourceImage src={replacement.metadata?.content || ""} storageKey={replacement.metadata?.storageKey} alt={replacement.title} className="h-12 w-12 rounded object-contain" /> : boundId ? <span role="alert" className="text-sm text-red-500">替换图片已删除，请重新选择</span> : null}</div></div></div>;
                                }) : <Empty description="此视频未识别出需要独立替换的资产" />}<input ref={fileInput} className="hidden" type="file" accept="image/*" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; const assetId = uploadTarget.current; if (!file || !assetId) return; setUploading(assetId); try { await onUploadAsset(assetId, file); } catch (error) { message.error(error instanceof Error ? error.message : "资产上传失败"); } finally { setUploading(null); } }} /></div> },
                                { key: "shots", label: <span className="inline-flex items-center gap-2"><Clapperboard className="size-4" />分镜表</span>, children: <div className="space-y-3"><div className="flex items-center justify-between gap-3"><span className="text-sm text-foreground/65">每镜保留时间、画面、证据和两类提示词，点击编辑查看详情。</span><Button size="small" onClick={onOpenStoryboard}>打开画布分镜表</Button></div><div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-foreground/5 text-foreground/65"><tr>{["镜头 / 时间", "画面", "分镜预览", "视频", "操作"].map((label) => <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map((row) => {
                                    const shot = analysis.shots.find((item) => item.id === row.id);
                                    const image = nodes.find((item) => item.id === row.imageNodeId);
                                    const video = videoNode(row);
                                    return <tr key={row.id} className="border-t border-border align-top"><td className="whitespace-nowrap px-3 py-4"><span className="font-medium">{String(row.shotNumber).padStart(2, "0")}</span><p className="mt-1 text-xs text-foreground/55">{row.timeBeats}</p><p className="mt-1 text-xs">{row.durationSeconds}s · 估计</p></td><td className="px-3 py-4"><p className="line-clamp-3">{row.plotDescription}</p><p className="mt-2 text-xs text-foreground/55">{row.camera}</p>{shot ? <p className="mt-2 line-clamp-2 text-xs text-foreground/45" title={shot.evidence}>依据：{shot.evidence} · 置信度{confidenceLabels[shot.confidence]}</p> : null}</td><td className="px-3 py-4">{image?.metadata?.content ? <PersistentResourceImage src={image.metadata.content} storageKey={image.metadata.storageKey} alt={`镜头 ${row.shotNumber} 分镜预览`} className="h-20 w-24 object-contain" /> : <span className="text-xs text-foreground/55">{image?.metadata?.status === "error" ? "生成失败，可重试" : image?.metadata?.status === "loading" ? "生成中" : "待生成"}</span>}</td><td className="px-3 py-4"><span className="whitespace-nowrap text-xs">{video?.metadata?.content ? "已完成" : video?.metadata?.status === "error" ? "失败，可重试" : video?.metadata?.status === "loading" ? "生成中" : "待生成"}</span></td><td className="px-3 py-3"><div className="flex flex-col gap-2"><Button size="small" icon={<Pencil className="size-3" />} disabled={blocked} onClick={() => setEditing({ ...row })}>编辑</Button><Button size="small" disabled={blocked || imageReady(row)} onClick={() => void submit(() => onPreview([row.id]))}>生成此镜预览</Button><Button size="small" disabled={blocked || !imageReady(row) || Boolean(video?.metadata?.content)} onClick={() => void submit(() => onGenerateVideos([row.id]))}>生成此镜视频</Button></div></td></tr>;
                                })}</tbody></table></div></div> },
                            ]} />
                            <div className="canvas-viral-generation space-y-3">
                                <div className="flex flex-wrap items-center gap-3 text-sm"><span>分镜图</span><ModelPicker config={config} value={imageModel} capability="image" onChange={(imageModel) => updateConfig("imageModel", imageModel)} /><span>视频</span><ModelPicker config={config} value={videoModel} capability="video" onChange={(videoModel) => updateConfig("videoModel", videoModel)} /></div>
                                <div className="flex flex-wrap items-center gap-3"><Button icon={<ImageIcon className="size-4" />} disabled={blocked || !missingImages.length} loading={submitting} onClick={() => void submit(() => onPreview(missingImages.map((row) => row.id)))}>生成分镜预览 ({generatedImages}/{rows.length}) <GenerationCostIndicator estimate={estimateViralVideoGeneration(config, "image", missingImages, script)} /></Button><Button type="primary" icon={<Play className="size-4" />} disabled={blocked || generatedImages !== rows.length || !missingVideos.length} loading={submitting} onClick={() => void submit(() => onGenerateVideos(missingVideos.map((row) => row.id)))}>批量复刻视频 ({completedVideos.length}/{rows.length}) <GenerationCostIndicator estimate={estimateViralVideoGeneration(config, "video", missingVideos, script)} /></Button><Button icon={<Video className="size-4" />} disabled={blocked || completedVideos.length !== rows.length} onClick={() => tryAction(() => onCompose(completedVideos))}>合成成片</Button>{busyBatch ? <span className="text-xs text-foreground/55">任务队列处理中，可最小化工作区继续创作</span> : null}</div>
                                <p className="text-xs text-foreground/55">先确认分镜图，再批量生成视频。失败镜头可单独重试；计价读取当前后台模型配置，最终按服务端用量结算。</p>
                            </div>
                        </>
                    ) : <Empty description="暂无可用的复刻方案" />}
                </div>
            </Modal>
            <Modal title={editing ? `编辑镜头 ${editing.shotNumber}` : "编辑镜头"} open={open && Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => tryAction(() => { if (!editing) return; if (!editing.plotDescription.trim() || !editing.imageGenerationPrompt.trim() || !editing.videoMotionPrompt.trim()) throw new Error("请填写画面和两类提示词"); onUpdatePlan(rows.map((row) => row.id === editing.id ? editing : row)); setEditing(null); })} okText="保存并同步" cancelText="取消" width="min(720px, 96vw)" styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}>
                {editing ? <div className="space-y-4" data-canvas-no-zoom data-canvas-wheel-scroll><label className="block text-sm">镜头时长（秒）<InputNumber className="ml-3" min={0.1} max={120} value={editing.durationSeconds} onChange={(value) => setEditing({ ...editing, durationSeconds: value || 0.1 })} /></label>{([['plotDescription', '画面描述'], ['imageGenerationPrompt', '首帧图片提示词'], ['videoMotionPrompt', '视频动态提示词'], ['dialogue', '对白 / 字幕'], ['negativePrompt', '负面提示词']] as const).map(([key, label]) => <label key={key} className="block space-y-2 text-sm"><span>{label}</span><Input.TextArea value={editing[key]} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} autoSize={{ minRows: 2, maxRows: 6 }} /></label>)}</div> : null}
            </Modal>
        </>
    );
}
