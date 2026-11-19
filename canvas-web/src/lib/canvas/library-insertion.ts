import { nanoid } from "nanoid";
import type { LibraryPayload } from "@/services/api/library";
import type { Asset } from "@/stores/use-asset-store";
import type { InsertAssetPayload } from "@/types/asset-insertion";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";

export function personalAssetPayload(asset: Asset): InsertAssetPayload | null {
    if (asset.kind === "text") return { kind: "text", title: asset.title, content: asset.data.content, assetId: asset.id };
    if (asset.kind === "image") return { kind: "image", title: asset.title, dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, assetId: asset.id };
    if (asset.kind === "video" || asset.kind === "audio") return { ...asset.data, kind: asset.kind, title: asset.title, assetId: asset.id };
    return null;
}

export function libraryAssetPayload(asset: InsertAssetPayload): InsertAssetPayload {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return asset;
    const id = resourceIdFromStorageKey(asset.storageKey);
    if (!id) throw new Error("素材尚未归档，请联系管理员重新导入");
    return asset.kind === "image" ? { ...asset, dataUrl: resourceFileUrl(id) } : { ...asset, url: resourceFileUrl(id) };
}

// 每次插入生成独立节点与连线编号，不继承来源任务或自动触发生成。
export function instantiateLibraryTemplate(payload: LibraryPayload, center: { x: number; y: number }) {
    if (!payload.nodes?.length) throw new Error("模板没有可插入的节点");
    const mapping = new Map(payload.nodes.map((n) => [n.id, nanoid()]));
    const minX = Math.min(...payload.nodes.map((n) => n.position.x));
    const minY = Math.min(...payload.nodes.map((n) => n.position.y));
    const maxX = Math.max(...payload.nodes.map((n) => n.position.x + n.width));
    const maxY = Math.max(...payload.nodes.map((n) => n.position.y + n.height));
    const nodes = structuredClone(payload.nodes).map((node) => {
        const metadata = { ...node.metadata };
        const id = resourceIdFromStorageKey(metadata.storageKey);
        if (id && ["image", "video", "audio"].includes(node.type)) metadata.content = resourceFileUrl(id);
        const previewId = resourceIdFromStorageKey(metadata.videoPreview?.storageKey);
        if (previewId) metadata.videoPreview = { ...metadata.videoPreview, content: resourceFileUrl(previewId) };
        if (metadata.referenceAssetNodeIds) metadata.referenceAssetNodeIds = metadata.referenceAssetNodeIds.flatMap((id) => mapping.has(id) ? [mapping.get(id)!] : []);
        metadata.status = id ? "success" : "idle";
        delete metadata.generationBatches;
        delete metadata.errorDetails;
        return { ...node, id: mapping.get(node.id)!, parentId: node.parentId ? mapping.get(node.parentId) : undefined, position: { x: node.position.x + center.x - (minX + maxX) / 2, y: node.position.y + center.y - (minY + maxY) / 2 }, metadata };
    });
    const connections = (payload.connections || []).filter((c) => mapping.has(c.fromNodeId) && mapping.has(c.toNodeId)).map((c) => ({ ...c, id: nanoid(), fromNodeId: mapping.get(c.fromNodeId)!, toNodeId: mapping.get(c.toNodeId)! }));
    return { nodes, connections };
}
