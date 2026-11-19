import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, InputNumber, Modal, Segmented, Select, Spin } from "antd";
import { AudioLines, AudioWaveform, Captions, Check, ListVideo, Plus, Scissors, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";

import { ModelPicker } from "@/components/model-picker";
import { buildSubtitleAudioRanges, detectAudioRangesFromUrl, type CanvasAudioRange } from "@/lib/canvas/canvas-audio-segmentation";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildTimelineImportSegments, type CanvasTimelineSegmentItem } from "@/lib/canvas/canvas-video-timeline-segments";
import { listVideoReferenceModels } from "@/lib/canvas/canvas-video-regeneration";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { navigateToSettings } from "@/lib/settings-navigation";
import { useThemeStore } from "@/stores/use-theme-store";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { modelDisplayName, type AiConfig } from "@/stores/use-config-store";
import { type CanvasConnection, type CanvasNodeData, type CanvasVideoEditOperation } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

export type CanvasVideoSegmentItem = CanvasTimelineSegmentItem;

export type CanvasVideoSegmentParams = {
    mode: "audio" | "video";
    startMs: number;
    endMs: number;
    prompt?: string;
    segments?: CanvasVideoSegmentItem[];
    audioRanges?: CanvasAudioRange[];
    model?: string;
    operation?: CanvasVideoEditOperation;
};

type CanvasVideoSegmentDialogProps = {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    open: boolean;
    mode: "audio" | "video";
    config: AiConfig;
    timeline?: TimelineProject | null;
    onClose: () => void;
    onConfirm: (params: CanvasVideoSegmentParams) => void;
};

const MIN_SEGMENT_MS = 100;

export function CanvasVideoSegmentDialog({ node, nodes, connections, open, mode, config, timeline, onClose, onConfirm }: CanvasVideoSegmentDialogProps) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const videoRef = useRef<HTMLVideoElement>(null);
    const segmentsSeededRef = useRef(false);
    const [videoUrl, setVideoUrl] = useState("");
    const [videoError, setVideoError] = useState(false);
    const [durationMs, setDurationMs] = useState(0);
    const [startSec, setStartSec] = useState(0);
    const [endSec, setEndSec] = useState(0);
    const [prompt, setPrompt] = useState("");
    const [segments, setSegments] = useState<CanvasVideoSegmentItem[]>([]);
    const [model, setModel] = useState("");
    const [operation, setOperation] = useState<CanvasVideoEditOperation>("extend");
    const [audioSplitMode, setAudioSplitMode] = useState<"manual" | "silence" | "subtitle">("manual");
    const [audioRanges, setAudioRanges] = useState<CanvasAudioRange[]>([]);
    const [detectingSilence, setDetectingSilence] = useState(false);
    const eligibleModels = useMemo(() => listVideoReferenceModels(config), [config]);

    // 打开弹窗时解析视频地址，读取时长并初始化起止时间。
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setVideoUrl("");
        setVideoError(false);
        setDurationMs(0);
        setStartSec(0);
        setEndSec(0);
        setPrompt("");
        setSegments([]);
        setAudioSplitMode("manual");
        setAudioRanges([]);
        setDetectingSilence(false);
        segmentsSeededRef.current = false;
        const defaultModel = config.videoModel || config.model || "";
        const initialModel = eligibleModels.includes(defaultModel) ? defaultModel : eligibleModels[0] || defaultModel;
        setModel(initialModel);
        const profile = initialModel ? modelCapabilityConfigFor(config, initialModel).video : undefined;
        setOperation(profile?.operations.includes("extend") ? "extend" : (profile?.operations[0] as CanvasVideoEditOperation | undefined) || "extend");
        const storageKey = node.metadata?.storageKey || "";
        const fallback = node.metadata?.content || "";
        const applyUrl = (url: string) => {
            if (!cancelled) setVideoUrl(url);
        };
        if (resourceIdFromStorageKey(storageKey)) {
            void cacheResourceObjectUrl(storageKey)
                .then((cached) => {
                    if (cancelled) return;
                    if (cached) setVideoUrl(cached);
                    else void resolveMediaUrl(storageKey, fallback).then(applyUrl);
                })
                .catch(() => {
                    if (!cancelled) void resolveMediaUrl(storageKey, fallback).then(applyUrl);
                });
        } else {
            void resolveMediaUrl(storageKey, fallback).then(applyUrl);
        }
        return () => {
            cancelled = true;
        };
    }, [config, eligibleModels, node, open]);

    // 视频模式等待时长元数据就绪后，默认放入一个完整时长的片段。
    useEffect(() => {
        if (!open || mode !== "video" || segmentsSeededRef.current || !durationMs) return;
        segmentsSeededRef.current = true;
        setSegments([{ id: nanoid(), startMs: 0, endMs: durationMs, sourceNodeId: node.id }]);
    }, [durationMs, mode, open]);

    const isVideoMode = mode === "video";
    const durationSec = durationMs > 0 ? durationMs / 1000 : 0;
    const hasTimelineVideoClips = Boolean(timeline?.clips.some((clip) => clip.kind === "video"));
    const videoProfile = useMemo(() => (model ? modelCapabilityConfigFor(config, model).video : undefined), [config, model]);
    const defaultModel = config.videoModel || config.model || "";
    const defaultModelSupported = eligibleModels.includes(defaultModel);
    const hasEligibleModels = eligibleModels.length > 0;
    const firstEligibleModel = eligibleModels[0] || "";

    // 切换模型后保持所选模式仍然有效，优先回退到“视频续写”。
    useEffect(() => {
        if (!videoProfile?.operations.length || videoProfile.operations.includes(operation)) return;
        setOperation(videoProfile.operations.includes("extend") ? "extend" : (videoProfile.operations[0] as CanvasVideoEditOperation));
    }, [operation, videoProfile]);

    const operationOptions = (videoProfile?.operations || []).map((value) => {
        const operation = value as CanvasVideoEditOperation;
        return { value: operation, label: videoOperationLabel(operation) };
    });

    const rangeMs = useMemo(() => {
        const start = Math.max(0, Math.round((startSec || 0) * 1000));
        const end = durationMs > 0 ? Math.min(durationMs, Math.round((endSec || 0) * 1000)) : Math.round((endSec || 0) * 1000);
        return { startMs: start, endMs: Math.max(start, end) };
    }, [durationMs, endSec, startSec]);

    const addManualSegment = () => {
        const last = segments[segments.length - 1];
        const maxEndMs = durationMs || last?.endMs || 0;
        const startMs = last ? Math.min(maxEndMs, last.endMs) : 0;
        const endMs = Math.max(startMs + MIN_SEGMENT_MS, maxEndMs);
        setSegments((current) => [...current, { id: nanoid(), startMs, endMs, sourceNodeId: node.id, prompt: "" }]);
    };

    const importTimelineSegments = () => {
        try {
            const result = buildTimelineImportSegments(node, nodes, connections, timeline, durationMs);
            if (!result.ok) {
                message.warning(result.error);
                return;
            }
            setSegments(result.segments);
            setPrompt((current) => current || `按时间线截取的 ${result.segments.length} 段视频，保持画面主体与镜头，重新生成每一段`);
            message.success(`已从时间线导入 ${result.segments.length} 个片段`);
        } catch (error) {
            console.warn("时间线片段导入失败", error);
            message.warning("读取时间线片段失败，请刷新后重试");
        }
    };

    const updateSegment = (id: string, patch: Partial<Pick<CanvasVideoSegmentItem, "startMs" | "endMs" | "prompt">>) => {
        setSegments((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const removeSegment = (id: string) => {
        setSegments((current) => current.filter((item) => item.id !== id));
    };

    const handleConfirm = () => {
        if (isVideoMode) {
            if (!model) {
                message.warning("请选择视频模型");
                return;
            }
            if (!segments.length) {
                message.warning("请至少添加一个截取片段");
                return;
            }
            for (const segment of segments) {
                if (segment.endMs - segment.startMs < MIN_SEGMENT_MS) {
                    message.warning("片段时长至少 0.1 秒");
                    return;
                }
            }
            onConfirm({
                mode: "video",
                startMs: 0,
                endMs: 0,
                segments: segments.map(({ id, startMs, endMs, prompt: segmentPrompt, timelineClipId, sourceNodeId, sourceStorageKey, sourceUrl }) => ({
                    id,
                    startMs,
                    endMs,
                    prompt: segmentPrompt?.trim(),
                    timelineClipId,
                    sourceNodeId,
                    sourceStorageKey,
                    sourceUrl,
                })),
                model,
                operation,
                prompt: prompt.trim(),
            });
            return;
        }
        if (!durationMs) {
            message.warning("视频时长未就绪，请稍候再试");
            return;
        }
        if (rangeMs.endMs - rangeMs.startMs < MIN_SEGMENT_MS) {
            message.warning("片段时长至少 0.1 秒");
            return;
        }
        const ranges = audioSplitMode === "manual" ? [{ id: nanoid(), startMs: rangeMs.startMs, endMs: rangeMs.endMs, label: "手动片段" }] : audioRanges;
        if (!ranges.length) {
            message.warning(audioSplitMode === "subtitle" ? "当前视频没有可用字幕时间" : "尚未检测到可用声音片段");
            return;
        }
        onConfirm({ mode: "audio", startMs: ranges[0].startMs, endMs: ranges[0].endMs, audioRanges: ranges });
    };

    const selectAudioSplitMode = (value: string | number) => {
        const nextMode = value as "manual" | "silence" | "subtitle";
        setAudioSplitMode(nextMode);
        if (nextMode === "subtitle") {
            const ranges = buildSubtitleAudioRanges(node.metadata?.subtitleEntries || [], durationMs);
            setAudioRanges(ranges);
            if (!ranges.length) message.info("当前视频没有可用字幕时间");
        } else if (nextMode === "manual") {
            setAudioRanges([]);
        }
    };

    const detectSilenceRanges = async () => {
        if (!videoUrl) {
            message.warning("视频仍在加载，请稍候再试");
            return;
        }
        setDetectingSilence(true);
        try {
            const ranges = await detectAudioRangesFromUrl(videoUrl);
            setAudioRanges(ranges);
            if (ranges.length) message.success(`检测到 ${ranges.length} 个声音片段`);
            else message.info("未检测到可用声音片段，可降低静音阈值后重试或改用手动范围");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "静音检测失败");
        } finally {
            setDetectingSilence(false);
        }
    };

    const title = (
        <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                {isVideoMode ? <Scissors className="size-4" /> : <AudioLines className="size-4" />}
            </span>
            <div className="min-w-0">
                <div className="truncate font-semibold leading-6">{isVideoMode ? "片段重拍" : "从视频提取声音"}</div>
                <div className="truncate text-xs opacity-45">{node.title || "视频节点"}</div>
            </div>
        </div>
    );

    return (
        <Modal title={title} open={open} onCancel={onClose} footer={null} width={680} centered destroyOnHidden>
            <div className="space-y-4">
                <div className="flex min-h-0 items-center justify-center overflow-hidden rounded-xl border bg-black" style={{ borderColor: theme.toolbar.border }}>
                    {videoUrl ? (
                        <video
                            ref={videoRef}
                            src={videoUrl}
                            controls
                            playsInline
                            preload="metadata"
                            className="block max-h-[var(--video-segment-preview-max-height)] w-full"
                            onLoadedMetadata={(event) => {
                                const video = event.currentTarget;
                                if (Number.isFinite(video.duration) && video.duration > 0) {
                                    const totalMs = Math.round(video.duration * 1000);
                                    setDurationMs(totalMs);
                                    setEndSec(totalMs / 1000);
                                }
                            }}
                            onError={() => setVideoError(true)}
                        />
                    ) : (
                        <div className="grid h-40 w-full place-items-center text-xs opacity-60">{videoError ? "视频预览加载失败，请检查素材是否仍然可用" : "正在加载视频…"}</div>
                    )}
                </div>

                {isVideoMode ? (
                    <div className="space-y-2.5">
                        {!defaultModelSupported ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs" style={{ background: theme.accent.primarySoft + "1a", borderColor: theme.accent.primarySoft, color: theme.node.muted }}>
                                <span className="min-w-0 flex-1">
                                    {hasEligibleModels
                                        ? `当前默认模型${defaultModel ? `「${modelDisplayName(config, defaultModel)}」` : ""}不支持参考视频，已自动切换到「${modelDisplayName(config, firstEligibleModel)}」。`
                                        : "当前配置中没有支持参考视频的视频模型，请先到设置里配置 Seedance / Agent Plan / NewAPI 渠道。"}
                                </span>
                                {!hasEligibleModels ? (
                                    <Button size="small" type="primary" onClick={() => navigateToSettings({ section: "channels", continueCreation: true })}>
                                        去设置配置渠道
                                    </Button>
                                ) : null}
                            </div>
                        ) : null}

                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm">
                                <span className="opacity-60">时长</span>
                                <span>{durationSec ? formatSegmentTime(durationSec) : "未知"}</span>
                                <span className="opacity-60">已选</span>
                                <span>{segments.length} 段</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button size="small" icon={<Plus className="size-3.5" />} disabled={!durationSec} onClick={addManualSegment}>
                                    添加片段
                                </Button>
                                <Button size="small" icon={<ListVideo className="size-3.5" />} disabled={!hasTimelineVideoClips} onClick={importTimelineSegments}>
                                    从时间线导入
                                </Button>
                            </div>
                        </div>

                        {segments.length ? (
                            <div className="thin-scrollbar max-h-56 space-y-2 overflow-y-auto pr-1">
                                {segments.map((segment, index) => (
                                     <div key={segment.id} className="rounded-lg border px-2.5 py-2" style={{ borderColor: theme.toolbar.border }}>
                                        <div className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
                                            <span className="w-14 shrink-0 text-xs font-medium">片段 {index + 1}</span>
                                            <div className="flex min-w-0 items-center gap-1">
                                                <span className="shrink-0 text-xs opacity-60">起点</span>
                                                <InputNumber
                                                    size="small"
                                                    min={0}
                                                    max={Math.max(0, durationSec - 0.1)}
                                                    step={0.1}
                                                    value={segment.startMs / 1000}
                                                    onChange={(value) => updateSegment(segment.id, { startMs: Math.round((value ?? 0) * 1000) })}
                                                    className="w-full"
                                                    aria-label={`片段 ${index + 1} 起点（秒）`}
                                                />
                                            </div>
                                            <div className="flex min-w-0 items-center gap-1">
                                                <span className="shrink-0 text-xs opacity-60">终点</span>
                                                <InputNumber
                                                    size="small"
                                                    min={0}
                                                    max={Math.max(0, durationSec)}
                                                    step={0.1}
                                                    value={segment.endMs / 1000}
                                                    onChange={(value) => updateSegment(segment.id, { endMs: Math.round((value ?? 0) * 1000) })}
                                                    className="w-full"
                                                    aria-label={`片段 ${index + 1} 终点（秒）`}
                                                />
                                            </div>
                                             <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={`删除片段 ${index + 1}`} onClick={() => removeSegment(segment.id)} />
                                         </div>
                                         <Input.TextArea
                                             className="mt-2"
                                             autoSize={{ minRows: 1, maxRows: 3 }}
                                             value={segment.prompt || ""}
                                             placeholder="该片段独立提示词；留空则使用下方默认提示词"
                                             aria-label={`片段 ${index + 1} 独立提示词`}
                                             onChange={(event) => updateSegment(segment.id, { prompt: event.target.value })}
                                         />
                                     </div>
                                ))}
                            </div>
                        ) : (
                            <div className="rounded-lg border border-dashed px-3 py-3 text-xs opacity-55" style={{ borderColor: theme.toolbar.border }}>
                                还没有片段：手动添加起点/终点，或从时间线导入该节点的已有片段。
                            </div>
                        )}

                        <div className="grid gap-3 md:grid-cols-2">
                            <label className="block min-w-0">
                                <div className="mb-1.5 text-sm font-medium">重生成模型</div>
                                <ModelPicker config={config} value={model} onChange={setModel} capability="video" fullWidth onMissingConfig={() => message.warning("请先配置支持参考视频的视频模型")} />
                            </label>
                            <label className="block min-w-0">
                                <div className="mb-1.5 text-sm font-medium">生成模式</div>
                                <Select className="w-full" size="small" value={operation} options={operationOptions} placeholder="选择生成模式" onChange={(value) => setOperation(value as CanvasVideoEditOperation)} />
                            </label>
                        </div>

                        <label className="block">
                            <div className="mb-1.5 text-sm font-medium">默认提示词</div>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={prompt} placeholder="描述要生成的视频内容，例如：保持画面主体与镜头，重新生成这一段视频" onChange={(event) => setPrompt(event.target.value)} />
                            <div className="mt-1 text-xs opacity-45">片段未填写独立提示词时使用这里的默认提示词。每段都会创建独立结果；从时间线导入的片段生成成功后会自动替换原片段，并保留旧版本。</div>
                        </label>
                    </div>
                ) : (
                    <div className="space-y-3 rounded-lg border px-3 py-3 text-sm" style={{ borderColor: theme.toolbar.border }}>
                        <Segmented
                            block
                            value={audioSplitMode}
                            options={[
                                { label: "手动范围", value: "manual", icon: <AudioLines className="size-3.5" /> },
                                { label: "静音检测", value: "silence", icon: <AudioWaveform className="size-3.5" /> },
                                { label: "按字幕", value: "subtitle", icon: <Captions className="size-3.5" /> },
                            ]}
                            onChange={selectAudioSplitMode}
                        />
                        {audioSplitMode === "manual" ? <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                        <div className="flex items-center gap-2">
                            <span className="opacity-60">时长</span>
                            <span>{durationSec ? formatSegmentTime(durationSec) : "未知"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="opacity-60">起点</span>
                            <InputNumber size="small" min={0} max={Math.max(0, durationSec - 0.1)} step={0.1} value={startSec} onChange={(value) => setStartSec(value ?? 0)} className="w-28" aria-label="片段起点（秒）" />
                            <Button
                                size="small"
                                type="text"
                                icon={<SkipBack className="size-3.5" />}
                                aria-label="跳转到起点"
                                onClick={() => {
                                    if (videoRef.current) videoRef.current.currentTime = startSec;
                                }}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="opacity-60">终点</span>
                            <InputNumber size="small" min={0} max={Math.max(0, durationSec)} step={0.1} value={endSec} onChange={(value) => setEndSec(value ?? 0)} className="w-28" aria-label="片段终点（秒）" />
                            <Button
                                size="small"
                                type="text"
                                icon={<SkipForward className="size-3.5" />}
                                aria-label="跳转到终点"
                                onClick={() => {
                                    if (videoRef.current) videoRef.current.currentTime = endSec;
                                }}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="opacity-60">片段</span>
                            <span>{formatSegmentTime((rangeMs.endMs - rangeMs.startMs) / 1000)}</span>
                        </div>
                        <Button
                            size="small"
                            disabled={!durationSec}
                            onClick={() => {
                                setStartSec(0);
                                setEndSec(durationSec);
                            }}
                        >
                            使用全部
                        </Button>
                        </div> : null}
                        {audioSplitMode === "silence" ? (
                            <div className="flex items-center gap-3">
                                <Button icon={<AudioWaveform className="size-4" />} disabled={!videoUrl} onClick={() => void detectSilenceRanges()}>
                                    检测声音片段
                                </Button>
                                {detectingSilence ? <span className="inline-flex items-center gap-2 text-xs opacity-60"><Spin size="small" />正在本地分析波形</span> : null}
                            </div>
                        ) : null}
                        {audioSplitMode !== "manual" ? <AudioRangeList ranges={audioRanges} onRemove={(id) => setAudioRanges((current) => current.filter((item) => item.id !== id))} /> : null}
                        <div className="text-xs opacity-45">每个范围会独立提取 MP3、保存到素材库，并生成音频节点放在当前视频节点下游。</div>
                    </div>
                )}

                <div className="flex items-center justify-end gap-2">
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" icon={<Check className="size-4" />} disabled={isVideoMode ? !segments.length : !durationSec} onClick={handleConfirm}>
                        {isVideoMode ? (segments.length > 1 ? `截取 ${segments.length} 段并生成` : "截取并生成") : "提取音频"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function AudioRangeList({ ranges, onRemove }: { ranges: CanvasAudioRange[]; onRemove: (id: string) => void }) {
    if (!ranges.length) return <div className="rounded-lg border border-dashed px-3 py-3 text-xs opacity-55">尚无可提取范围</div>;
    return (
        <div className="thin-scrollbar max-h-40 space-y-1.5 overflow-y-auto">
            {ranges.map((range, index) => (
                <div key={range.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                    <span className="w-14 shrink-0 font-medium">片段 {index + 1}</span>
                    <span className="min-w-0 flex-1 truncate opacity-65">{range.label || "声音片段"}</span>
                    <span className="tabular-nums opacity-60">{formatSegmentTime(range.startMs / 1000)} - {formatSegmentTime(range.endMs / 1000)}</span>
                    <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={`移除声音片段 ${index + 1}`} onClick={() => onRemove(range.id)} />
                </div>
            ))}
        </div>
    );
}

function videoOperationLabel(operation: CanvasVideoEditOperation) {
    const labels: Record<CanvasVideoEditOperation, string> = {
        text_to_video: "文生视频",
        image_to_video: "图生视频",
        reference_to_video: "多模态参考生视频",
        h3_context_ir_text: "H3 Context-IR（文本）",
        h3_context_ir_image: "H3 Context-IR（图片）",
        h3_context_ir_reference: "H3 Context-IR（多模态）",
        video_regeneration_task: "视频再生成（任务 ID）",
        video_regeneration_text: "视频再生成（文本）",
        video_regeneration_image: "视频再生成（图片）",
        video_regeneration_reference: "视频再生成（多模态）",
        extend: "视频续写",
        inpaint: "局部修改",
        replace_element: "元素替换",
        camera_motion: "运镜调整",
        style_transfer: "风格迁移",
        audio_to_video: "音频生视频",
        compare_versions: "版本对比",
        concat: "拼接成片",
    };
    return labels[operation] || operation;
}

function formatSegmentTime(seconds: number) {
    const total = Math.max(0, seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rawSeconds = total % 60;
    const secs = rawSeconds % 1 === 0 ? String(Math.floor(rawSeconds)).padStart(2, "0") : rawSeconds.toFixed(1).padStart(4, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
