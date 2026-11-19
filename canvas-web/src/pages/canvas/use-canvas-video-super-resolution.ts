import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { generationErrorMessage } from "@/lib/generation-error";
import { submitCanvasVideoSuperResolution, type VideoSuperResolutionSelection } from "@/services/canvas-video-super-resolution";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export function useCanvasVideoSuperResolution({ projectId, nodesRef, setNodes, setConnections, setSelectedNodeIds }: {
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
}) {
    const config = useEffectiveConfig();
    const { message } = App.useApp();
    const submittingRef = useRef(false);
    const [submitting, setSubmitting] = useState(false);

    const submit = async (source: CanvasNodeData, selection: VideoSuperResolutionSelection) => {
        if (submittingRef.current) return false;
        const currentSource = nodesRef.current.find((node) => node.id === source.id);
        if (!currentSource?.metadata?.content) {
            message.error("原视频已删除或尚未就绪");
            return false;
        }
        submittingRef.current = true;
        setSubmitting(true);
        const id = nanoid();
        const result: CanvasNodeData = {
            id, type: CanvasNodeType.Video,
            title: `超分 ${selection.resolution.toUpperCase()} · ${currentSource.title || "视频"}`,
            position: { x: currentSource.position.x + currentSource.width + 96, y: currentSource.position.y },
            width: currentSource.width, height: currentSource.height,
            metadata: { status: "loading", taskStage: "正在准备超分原视频", generationMode: "video", videoEditOperation: "reference_to_video", model: selection.model, vquality: selection.resolution, size: "adaptive" },
        };
        setNodes((nodes) => [...nodes, result]);
        setConnections((connections) => [...connections, { id: nanoid(), fromNodeId: source.id, toNodeId: id }]);
        setSelectedNodeIds(new Set([id]));
        try {
            const task = await submitCanvasVideoSuperResolution({ projectId, resultNodeId: id, source: currentSource, config, selection });
            // 交给现有画布任务恢复器统一轮询、落库与同步素材；关闭弹窗不取消服务端任务。
            setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(task) } } : node));
            message.success("超分任务已提交，结果会回到右侧视频节点");
            return true;
        } catch (error) {
            const details = generationErrorMessage(error);
            setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: details } } : node));
            message.error(details);
            return false;
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    return { submit, submitting };
}
