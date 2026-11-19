import { resourceIdFromStorageKey } from "@/services/api/resources";
import type { LibraryPayload } from "@/services/api/library";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

// 模板只携带创作内容和归档资源，不复制模型渠道、会话、任务或运行状态。
export function createLibraryTemplate(nodes: CanvasNodeData[], connections: CanvasConnection[]): LibraryPayload {
    if (!nodes.length || nodes.length > 1000) throw new Error("模板需要 1–1000 个节点");
    const copied = nodes.map((node): CanvasNodeData => {
        if (!["text", "image", "video", "audio", "frame"].includes(node.type)) throw new Error("当前模板支持图片、视频、音频、文本和分组，请先移除其他类型节点");
        const source = node.metadata || {};
        const metadata: CanvasNodeMetadata = {
            prompt: source.prompt, aspectRatio: source.aspectRatio, resolution: source.resolution,
            seconds: source.seconds, durationSeconds: source.durationSeconds, vquality: source.vquality,
            generateAudio: source.generateAudio, fontSize: source.fontSize, status: "idle",
        };
        if (node.type === "text") metadata.content = source.content || "";
        if (node.type === "frame") metadata.frame = source.frame;
        if (["image", "video", "audio"].includes(node.type)) {
            const id = resourceIdFromStorageKey(source.storageKey);
            if (source.content && !id) throw new Error(`「${node.title || "素材"}」尚未归档，请等待画布保存后再试`);
            if (id) {
                metadata.storageKey = `resource:${id}`;
                metadata.content = metadata.storageKey;
                metadata.status = "success";
                metadata.naturalWidth = source.naturalWidth;
                metadata.naturalHeight = source.naturalHeight;
                metadata.durationMs = source.durationMs;
            }
        }
        return { id: node.id, type: node.type, title: node.title, position: { ...node.position }, width: node.width, height: node.height, parentId: node.parentId, metadata };
    });
    const ids = new Set(copied.map((node) => node.id));
    return { nodes: copied, connections: connections.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)).map((edge) => ({ ...edge })) };
}
