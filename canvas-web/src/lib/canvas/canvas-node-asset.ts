import { getDataUrlByteSize } from "@/lib/image-utils";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import type { Asset, AssetCategory, NewAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

export type CanvasAssetSource = "canvas-generation" | "canvas-upload" | "canvas-manual";

type CanvasNodeAssetOptions = {
    canvasId: string;
    source: CanvasAssetSource;
    taskId?: string;
};

/**
 * Build a canvas node directly from a library asset.
 *
 * This intentionally does not resolve or upload resources: callers that need
 * a storage key hydrated should do that before calling this pure mapper.
 */
export function assetToCanvasNode(asset: Asset, position: Position, id: string): CanvasNodeData | null {
    const status = "success" as const;
    const sourceMetadata = asset.metadata || {};
    const baseMetadata = {
        status,
        assetId: asset.id,
        assetTags: asset.tags || [],
        assetCategory: asset.category,
        prompt: typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : asset.title,
        // Generated assets carry their creation context in the asset record.
        // Keep the typed fields on the canvas node so the node inspector and
        // future "reuse generation" actions do not lose that context.
        taskId: typeof sourceMetadata.taskId === "string" ? sourceMetadata.taskId : undefined,
        messageId: typeof sourceMetadata.messageId === "string" ? sourceMetadata.messageId : undefined,
        conversationId: typeof sourceMetadata.conversationId === "string" ? sourceMetadata.conversationId : undefined,
        resultIndex: numberMetadata(sourceMetadata.resultIndex),
        model: typeof sourceMetadata.model === "string" ? sourceMetadata.model : undefined,
        modelName: typeof sourceMetadata.modelName === "string" ? sourceMetadata.modelName : undefined,
        aspectRatio: typeof sourceMetadata.aspectRatio === "string" ? sourceMetadata.aspectRatio : undefined,
        size: typeof sourceMetadata.size === "string" ? sourceMetadata.size : undefined,
        resolution: typeof sourceMetadata.resolution === "string" ? sourceMetadata.resolution : undefined,
        quality: typeof sourceMetadata.quality === "string" ? sourceMetadata.quality : undefined,
        videoQuality: typeof sourceMetadata.videoQuality === "string" ? sourceMetadata.videoQuality : undefined,
        durationSeconds: typeof sourceMetadata.durationSeconds === "string" ? sourceMetadata.durationSeconds : undefined,
    };

    if (asset.kind === "text") {
        const content = asset.data.content.trim();
        if (!content) return null;
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        return {
            id,
            type: CanvasNodeType.Text,
            title: asset.title || spec.title,
            position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
            width: spec.width,
            height: spec.height,
            metadata: { ...baseMetadata, content },
        };
    }

    if (asset.kind === "image") {
        const content = asset.data.dataUrl || asset.coverUrl;
        if (!content) return null;
        const size = fitNodeSize(asset.data.width || NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, asset.data.height || NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
        return {
            id,
            type: CanvasNodeType.Image,
            title: asset.title || "素材图片",
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            ...size,
            metadata: {
                ...baseMetadata,
                generationMode: "image",
                content,
                storageKey: asset.data.storageKey,
                naturalWidth: asset.data.width,
                naturalHeight: asset.data.height,
                bytes: asset.data.bytes || getDataUrlByteSize(content.startsWith("data:") ? content : ""),
                mimeType: asset.data.mimeType || "image/png",
            },
        };
    }

    if (asset.kind === "video") {
        if (!asset.data.url) return null;
        // 生成结果可能只有公网 URL，尚未回填视频元数据。此时必须沿用画布
        // 视频节点的 16:9 默认尺寸；使用 VIDEO_NODE_MAX_SIZE 的 480×480
        // 会把导入的视频错误地创建成方形节点，播放器下方出现大块黑底。
        const size = fitNodeSize(
            asset.data.width || NODE_DEFAULT_SIZE[CanvasNodeType.Video].width,
            asset.data.height || NODE_DEFAULT_SIZE[CanvasNodeType.Video].height,
            VIDEO_NODE_MAX_SIZE.width,
            VIDEO_NODE_MAX_SIZE.height,
        );
        return {
            id,
            type: CanvasNodeType.Video,
            title: asset.title || "素材视频",
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            ...size,
            metadata: { ...baseMetadata, generationMode: "video", content: asset.data.url, storageKey: asset.data.storageKey, naturalWidth: asset.data.width, naturalHeight: asset.data.height, durationMs: asset.data.durationMs, bytes: asset.data.bytes, mimeType: asset.data.mimeType || "video/mp4" },
        };
    }

    if (asset.kind === "audio") {
        if (!asset.data.url) return null;
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        return {
            id,
            type: CanvasNodeType.Audio,
            title: asset.title || "素材音频",
            position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
            width: spec.width,
            height: spec.height,
            metadata: { ...baseMetadata, content: asset.data.url, storageKey: asset.data.storageKey, durationMs: asset.data.durationMs, bytes: asset.data.bytes, mimeType: asset.data.mimeType || "audio/mpeg" },
        };
    }

    return null;
}

function numberMetadata(value: unknown) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function canvasNodeToAsset(node: CanvasNodeData, options: CanvasNodeAssetOptions): NewAsset | null {
    const content = node.metadata?.content?.trim();
    if (!content) return null;
    const title = node.metadata?.prompt?.slice(0, 24) || node.title || canvasAssetFallbackTitle(node.type);
    const metadata = {
        source: options.source,
        canvasId: options.canvasId,
        nodeId: node.id,
        taskId: options.taskId || node.metadata?.taskId,
        prompt: node.metadata?.prompt,
        resourceKey: node.metadata?.storageKey,
        generatedAt: options.source === "canvas-generation" ? node.metadata?.taskCompletedAt || node.metadata?.taskCreatedAt : undefined,
    };
    const base = {
        title,
        coverUrl: node.type === CanvasNodeType.Image ? content : "",
        tags: node.metadata?.assetTags || [],
        category: canvasNodeAssetCategory(node),
        status: "confirmed" as const,
        source: "Canvas",
        createdAt: metadata.generatedAt,
        metadata,
    };

    if (node.type === CanvasNodeType.Text) {
        return { ...base, kind: "text", data: { content } };
    }
    if (node.type === CanvasNodeType.Image) {
        const dataUrl = node.metadata?.storageKey ? "" : content;
        return {
            ...base,
            kind: "image",
            data: {
                dataUrl,
                storageKey: node.metadata?.storageKey,
                width: node.metadata?.naturalWidth || node.width,
                height: node.metadata?.naturalHeight || node.height,
                bytes: node.metadata?.bytes || getDataUrlByteSize(dataUrl),
                mimeType: node.metadata?.mimeType || "image/png",
            },
        };
    }
    if (node.type === CanvasNodeType.Video) {
        return {
            ...base,
            kind: "video",
            data: {
                url: content,
                storageKey: node.metadata?.storageKey,
                width: node.metadata?.naturalWidth || node.width,
                height: node.metadata?.naturalHeight || node.height,
                durationMs: node.metadata?.durationMs,
                bytes: node.metadata?.bytes || 0,
                mimeType: node.metadata?.mimeType || "video/mp4",
            },
        };
    }
    if (node.type === CanvasNodeType.Audio) {
        return {
            ...base,
            kind: "audio",
            data: {
                url: content,
                storageKey: node.metadata?.storageKey,
                durationMs: node.metadata?.durationMs,
                bytes: node.metadata?.bytes || 0,
                mimeType: node.metadata?.mimeType || "audio/mpeg",
            },
        };
    }
    return null;
}

export function findCanvasNodeAsset(assets: Asset[], node: CanvasNodeData, canvasId: string, taskId?: string) {
    const explicitId = node.metadata?.assetId;
    if (explicitId) {
        const explicit = assets.find((asset) => asset.id === explicitId);
        if (explicit && sameAssetResource(explicit, node)) return explicit;
    }
    const generationTaskId = taskId || node.metadata?.taskId;
    return assets.find((asset) => {
        if (generationTaskId && asset.metadata?.taskId === generationTaskId && asset.metadata?.nodeId === node.id) return true;
        if (asset.metadata?.nodeId !== node.id) return false;
        const sourceCanvasId = asset.metadata?.canvasId;
        if (sourceCanvasId !== canvasId && (sourceCanvasId || asset.metadata?.source !== "canvas-generation")) return false;
        const nodeResourceKey = node.metadata?.storageKey;
        const assetResourceKey = typeof asset.metadata?.resourceKey === "string" ? asset.metadata.resourceKey : assetStorageKey(asset);
        return !nodeResourceKey || !assetResourceKey || nodeResourceKey === assetResourceKey;
    });
}

function sameAssetResource(asset: Asset, node: CanvasNodeData) {
    const nodeResourceKey = node.metadata?.storageKey;
    const assetResourceKey = typeof asset.metadata?.resourceKey === "string" ? asset.metadata.resourceKey : assetStorageKey(asset);
    return !nodeResourceKey || !assetResourceKey || nodeResourceKey === assetResourceKey;
}

function assetStorageKey(asset: Asset) {
    if (asset.kind === "text" || asset.kind === "entity") return undefined;
    return asset.data.storageKey;
}

export function declaredCanvasNodeAssetCategory(node: CanvasNodeData): AssetCategory | undefined {
    if (node.metadata?.assetCategory) return node.metadata.assetCategory;
    if (node.metadata?.workflowKind === "character") return "character";
    if (node.metadata?.workflowKind === "scene") return "environment";
    if (node.metadata?.workflowKind === "styleboard") return "style";
    return undefined;
}

export function canvasNodeAssetCategory(node: CanvasNodeData): AssetCategory {
    const declared = declaredCanvasNodeAssetCategory(node);
    if (declared) return declared;
    return "other";
}

function canvasAssetFallbackTitle(type: CanvasNodeType) {
    if (type === CanvasNodeType.Image) return "画布图片";
    if (type === CanvasNodeType.Video) return "画布视频";
    if (type === CanvasNodeType.Audio) return "画布音频";
    return "画布文本";
}
