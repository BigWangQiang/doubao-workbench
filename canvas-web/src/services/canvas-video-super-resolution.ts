import { getMediaBlob } from "@/services/file-storage";
import { importResourceFromUrl, isResourceUrl, resourceIdFromStorageKey, resourceIdFromUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { submitBackendGenerationTask } from "@/services/api/generation-task";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceVideo } from "@/types/media";
import { inspectSuperResolutionResource } from "@/services/api/video-super-resolution";

export type PreparedSuperResolutionSource = { reference: ReferenceVideo; frameRate: number; content: string; storageKey?: string };
export type VideoSuperResolutionSelection = { model: string; resolution: string; fps: number; source: PreparedSuperResolutionSource };

export async function inspectSuperResolutionSource(node: CanvasNodeData, reference: ReferenceVideo): Promise<PreparedSuperResolutionSource> {
    const resourceId = resourceIdFromStorageKey(reference.storageKey);
    if (!resourceId) throw new Error("原视频资源尚未就绪，请重新上传");
    const metadata = await inspectSuperResolutionResource(resourceId);
    if (!Number.isFinite(metadata.frameRate) || metadata.frameRate <= 0 || metadata.durationMs <= 0) throw new Error("无法确认原视频帧率与时长，请重新上传");
    return { reference: { ...reference, durationMs: metadata.durationMs, width: metadata.width, height: metadata.height }, frameRate: metadata.frameRate, content: node.metadata!.content!, storageKey: node.metadata?.storageKey };
}

// 超分仅接受平台资源键，服务端据此校验归属并探测真实时长后计费。
export async function prepareSuperResolutionSource(node: CanvasNodeData): Promise<ReferenceVideo> {
    const meta = node.metadata;
    if (node.type !== CanvasNodeType.Video || !meta?.content) throw new Error("请先选择一个有内容的视频节点");
    let id = resourceIdFromStorageKey(meta.storageKey);
    if (!id && isResourceUrl(meta.content)) id = resourceIdFromUrl(meta.content);
    if (!id) {
        const cached = meta.storageKey ? await getMediaBlob(meta.storageKey) : null;
        if (cached) {
            id = (await uploadResourceFile(cached, "video", { fileName: node.title || "原视频.mp4" })).id;
        } else if (/^https?:\/\//i.test(meta.content)) {
            id = (await importResourceFromUrl(meta.content, "video")).id;
        } else if (/^(blob:|data:video\/)/i.test(meta.content)) {
            const response = await fetch(meta.content);
            if (!response.ok) throw new Error("原视频读取失败，请重新上传");
            const blob = await response.blob();
            if (!blob.type.startsWith("video/")) throw new Error("原素材不是有效的视频文件");
            id = (await uploadResourceFile(blob, "video", { fileName: node.title || "原视频.mp4" })).id;
        }
    }
    if (!id) throw new Error("原视频尚未保存到平台，请重新上传后再超分");
    return {
        id: node.id,
        name: node.title || "原视频",
        type: meta.mimeType || "video/mp4",
        storageKey: resourceStorageKey(id),
        url: "",
        width: meta.naturalWidth,
        height: meta.naturalHeight,
        durationMs: meta.durationMs,
    };
}

export async function submitCanvasVideoSuperResolution(options: {
    projectId: string;
    resultNodeId: string;
    source: CanvasNodeData;
    config: AiConfig;
    selection: VideoSuperResolutionSelection;
}) {
    const { projectId, resultNodeId, source, config, selection } = options;
    const channel = resolveModelChannel(config, selection.model);
    const request = resolveModelRequestConfig(config, selection.model);
    if (!projectId || !resultNodeId || channel.scope !== "system" || channel.enabled === false || request.interfaceType !== "tencent-mps-video") {
        throw new Error("请选择已启用的 Lalor 视频超分模型");
    }
    const capability = modelCapabilityConfigFor(config, selection.model)?.video;
    if (!capability?.resolutions.includes(selection.resolution)) throw new Error("所选超分分辨率不可用，请重新选择");
    if (!Number.isInteger(selection.fps) || selection.fps < 0 || selection.fps > 120) throw new Error("请选择有效的输出帧率");
    if (selection.source.reference.id !== source.id || selection.source.content !== source.metadata?.content || selection.source.storageKey !== source.metadata?.storageKey) throw new Error("原视频已变化，请重新打开超分窗口");
    const reference = selection.source.reference;
    return submitBackendGenerationTask({
        projectId,
        mode: "video",
        // 用于任务列表的操作名称，腾讯 ProcessMedia 不接收该提示词。
        prompt: "视频超分",
        config: { ...config, model: selection.model, videoModel: selection.model, vquality: selection.resolution, size: "adaptive", count: "1", videoSeconds: String(Math.max(1, Math.ceil((reference.durationMs || 0) / 1000))) },
        referenceVideos: [reference],
        metadata: { nodeId: resultNodeId, sourceNodeId: source.id, videoEditOperation: "reference_to_video", edit: "superResolution", superResolutionFps: selection.fps },
    });
}
