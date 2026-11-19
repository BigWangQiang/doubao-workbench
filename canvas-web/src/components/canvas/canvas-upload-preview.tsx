import { useCallback, useSyncExternalStore } from "react";
import { AlertCircle, Upload } from "lucide-react";

import type { canvasThemes } from "@/lib/canvas-theme";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { getCanvasMediaUpload, subscribeCanvasMediaUpload } from "@/services/canvas-media-upload";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { CanvasVideoPreviewImage } from "./canvas-video-preview-image";

export function CanvasUploadPreview({ node, theme, onResize, onReplace }: {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onResize?: (id: string, width: number, height: number, position?: Position) => void;
    onReplace?: (node: CanvasNodeData) => void;
}) {
    const uploadId = node.metadata?.mediaUploadId || "";
    const userId = useUserStore((state) => state.user?.id || "guest");
    const subscribe = useCallback((listener: () => void) => subscribeCanvasMediaUpload(uploadId, listener), [uploadId, userId]);
    const snapshot = useCallback(() => getCanvasMediaUpload(uploadId), [uploadId, userId]);
    const upload = useSyncExternalStore(subscribe, snapshot, () => undefined);
    const failed = !upload || upload.status === "failed";
    const percent = upload?.progress || 0;
    const label = failed ? "上传未完成，请重新上传" : upload?.status === "saving" ? "文件已传输，服务器保存中" : upload?.status === "ready" ? "已保存，正在更新节点" : `正在上传 ${percent}%`;
    const alignImage = (width: number, height: number) => {
        if (!onResize || node.metadata?.locked || node.metadata?.freeResize || !width || !height) return;
        const bounds = node.type === CanvasNodeType.Video ? VIDEO_NODE_MAX_SIZE : undefined;
        const size = fitNodeSize(width, height, bounds?.width, bounds?.height);
        onResize(node.id, size.width, size.height, { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 });
    };
    return (
        <div className="relative size-full overflow-hidden rounded-[var(--node-radius)]" aria-busy={!failed}>
            {upload?.previewUrl ? node.type === CanvasNodeType.Video ? (
                <CanvasVideoPreviewImage node={{ ...node, metadata: { content: upload.previewUrl } }} eager alt={node.title} className="size-full object-contain" onLoad={(event) => alignImage(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
            ) : (
                <img src={upload.previewUrl} alt={node.title} draggable={false} className="pointer-events-none size-full object-contain" onLoad={(event) => alignImage(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
            ) : null}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 backdrop-blur-md transition-opacity motion-reduce:transition-none" style={{ opacity: failed ? 1 : Math.max(0.15, 1 - percent / 100), background: `color-mix(in srgb, ${theme.toolbar.panel} 35%, transparent)` }} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
                <div className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2 text-xs" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: failed ? theme.accent.danger : theme.node.text }}>
                    <span className="flex items-center gap-2" role="status">{failed ? <AlertCircle aria-hidden="true" className="size-4 shrink-0" /> : <Upload aria-hidden="true" className="size-4 shrink-0" />}<span>{label}</span></span>
                    {!failed ? <div role="progressbar" aria-label="文件传输进度" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={label} className="h-1 overflow-hidden rounded-full" style={{ background: theme.node.stroke }}><div className="h-full origin-left rounded-full transition-transform motion-reduce:transition-none" style={{ background: theme.accent.primary, transform: `scaleX(${percent / 100})` }} /></div> : null}
                    {failed && onReplace ? <button type="button" data-canvas-no-zoom className="pointer-events-auto min-h-9 rounded-md border px-3 text-xs" style={{ borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onReplace(node); }}>重新选择文件</button> : null}
                </div>
            </div>
        </div>
    );
}
