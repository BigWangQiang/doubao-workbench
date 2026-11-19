import { useEffect, useRef, useState, type MouseEvent } from "react";
import { App } from "antd";
import { ImagePlus, LoaderCircle, X } from "lucide-react";

import { localizeErrorMessage } from "@/lib/generation-error";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { nanoid } from "nanoid";

type FrameSlot = "start" | "end";

type CanvasVideoFramePickerProps = {
    metadata?: CanvasNodeMetadata;
    onMetadataChange: (patch: Partial<CanvasNodeMetadata>) => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

type FrameData = {
    id?: string;
    url?: string;
    storageKey?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

export function CanvasVideoFramePicker({ open, onOpenChange }: Pick<CanvasVideoFramePickerProps, "open" | "onOpenChange">) {
    return (
        <button type="button" className={`canvas-node-studio-tool-pill${open ? " is-active" : ""}`} aria-label="打开首尾帧设置" aria-expanded={open} onClick={() => onOpenChange(!open)}>
            <ImagePlus />
            <span>首尾帧</span>
        </button>
    );
}

export function CanvasVideoFrameSlots({ metadata, onMetadataChange }: Pick<CanvasVideoFramePickerProps, "metadata" | "onMetadataChange">) {
    return (
        <div
            className="canvas-video-frame-slots"
            data-canvas-no-zoom
            role="group"
            aria-label="视频首尾帧上传"
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <FrameUploadCard label="首图" hint="视频开始画面" slot="start" metadata={metadata} onMetadataChange={onMetadataChange} />
            <FrameUploadCard label="尾图" hint="视频结束画面" slot="end" metadata={metadata} onMetadataChange={onMetadataChange} />
        </div>
    );
}

function FrameUploadCard({ label, hint, slot, metadata, onMetadataChange }: Pick<CanvasVideoFramePickerProps, "metadata" | "onMetadataChange"> & { label: string; hint: string; slot: FrameSlot }) {
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const frame = readFrameData(metadata, slot);
    const [previewUrl, setPreviewUrl] = useState(frame.url || "");

    useEffect(() => {
        let cancelled = false;
        setPreviewUrl(frame.url || "");
        if (!frame.storageKey) return;
        void resolveImageUrl(frame.storageKey, frame.url || "").then((resolved) => {
            if (!cancelled && resolved) setPreviewUrl(resolved);
        });
        return () => {
            cancelled = true;
        };
    }, [frame.storageKey, frame.url]);

    const selectFile = () => {
        if (!uploading) inputRef.current?.click();
    };

    const handleFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        setUploading(true);
        try {
            const uploaded = await uploadImage(file);
            const id = `video-frame-${slot}-${nanoid(8)}`;
            onMetadataChange(framePatch(slot, {
                id,
                url: uploaded.url,
                storageKey: uploaded.storageKey,
                width: uploaded.width,
                height: uploaded.height,
                bytes: uploaded.bytes,
                mimeType: uploaded.mimeType,
            }));
        } catch (error) {
            // 上传失败时保留原有首尾帧，避免一次失败清空可用配置，同时给出中文反馈。
            message.error(localizeErrorMessage(error, "首尾帧上传失败，请重试"));
        } finally {
            setUploading(false);
        }
    };

    const clear = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onMetadataChange(framePatch(slot, undefined));
    };

    return (
        <div className={`canvas-video-frame-card${previewUrl ? " has-preview" : ""}`}>
            <button type="button" className="canvas-video-frame-card-main" onClick={selectFile} aria-label={previewUrl ? `替换${label}` : `上传${label}`}>
                {previewUrl ? <img src={previewUrl} alt={`${label}预览`} className="canvas-video-frame-preview" /> : <span className="canvas-video-frame-empty"><ImagePlus /></span>}
                <span className="canvas-video-frame-copy">
                    <strong>{label}</strong>
                    <small>{uploading ? "上传中…" : previewUrl ? "点击替换" : hint}</small>
                </span>
                {uploading ? <LoaderCircle className="canvas-video-frame-loading" aria-hidden /> : null}
            </button>
            {previewUrl ? <button type="button" className="canvas-video-frame-remove" onClick={clear} aria-label={`移除${label}`} title={`移除${label}`}><X /></button> : null}
            <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="canvas-video-frame-input"
                tabIndex={-1}
                onChange={(event) => {
                    void handleFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                }}
            />
        </div>
    );
}

function readFrameData(metadata: CanvasNodeMetadata | undefined, slot: FrameSlot): FrameData {
    if (slot === "start") {
        return {
            id: metadata?.videoStartFrameImageId,
            url: metadata?.videoStartFrameUrl,
            storageKey: metadata?.videoStartFrameStorageKey,
            width: metadata?.videoStartFrameWidth,
            height: metadata?.videoStartFrameHeight,
            bytes: metadata?.videoStartFrameBytes,
            mimeType: metadata?.videoStartFrameMimeType,
        };
    }
    return {
        id: metadata?.videoEndFrameImageId,
        url: metadata?.videoEndFrameUrl,
        storageKey: metadata?.videoEndFrameStorageKey,
        width: metadata?.videoEndFrameWidth,
        height: metadata?.videoEndFrameHeight,
        bytes: metadata?.videoEndFrameBytes,
        mimeType: metadata?.videoEndFrameMimeType,
    };
}

function framePatch(slot: FrameSlot, frame: FrameData | undefined): Partial<CanvasNodeMetadata> {
    const prefix = slot === "start" ? "videoStartFrame" : "videoEndFrame";
    if (!frame) {
        return {
            [`${prefix}ImageId`]: undefined,
            [`${prefix}StorageKey`]: undefined,
            [`${prefix}Url`]: undefined,
            [`${prefix}Width`]: undefined,
            [`${prefix}Height`]: undefined,
            [`${prefix}Bytes`]: undefined,
            [`${prefix}MimeType`]: undefined,
            [slot === "start" ? "videoStartFrameNodeId" : "videoEndFrameNodeId"]: undefined,
        } as Partial<CanvasNodeMetadata>;
    }
    return {
        [`${prefix}ImageId`]: frame.id,
        [`${prefix}StorageKey`]: frame.storageKey,
        [`${prefix}Url`]: frame.url,
        [`${prefix}Width`]: frame.width,
        [`${prefix}Height`]: frame.height,
        [`${prefix}Bytes`]: frame.bytes,
        [`${prefix}MimeType`]: frame.mimeType,
        [slot === "start" ? "videoStartFrameNodeId" : "videoEndFrameNodeId"]: frame.id,
    } as Partial<CanvasNodeMetadata>;
}
