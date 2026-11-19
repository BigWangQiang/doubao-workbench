import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, InputNumber, Modal, Slider } from "antd";
import { Check, RotateCcw, X } from "lucide-react";

import { formatVideoFrameTime } from "@/lib/canvas/canvas-video-frame-analysis";
import type { VideoSourceDimensions, VideoSubtitleRegion } from "@/lib/canvas/canvas-video-segment";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasVideoSubtitleRemovalParams = {
    region: VideoSubtitleRegion;
    dimensions: VideoSourceDimensions;
};

type ResizeHandle = "nw" | "ne" | "se" | "sw";

const DEFAULT_REGION: VideoSubtitleRegion = { x: 0.08, y: 0.72, width: 0.84, height: 0.18 };
const MIN_REGION_SIZE = 0.03;
const resizeHandles: ResizeHandle[] = ["nw", "ne", "se", "sw"];

export function CanvasVideoSubtitleRemovalDialog({
    node,
    open,
    processing,
    onClose,
    onConfirm,
}: {
    node: CanvasNodeData | null;
    open: boolean;
    processing: boolean;
    onClose: () => void;
    onConfirm: (params: CanvasVideoSubtitleRemovalParams) => void;
}) {
    const previewRef = useRef<HTMLVideoElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const [region, setRegion] = useState<VideoSubtitleRegion>(DEFAULT_REGION);
    const [dimensions, setDimensions] = useState<VideoSourceDimensions | null>(null);
    const [durationSeconds, setDurationSeconds] = useState(0);
    const [previewTime, setPreviewTime] = useState(0);

    useEffect(() => {
        if (!open) return;
        setRegion(DEFAULT_REGION);
        setDimensions(null);
        setDurationSeconds(0);
        setPreviewTime(0);
    }, [node?.id, open]);

    const loadMetadata = () => {
        const video = previewRef.current;
        if (!video) return;
        const width = video.videoWidth || node?.metadata?.naturalWidth || 0;
        const height = video.videoHeight || node?.metadata?.naturalHeight || 0;
        if (width > 0 && height > 0) setDimensions({ width, height });
        const duration = Number.isFinite(video.duration) ? video.duration : Math.max(0, (node?.metadata?.durationMs || 0) / 1000);
        setDurationSeconds(duration);
        const initialTime = Math.min(duration, Math.max(0, duration / 2));
        video.currentTime = initialTime;
        setPreviewTime(initialTime);
    };

    const seekPreview = (value: number) => {
        const next = Math.max(0, Math.min(durationSeconds, value));
        setPreviewTime(next);
        if (previewRef.current) previewRef.current.currentTime = next;
    };

    const startMove = (event: ReactPointerEvent) => {
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        event.preventDefault();
        event.stopPropagation();
        const start = { x: event.clientX, y: event.clientY, region };
        trackPointer(
            (pointer) => {
                const dx = (pointer.clientX - start.x) / box.width;
                const dy = (pointer.clientY - start.y) / box.height;
                setRegion({
                    ...start.region,
                    x: clamp(start.region.x + dx, 0, 1 - start.region.width),
                    y: clamp(start.region.y + dy, 0, 1 - start.region.height),
                });
            },
        );
    };

    const startResize = (handle: ResizeHandle, event: ReactPointerEvent) => {
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        event.preventDefault();
        event.stopPropagation();
        const start = { x: event.clientX, y: event.clientY, region };
        trackPointer((pointer) => {
            const dx = (pointer.clientX - start.x) / box.width;
            const dy = (pointer.clientY - start.y) / box.height;
            setRegion(resizeRegion(start.region, handle, dx, dy));
        });
    };

    const regionPixels = dimensions
        ? `${Math.round(region.width * dimensions.width)} x ${Math.round(region.height * dimensions.height)}`
        : "读取中";

    return (
        <Modal
            title={node ? `框选去字幕 · ${node.title || "视频"}` : "框选去字幕"}
            open={open && Boolean(node?.metadata?.content)}
            width="min(920px, calc(100vw - 32px))"
            centered
            destroyOnHidden
            maskClosable={!processing}
            closable={!processing}
            onCancel={onClose}
            footer={[
                <Button key="reset" icon={<RotateCcw className="size-4" />} disabled={processing} onClick={() => setRegion(DEFAULT_REGION)}>重置区域</Button>,
                <Button key="cancel" icon={<X className="size-4" />} disabled={processing} onClick={onClose}>取消</Button>,
                <Button key="confirm" type="primary" icon={<Check className="size-4" />} loading={processing} disabled={!dimensions} onClick={() => dimensions && onConfirm({ region, dimensions })}>开始去字幕</Button>,
            ]}
        >
            <div className="space-y-4" data-canvas-no-zoom>
                <div className="flex justify-center overflow-hidden rounded-lg bg-black">
                    <div ref={boxRef} className="relative inline-block max-w-full select-none">
                        {node?.metadata?.content ? (
                            <video
                                ref={previewRef}
                                src={node.metadata.content}
                                preload="metadata"
                                muted
                                playsInline
                                className="block max-w-full"
                                style={{ maxHeight: "62vh" }}
                                onLoadedMetadata={loadMetadata}
                            />
                        ) : null}
                        <div className="pointer-events-none absolute inset-0 bg-black/20" />
                        <div
                            className="absolute cursor-move border-2 border-white bg-white/5 shadow-lg"
                            style={regionStyle(region)}
                            onPointerDown={startMove}
                        >
                            {resizeHandles.map((handle) => (
                                <button
                                    key={handle}
                                    type="button"
                                    className="absolute grid size-6 place-items-center rounded-full outline-none focus-visible:ring-2"
                                    style={handleStyle(handle)}
                                    aria-label={`调整去字幕区域${handleLabel(handle)}`}
                                    onPointerDown={(event) => startResize(handle, event)}
                                ><span className="size-3 rounded-full border border-black bg-white" /></button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <span className="shrink-0 text-sm font-medium">预览时间</span>
                    <div className="min-w-0 flex-1"><Slider min={0} max={Math.max(0.1, durationSeconds)} step={0.1} value={previewTime} disabled={!durationSeconds || processing} tooltip={{ formatter: (value) => formatVideoFrameTime(Number(value || 0)) }} onChange={seekPreview} /></div>
                    <span className="shrink-0 text-sm tabular-nums opacity-60">{formatVideoFrameTime(previewTime)}</span>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <RegionNumber label="左边界" value={region.x} max={1 - region.width} disabled={processing} onChange={(x) => setRegion((current) => ({ ...current, x }))} />
                    <RegionNumber label="上边界" value={region.y} max={1 - region.height} disabled={processing} onChange={(y) => setRegion((current) => ({ ...current, y }))} />
                    <RegionNumber label="区域宽度" value={region.width} min={MIN_REGION_SIZE} max={1 - region.x} disabled={processing} onChange={(width) => setRegion((current) => ({ ...current, width }))} />
                    <RegionNumber label="区域高度" value={region.height} min={MIN_REGION_SIZE} max={1 - region.y} disabled={processing} onChange={(height) => setRegion((current) => ({ ...current, height }))} />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                    <span>区域 {regionPixels}</span>
                    {dimensions ? <span className="opacity-60">视频 {dimensions.width} x {dimensions.height}</span> : null}
                </div>
            </div>
        </Modal>
    );
}

function RegionNumber({ label, value, min = 0, max, disabled, onChange }: { label: string; value: number; min?: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
    return (
        <label className="grid gap-1 text-xs">
            <span className="font-medium opacity-60">{label}</span>
            <InputNumber
                className="w-full"
                min={Math.round(min * 100)}
                max={Math.round(max * 100)}
                step={1}
                precision={0}
                value={Math.round(value * 100)}
                addonAfter="%"
                disabled={disabled}
                onChange={(next) => onChange(clamp(Number(next || 0) / 100, min, max))}
            />
        </label>
    );
}

function trackPointer(onMove: (event: PointerEvent) => void) {
    const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
}

function resizeRegion(region: VideoSubtitleRegion, handle: ResizeHandle, dx: number, dy: number): VideoSubtitleRegion {
    const right = region.x + region.width;
    const bottom = region.y + region.height;
    const x = handle.includes("w") ? clamp(region.x + dx, 0, right - MIN_REGION_SIZE) : region.x;
    const y = handle.includes("n") ? clamp(region.y + dy, 0, bottom - MIN_REGION_SIZE) : region.y;
    const nextRight = handle.includes("e") ? clamp(right + dx, x + MIN_REGION_SIZE, 1) : right;
    const nextBottom = handle.includes("s") ? clamp(bottom + dy, y + MIN_REGION_SIZE, 1) : bottom;
    return { x, y, width: nextRight - x, height: nextBottom - y };
}

function regionStyle(region: VideoSubtitleRegion) {
    return {
        left: `${region.x * 100}%`,
        top: `${region.y * 100}%`,
        width: `${region.width * 100}%`,
        height: `${region.height * 100}%`,
    };
}

function handleStyle(handle: ResizeHandle) {
    return {
        top: handle.includes("n") ? "-12px" : "calc(100% - 12px)",
        left: handle.includes("w") ? "-12px" : "calc(100% - 12px)",
        cursor: `${handle}-resize`,
    };
}

function handleLabel(handle: ResizeHandle) {
    if (handle === "nw") return "左上角";
    if (handle === "ne") return "右上角";
    if (handle === "se") return "右下角";
    return "左下角";
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
