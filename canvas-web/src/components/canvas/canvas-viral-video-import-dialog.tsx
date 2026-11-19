import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Segmented } from "antd";
import { Clapperboard, Link2, Upload, Video } from "lucide-react";

import { formatBytes } from "@/lib/image-utils";
import { importPlatformVideoUrl, resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { GenerationCostIndicator } from "@/components/generation-cost-indicator";
import { estimateViralVideoGeneration } from "@/lib/canvas/canvas-viral-video-pricing";
import { resolveViralVideoAnalysisModel, VIRAL_VIDEO_ANALYSIS_CREDITS, VIRAL_VIDEO_ANALYSIS_MODEL_LABEL } from "@/lib/canvas/canvas-viral-video-policy";
import { useEffectiveConfig } from "@/stores/use-config-store";

type ImportMode = "link" | "file";

type CanvasViralVideoImportDialogProps = {
    open: boolean;
    onClose: () => void;
    onCreateReferenceVideo: (video: UploadedFile, title: string, sourceUrl?: string, platform?: string) => Promise<void>;
};

export function CanvasViralVideoImportDialog({ open, onClose, onCreateReferenceVideo }: CanvasViralVideoImportDialogProps) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [mode, setMode] = useState<ImportMode>("link");
    const [url, setUrl] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [dragActive, setDragActive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (open) return;
        setMode("link");
        setUrl("");
        setFile(null);
        setDragActive(false);
        setError("");
        setBusy(false);
    }, [open]);

    const selectVideoFile = (candidate?: File) => {
        if (!candidate) return;
        if (!candidate.type.startsWith("video/")) {
            setFile(null);
            setError("请选择有效的视频文件");
            return;
        }
        setFile(candidate);
        setError("");
    };

    const submit = async () => {
        if (busy) return;
        setError("");
        if (!resolveViralVideoAnalysisModel(config)) {
            setError(`${VIRAL_VIDEO_ANALYSIS_MODEL_LABEL} 系统模型不可用，请联系管理员`);
            return;
        }
        if (mode === "link" && !url.trim()) {
            setError("请粘贴公开视频链接");
            return;
        }
        if (mode === "file" && !file) {
            setError("请选择本地视频文件");
            return;
        }
        setBusy(true);
        try {
            if (mode === "link") {
                const result = await importPlatformVideoUrl(url.trim());
                const resource = result.resource;
                await onCreateReferenceVideo({
                    url: resourceFileUrl(resource.id),
                    storageKey: resourceStorageKey(resource.id),
                    bytes: resource.size,
                    mimeType: resource.mimeType || "video/mp4",
                    width: resource.width,
                    height: resource.height,
                    durationMs: resource.durationMs,
                }, result.title || `${result.platform}公开视频`, result.sourceUrl, result.platform);
            } else if (file) {
                if (!file.type.startsWith("video/")) throw new Error("请选择有效的视频文件");
                const video = await uploadMediaFile(file, "video");
                await onCreateReferenceVideo(video, file.name);
            }
            message.success("视频已添加，正在建立复刻分析方案");
            onClose();
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : "视频导入失败，请检查链接或文件后重试");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title="爆款视频复刻"
            open={open}
            onCancel={onClose}
            destroyOnHidden
            width="min(540px, calc(100vw - 32px))"
            styles={{ body: { paddingTop: 16 } }}
            footer={[
                <Button key="cancel" disabled={busy} onClick={onClose}>取消</Button>,
                <Button key="submit" type="primary" icon={<Clapperboard className="size-4" />} loading={busy} disabled={busy || (mode === "link" ? !url.trim() : !file)} onClick={() => void submit()}>
                    导入并分析
                </Button>,
            ]}
        >
            <div className="space-y-4">
                <Segmented
                    block
                    value={mode}
                    disabled={busy}
                    onChange={(value) => {
                        setMode(value as ImportMode);
                        setError("");
                    }}
                    options={[
                        { value: "link", label: <span className="inline-flex items-center gap-2"><Link2 className="size-4" />平台链接</span> },
                        { value: "file", label: <span className="inline-flex items-center gap-2"><Upload className="size-4" />本地视频</span> },
                    ]}
                    aria-label="选择视频导入方式"
                />

                {mode === "link" ? (
                    <div>
                        <label htmlFor="canvas-viral-video-url" className="mb-2 block text-sm font-medium">视频链接或分享文案</label>
                        <Input
                            id="canvas-viral-video-url"
                            autoFocus
                            autoComplete="url"
                            inputMode="url"
                            value={url}
                            disabled={busy}
                            status={error ? "error" : undefined}
                            aria-invalid={Boolean(error)}
                            aria-describedby={error ? "canvas-viral-video-error" : undefined}
                            placeholder="粘贴链接，或“复制打开抖音…”整段分享文案"
                            onChange={(event) => {
                                setUrl(event.target.value);
                                if (error) setError("");
                            }}
                        />
                        <p className="mt-2 text-sm opacity-65">支持 Bilibili、抖音、TikTok 和小红书公开链接</p>
                    </div>
                ) : (
                    <div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="video/*"
                            className="sr-only"
                            aria-label="选择本地视频文件"
                            onChange={(event) => {
                                selectVideoFile(event.target.files?.[0]);
                                event.target.value = "";
                            }}
                        />
                        <button
                            type="button"
                            disabled={busy}
                            aria-invalid={Boolean(error)}
                            aria-describedby={error ? "canvas-viral-video-error" : undefined}
                            onClick={() => fileInputRef.current?.click()}
                            onDragEnter={(event) => {
                                event.preventDefault();
                                if (!busy) setDragActive(true);
                            }}
                            onDragOver={(event) => {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "copy";
                            }}
                            onDragLeave={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
                            }}
                            onDrop={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setDragActive(false);
                                selectVideoFile(event.dataTransfer.files[0]);
                            }}
                            className={`flex min-h-36 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-5 py-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25 disabled:cursor-wait disabled:opacity-60 ${error && !dragActive ? "border-red-500/60 bg-red-500/[.035]" : dragActive ? "border-foreground/55 bg-foreground/[.07]" : "border-border bg-foreground/[.025] hover:border-foreground/35 hover:bg-foreground/[.05]"}`}
                        >
                            <span className={`grid size-10 place-items-center rounded-full ${file ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-foreground/[.06] text-foreground/55"}`}>
                                {file ? <Video className="size-5" /> : <Upload className="size-5" />}
                            </span>
                            <span className="block min-w-0 max-w-full">
                                <span className="block text-sm font-medium">{dragActive ? "松开鼠标导入视频" : file ? "视频已就绪" : "拖放视频到这里，或点击选择"}</span>
                                {file ? (
                                    <span className="mt-1 flex min-w-0 items-center justify-center gap-1 text-xs text-foreground/55">
                                        <span className="max-w-full truncate">{file.name}</span>
                                        {formatBytes(file.size) ? <span className="shrink-0">· {formatBytes(file.size)}</span> : null}
                                    </span>
                                ) : (
                                    <span className="mt-1 block text-xs text-foreground/45">自动反推提示词、分镜表与可替换资产</span>
                                )}
                            </span>
                            {file ? <span className="text-xs text-foreground/40">点击更换视频</span> : null}
                        </button>
                    </div>
                )}

                <div className="space-y-2 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center gap-3"><span className="text-sm">视频分析模型</span><span className="text-sm font-medium">{VIRAL_VIDEO_ANALYSIS_MODEL_LABEL}</span><span className="text-xs text-foreground/55">已固定</span><GenerationCostIndicator estimate={estimateViralVideoGeneration(config, "text", [])} /></div>
                    <p className="text-xs text-foreground/55">每次反推固定 {VIRAL_VIDEO_ANALYSIS_CREDITS} 积分。导入后提交 1 个视觉分析任务，图片和视频生成在确认后另行计费。</p>
                </div>
                {error ? <p id="canvas-viral-video-error" role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            </div>
        </Modal>
    );
}
