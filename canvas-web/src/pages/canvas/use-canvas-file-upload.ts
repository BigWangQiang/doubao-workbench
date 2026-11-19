import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { getActiveUserScope } from "@/lib/user-scope";
import { startCanvasMediaUpload, releaseCanvasMediaUpload } from "@/services/canvas-media-upload";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";
import type { StartCanvasUploadStatus } from "./use-canvas-upload";

type Options = {
    canvasId: string;
    domainProjectId?: string;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    selectInsertedNode: (id: string, dialog: "open" | "close" | "preserve") => void;
    persistMediaNode: (node: CanvasNodeData) => Promise<boolean>;
    startUploadStatus: StartCanvasUploadStatus;
};

export function useCanvasFileUpload({ canvasId, domainProjectId, nodesRef, setNodes, selectInsertedNode, persistMediaNode, startUploadStatus }: Options) {
    const { message } = App.useApp();
    const userId = useUserStore((state) => state.user?.id || "guest");
    const owned = useRef(new Map<string, string>());
    const session = useMemo(() => ({ active: true, userScope: getActiveUserScope() }), [canvasId, userId]);
    useEffect(() => {
        session.active = true;
        return () => {
            session.active = false;
            owned.current.forEach((uploadId) => releaseCanvasMediaUpload(uploadId));
            owned.current.clear();
        };
    }, [session]);
    useEffect(() => {
        // React 提交完成后才释放预览；虚拟化卸载节点不能取消真实上传。
        owned.current.forEach((uploadId, nodeId) => {
            if (nodesRef.current.some((node) => node.id === nodeId && node.metadata?.mediaUploadId === uploadId)) return;
            releaseCanvasMediaUpload(uploadId);
            owned.current.delete(nodeId);
        });
    });

    return useCallback(async (file: File, position: Position, existingNode?: CanvasNodeData) => {
        if (!session.active || session.userScope !== getActiveUserScope()) return null;
        const isImage = file.type.startsWith("image/");
        const type = isImage ? CanvasNodeType.Image : CanvasNodeType.Video;
        const label = isImage ? "图片" : "视频";
        const operation = existingNode ? "替换" : "上传";
        const progress = startUploadStatus(`${operation}${label}`, "上传文件，完成后即可用于生成", domainProjectId ? 4 : 3);
        const userScope = getActiveUserScope();
        const id = existingNode?.id || `${type}-${nanoid()}`;
        const previousUpload = owned.current.get(id);
        if (previousUpload) releaseCanvasMediaUpload(previousUpload);
        const upload = startCanvasMediaUpload(file);
        owned.current.set(id, upload.id);
        const size = NODE_DEFAULT_SIZE[type];
        const previewNode: CanvasNodeData = {
            ...(existingNode || { id, position: { x: position.x - size.width / 2, y: position.y - size.height / 2 }, width: size.width, height: size.height }),
            type,
            title: file.name,
            metadata: {
                ...existingNode?.metadata,
                content: undefined,
                storageKey: undefined,
                videoPreview: undefined,
                previewContent: undefined,
                mediaUploadId: upload.id,
                assetId: undefined,
                taskId: undefined,
                status: "idle",
                mimeType: file.type,
                bytes: file.size,
                naturalWidth: undefined,
                naturalHeight: undefined,
                durationMs: undefined,
                errorDetails: undefined,
                ...(isImage ? resetImageReplacement() : {}),
            },
        };
        const previewNodes = existingNode ? nodesRef.current.map((node) => node.id === id ? previewNode : node) : [...nodesRef.current, previewNode];
        nodesRef.current = previewNodes;
        setNodes(previewNodes);
        selectInsertedNode(id, "open");
        try {
            progress.update("上传文件并等待服务器保存", 2);
            const media = await upload.result;
            // 删除、再次替换、切换画布或切换账号后，旧上传不能覆盖新节点。
            if (!session.active || userScope !== getActiveUserScope() || owned.current.get(id) !== upload.id) return null;
            const currentNode = nodesRef.current.find((node) => node.id === id && node.metadata?.mediaUploadId === upload.id);
            if (!currentNode) return null;
            const bounds = isImage ? undefined : VIDEO_NODE_MAX_SIZE;
            const fitted = fitNodeSize(media.width || size.width, media.height || size.height, bounds?.width, bounds?.height);
            const node: CanvasNodeData = {
                ...currentNode,
                ...(!existingNode && !currentNode.metadata?.locked ? { width: fitted.width, height: fitted.height, position: { x: currentNode.position.x + currentNode.width / 2 - fitted.width / 2, y: currentNode.position.y + currentNode.height / 2 - fitted.height / 2 } } : {}),
                metadata: {
                    ...currentNode.metadata,
                    content: media.url,
                    storageKey: media.storageKey,
                    naturalWidth: media.width,
                    naturalHeight: media.height,
                    durationMs: 'durationMs' in media ? media.durationMs : undefined,
                    mimeType: media.mimeType,
                    bytes: media.bytes,
                    mediaUploadId: undefined,
                    status: "success",
                    errorDetails: undefined,
                    generationErrorCode: undefined,
                    failedPromptFingerprint: undefined,
                },
            };
            progress.update("更新画布节点", 3);
            const completedNodes = nodesRef.current.map((item) => item.id === id && item.metadata?.mediaUploadId === upload.id ? node : item);
            nodesRef.current = completedNodes;
            setNodes(completedNodes);
            if (domainProjectId) progress.update("写入项目资产", 4);
            const persisted = await persistMediaNode(node);
            if (!session.active || userScope !== getActiveUserScope()) return null;
            progress.done(persisted ? `${label}已${existingNode ? "替换" : "添加到画布"}` : `${label}已保存，项目资产同步待重试`);
            return id;
        } catch (error) {
            if (!session.active || owned.current.get(id) !== upload.id || userScope !== getActiveUserScope()) return null;
            const details = error instanceof Error ? error.message : `${label}上传失败`;
            setNodes((current) => current.map((item) => item.id === id && item.metadata?.mediaUploadId === upload.id ? { ...item, metadata: { ...item.metadata, status: "error", errorDetails: details } } : item));
            progress.fail(details);
            message.error(details);
            return null;
        }
    }, [domainProjectId, message, nodesRef, persistMediaNode, selectInsertedNode, session, setNodes, startUploadStatus]);
}

function resetImageReplacement(): Partial<CanvasNodeMetadata> {
    return {
        freeResize: false, isBatchRoot: undefined, batchRootId: undefined, batchChildIds: undefined,
        batchUsesReferenceImages: undefined, generationType: undefined, model: undefined, size: undefined,
        quality: undefined, transparentBackground: undefined, count: undefined, references: undefined,
        primaryImageId: undefined, imageBatchExpanded: undefined,
    };
}
