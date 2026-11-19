import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { CanvasResourceReference } from "./canvas-resource-references";

// 替换限定在目标节点，原素材变化后旧结果自动失效，不能覆盖其他节点的图片。
export function canvasColoredPencilImage(image: ReferenceImage, overrides: CanvasNodeMetadata["coloredPencilReferences"]): ReferenceImage {
    const replacement = overrides?.[image.id];
    if (!replacement || !image.storageKey || replacement.originalStorageKey !== image.storageKey || !resourceIdFromStorageKey(replacement.storageKey)) return image;
    return { ...image, storageKey: replacement.storageKey, type: replacement.type, width: replacement.width, height: replacement.height, bytes: replacement.bytes, dataUrl: "", url: undefined, source: undefined };
}

export function canvasColoredPencilReferences(references: CanvasResourceReference[], overrides: CanvasNodeMetadata["coloredPencilReferences"]) {
    return references.map((reference) => {
        if (!reference.active || reference.kind !== "image") return reference;
        const replacement = overrides?.[reference.nodeId];
        const resourceId = replacement && resourceIdFromStorageKey(replacement.storageKey);
        if (!replacement || !resourceId || replacement.originalStorageKey !== reference.storageKey) return reference;
        return { ...reference, storageKey: replacement.storageKey, previewUrl: resourceFileUrl(resourceId) };
    });
}
