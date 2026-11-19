import { useEffect, useRef, useState } from "react";
import { App, Button, Progress, Select, Spin } from "antd";
import { ArrowUpRight, Check, Clapperboard, FileText, Film, GripVertical, Music2, Play, RefreshCw, ScanEye, Upload, Video } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { GenerationCostIndicator } from "@/components/generation-cost-indicator";
import { VIDEO_ANALYSIS_DIMENSIONS, videoAnalysisBusy } from "@/lib/canvas/canvas-video-analysis";
import { formatVideoFrameTime } from "@/lib/canvas/canvas-video-frame-analysis";
import { localizeErrorMessage } from "@/lib/generation-error";
import { resolveMediaUrl } from "@/services/file-storage";
import { estimateVideoAnalysis } from "@/services/canvas-video-analysis";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { VideoAnalysisWorkflow } from "@/types/canvas-video-analysis";
import "./canvas-video-analysis.css";

type Props = {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    onConfigure: (changes: Pick<Partial<VideoAnalysisWorkflow>, "model" | "inputMode" | "dimensions" | "sourceNodeId">) => void;
    onReplaceFile: (file: File) => Promise<void>;
    onStart: () => Promise<void>;
    onOpenResult: (id: string) => void;
    onResetUnsubmitted: () => void;
};

const STATUS = { idle: "选择素材与拆解维度", preparing: "正在准备参考画面", submitting: "正在提交分析", recovering: "正在找回分析任务", analyzing: "AI 正在拉片", ready: "拉片完成", error: "分析需要处理" };
const DIMENSION_ICONS = { storyboard: Clapperboard, motion: Video, music: Music2 };

export function CanvasVideoAnalysisNode({ node, nodes, onConfigure, onReplaceFile, onStart, onOpenResult, onResetUnsubmitted }: Props) {
    const workflow = node.metadata!.videoAnalysis!;
    const config = useEffectiveConfig();
    const { message, modal } = App.useApp();
    const fileRef = useRef<HTMLInputElement>(null);
    const [url, setUrl] = useState("");
    const [previewError, setPreviewError] = useState(false);
    const [replacing, setReplacing] = useState(false);
    const source = nodes.find((item) => item.id === workflow.sourceNodeId);
    const busy = videoAnalysisBusy(workflow);
    const locked = busy || Boolean(workflow.result) || replacing;
    const estimate = estimateVideoAnalysis(config, workflow.model);
    const progress = workflow.progress && workflow.progress > 0 && workflow.progress < 100 ? workflow.progress : undefined;
    const options = nodes.filter((item) => item.type === CanvasNodeType.Video && (item.metadata?.storageKey || item.metadata?.content));

    useEffect(() => {
        let disposed = false;
        setUrl(""); setPreviewError(false);
        resolveMediaUrl(source?.metadata?.storageKey, source?.metadata?.content || "").then((value) => { if (!disposed) { setUrl(value); setPreviewError(!value); } }, () => { if (!disposed) setPreviewError(true); });
        return () => { disposed = true; };
    }, [source?.metadata?.storageKey, source?.metadata?.content]);

    const start = () => {
        const run = () => onStart().catch((error) => { message.error(localizeErrorMessage(error, "无法开始分析")); });
        if (workflow.stage === "error" && workflow.taskId) {
            modal.confirm({ title: "重新拉片分析？", content: "将创建新的分析任务，按所选模型重新计费。已有任务可在任务中心查看。", okText: "重新分析", cancelText: "取消", onOk: run });
        } else void run();
    };
    const configure = (changes: Parameters<Props["onConfigure"]>[0]) => {
        try { onConfigure(changes); } catch (error) { message.error(localizeErrorMessage(error, "设置更新失败")); }
    };

    return <div className="canvas-video-analysis" data-stage={workflow.stage} aria-busy={busy}>
        <header className="video-analysis-heading"><span className="video-analysis-symbol"><ScanEye className="size-5" /></span><div><strong>逐帧拉片</strong><span>{STATUS[workflow.stage]}</span></div><GripVertical className="size-4 video-analysis-grip" aria-label="拖动节点" /></header>
        <div className="video-analysis-scroll" data-canvas-wheel-scroll onWheel={(event) => event.stopPropagation()}>
            <div className="video-analysis-source-title"><span>视频素材</span><span>{source?.metadata?.durationMs ? formatVideoFrameTime(source.metadata.durationMs / 1000).slice(0, 5) : ""}{source?.metadata?.naturalWidth ? ` · ${source.metadata.naturalWidth}×${source.metadata.naturalHeight}` : ""}</span></div>
            <div className="video-analysis-preview" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                {url && !previewError ? <video src={url} controls preload="metadata" playsInline onError={() => setPreviewError(true)} aria-label="拉片原视频" /> : <div className="video-analysis-preview-empty"><Film className="size-6" /><span>{previewError ? "预览暂不可用，可重新选择素材" : "正在读取视频"}</span></div>}
            </div>
            <div className="video-analysis-controls" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                <div className="video-analysis-source-select">
                    <Select aria-label="替换视频素材" value={source?.id} placeholder="选择画布视频" disabled={locked} onChange={(sourceNodeId) => configure({ sourceNodeId })} options={options.map((item) => ({ value: item.id, label: item.title || "未命名视频" }))} popupMatchSelectWidth />
                    <Button title="上传替换素材" aria-label="上传替换素材" disabled={locked} loading={replacing} icon={<Upload className="size-4" />} onClick={() => fileRef.current?.click()} />
                    <input ref={fileRef} type="file" accept="video/*" hidden onChange={async (event) => {
                        const file = event.target.files?.[0]; event.target.value = "";
                        if (!file) return;
                        setReplacing(true);
                        try { await onReplaceFile(file); } catch (error) { message.error(localizeErrorMessage(error, "素材替换失败")); }
                        finally { setReplacing(false); }
                    }} />
                </div>
                <div className="video-analysis-field"><label>拆解维度</label><div className="video-analysis-dimensions">{VIDEO_ANALYSIS_DIMENSIONS.map((item) => {
                    const Icon = DIMENSION_ICONS[item.value];
                    const selected = workflow.dimensions.includes(item.value);
                    return <button key={item.value} type="button" disabled={locked || (item.value === "music" && workflow.inputMode === "frames")} aria-pressed={selected} title={item.value === "music" && workflow.inputMode === "frames" ? "音乐需要原视频及音轨理解能力" : undefined} onClick={() => configure({ dimensions: selected ? workflow.dimensions.filter((value) => value !== item.value) : [...workflow.dimensions, item.value] })}><Icon className="size-4" /><span>{item.label}</span>{selected ? <Check className="size-3.5" /> : <span className="size-3.5" />}</button>;
                })}</div></div>
                {!workflow.result ? <>
                    <div className="video-analysis-field"><label>分析方式</label><Select aria-label="分析方式" disabled={locked} value={workflow.inputMode} onChange={(inputMode) => configure({ inputMode })} options={[{ value: "video", label: "原视频 · 含音轨" }, { value: "frames", label: "关键帧 · 仅画面" }]} /></div>
                    <div className="video-analysis-field"><label>分析模型</label>{locked ? <span className="video-analysis-model-locked">分析中保留当前模型</span> : <ModelPicker config={config} value={workflow.model} onChange={(model) => configure({ model })} capability="text" fullWidth popoverPlacement="bottomLeft" autoAdjustOverflow />}</div>
                    <p className="video-analysis-hint">{workflow.inputMode === "video" ? "请选择支持视频理解的模型；音乐还需要音轨理解能力。" : "请选择支持图片理解的模型。镜头边界与动作仅作估计，不分析音轨。"}</p>
                </> : null}
            </div>
            {busy ? <div className="video-analysis-status" role="status" aria-live="polite">
                <div><Spin size="small" /><strong>{STATUS[workflow.stage]}</strong>{progress ? <span>{Math.round(progress)}%</span> : null}</div>
                {workflow.stage === "preparing" ? <Progress percent={workflow.progress || 0} showInfo={false} strokeColor="var(--analysis-accent)" /> : progress ? <Progress percent={progress} showInfo={false} status="active" strokeColor="var(--analysis-accent)" /> : <div className="video-analysis-pending"><span /></div>}
                <p>{workflow.pollingError || (workflow.stage === "preparing" ? "保存参考画面后提交分析" : "可继续编辑画布，完成后自动放入结果")}</p>
            </div> : null}
            {workflow.error ? <p className="video-analysis-error" role="alert">{workflow.error}</p> : null}
            {workflow.result ? <div className="video-analysis-result"><div><Check className="size-4" /><strong>{workflow.result.shots.length ? `${workflow.result.shots.length} 个镜头已分析` : "音频分析已返回"}</strong></div><p>{workflow.result.summary}</p>{workflow.result.music.status === "unavailable" ? <p className="video-analysis-warning">音轨未能分析：{workflow.result.music.description}</p> : null}<span>结果已放入画布，可继续编辑与生成</span></div> : null}
        </div>
        <footer className="video-analysis-footer" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
            {workflow.result ? <>
                <Button icon={<FileText className="size-4" />} disabled={!nodes.some((item) => item.id === workflow.documentNodeId)} onClick={() => onOpenResult(workflow.documentNodeId!)}>分析文档</Button>
                {workflow.storyboardNodeId ? <Button type="primary" icon={<ArrowUpRight className="size-4" />} disabled={!nodes.some((item) => item.id === workflow.storyboardNodeId)} onClick={() => onOpenResult(workflow.storyboardNodeId!)}>编辑分镜</Button> : null}
            </> : <div className="video-analysis-submit">
                <Button type="primary" block disabled={busy || replacing || !workflow.dimensions.length || !workflow.model || !source} icon={workflow.stage === "error" ? <RefreshCw className="size-4" /> : <Play className="size-4" />} onClick={start}>{busy ? "分析进行中" : workflow.stage === "error" ? "重新分析" : "开始拉片"}{!busy ? <GenerationCostIndicator estimate={estimate} compact /> : null}</Button>
                {workflow.stage === "recovering" ? <Button type="link" size="small" onClick={() => modal.confirm({ title: "确认未创建分析任务？", content: "请先在任务中心核对。如果实际已提交，重新分析可能重复扣费；继续等待不会新增费用。", okText: "已核对，重新准备", cancelText: "继续等待", onOk: onResetUnsubmitted })}>已核对任务未创建，重新准备</Button> : null}
            </div>}
        </footer>
    </div>;
}
