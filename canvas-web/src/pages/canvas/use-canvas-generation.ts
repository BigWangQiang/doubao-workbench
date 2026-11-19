import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { confirmVideoCancellation } from "@/components/ui/delete-confirmation";
import { applyGenerationTaskResultToNodes, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-sync";
import { recoverableGenerationTaskIds } from "@/lib/canvas/canvas-generation-recovery";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { cancelGenerationTask, listGenerationTasks, listTaskLogs, queryGenerationTask, waitForGenerationTask, type GenerationTask, type TaskLog } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { cinematicStoryboardColumns, storyboardRowsFromTask } from "@/lib/canvas/canvas-project-domain";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { generationFailureMetadata } from "@/lib/generation-error";

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

type UseCanvasGenerationOptions = {
    projectId: string;
    domainProjectId?: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function useCanvasGeneration({ projectId, domainProjectId, projectLoaded, nodes, nodesRef, setNodes }: UseCanvasGenerationOptions) {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const recoveringTaskIdsRef = useRef(new Set<string>());
    const locallySubmittedTaskIdsRef = useRef(new Set<string>());
    const autoRecoveredTaskIdsRef = useRef(new Set<string>());
    const autoSavedTaskIdsRef = useRef(new Set<string>());
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [taskDetail, setTaskDetail] = useState<GenerationTask | null>(null);
    const [taskDetailLogs, setTaskDetailLogs] = useState<TaskLog[]>([]);
    const [taskDetailLoading, setTaskDetailLoading] = useState(false);

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((current) => current.map((node) => affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node));
    }, [setNodes]);

    const confirmStopGeneration = useCallback((nodeId: string) => {
        const targetIds = new Set([nodeId]);
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId === nodeId) targetIds.add(request.targetNodeId);
        });
        // 文本或配置节点也能发起视频生成，提示须按实际目标判断。
        const isVideo = nodesRef.current.some((node) => targetIds.has(node.id) && (node.type === CanvasNodeType.Video || node.metadata?.generationMode === "video"));
        if (isVideo) {
            confirmVideoCancellation(modal, {
                title: "取消视频生成？",
                description: "视频请求可能已提交到上游，取消后仍可能扣费，取消不代表退款。实际费用以上游处理结果和最终结算为准；已经生成完成的内容会保留。",
                onConfirm: () => stopGenerationByRunningId(nodeId),
            });
            return;
        }
        modal.confirm({
            title: "停止生成？",
            content: "当前生成请求会被中断，已经生成完成的内容会保留。",
            okText: "停止",
            cancelText: "继续生成",
            okButtonProps: { danger: true },
            onOk: () => stopGenerationByRunningId(nodeId),
        });
    }, [modal, nodesRef, stopGenerationByRunningId]);

    const cancelNodeTask = useCallback((node: CanvasNodeData) => {
        const taskId = node.metadata?.taskId;
        if (!taskId) {
            confirmStopGeneration(node.id);
            return;
        }
        const isVideo = node.type === CanvasNodeType.Video || node.metadata?.generationMode === "video";
        const cancelTask = async () => {
            try {
                const task = await cancelGenerationTask(taskId);
                // 取消失败时保留原等待通道，避免用户无法继续接收结果。
                generationRequestsRef.current.get(node.id)?.controller.abort();
                setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, ...generationTaskMetadata(task), status: NODE_STATUS_ERROR, errorDetails: "任务已取消" } } : item));
                message.success("任务已取消");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "任务取消失败");
                throw error;
            }
        };
        if (isVideo) {
            confirmVideoCancellation(modal, {
                title: "取消视频生成任务？",
                description: "任务已提交后台。若上游已受理，取消后仍可能扣费，取消不代表退款。实际费用以上游处理结果和最终结算为准；已生成完成的内容仍会保留。",
                onConfirm: cancelTask,
            });
            return;
        }
        modal.confirm({
            title: "取消后台任务？",
            content: "任务会在后端停止，已生成完成的内容仍会保留。",
            okText: "取消任务",
            cancelText: "继续生成",
            okButtonProps: { danger: true },
            onOk: cancelTask,
        });
    }, [confirmStopGeneration, message, modal, setNodes]);

    const openNodeTaskDetails = useCallback(async (node: CanvasNodeData) => {
        const taskId = node.metadata?.taskId;
        if (!taskId) return;
        setTaskDetailLoading(true);
        setTaskDetailLogs([]);
        setTaskDetail({
            id: taskId,
            type: "",
            status: (node.metadata?.taskStatus as GenerationTask["status"]) || "running",
            stage: node.metadata?.taskStage,
            progress: node.metadata?.taskProgress,
            prompt: node.metadata?.prompt || "",
            attempts: 1,
            createdAt: node.metadata?.taskCreatedAt || new Date().toISOString(),
            updatedAt: node.metadata?.taskUpdatedAt || new Date().toISOString(),
        });
        try {
            const [task, logs] = await Promise.all([queryGenerationTask(taskId), listTaskLogs(taskId)]);
            setTaskDetail(task);
            setTaskDetailLogs(logs);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务详情加载失败");
        } finally {
            setTaskDetailLoading(false);
        }
    }, [message]);

    const updateGenerationTaskBinding = useCallback((targetNodeId: string, task: GenerationTask) => {
        setNodes((current) => current.map((node) => {
            if (node.id !== targetNodeId) return node;
            const failed = task.status === "failed" || task.status === "cancelled";
            const hasCompletedContent = task.status === "succeeded" && Boolean(node.metadata?.content);
            const failure = failed
                ? generationFailureMetadata(task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败"), node.metadata?.composerContent || node.metadata?.prompt || task.prompt || "")
                : undefined;
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    ...generationTaskMetadata(task),
                    status: failed ? NODE_STATUS_ERROR : hasCompletedContent ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                    ...(failure || { errorDetails: undefined, generationErrorCode: undefined, failedPromptFingerprint: undefined }),
                },
            };
        }));
    }, [setNodes]);

    const bindGenerationTask = useCallback((targetNodeId: string, task: GenerationTask) => {
        locallySubmittedTaskIdsRef.current.add(task.id);
        updateGenerationTaskBinding(targetNodeId, task);
    }, [updateGenerationTaskBinding]);

    const saveGeneratedAsset = useCallback(async (node: CanvasNodeData, taskId: string) => {
        const result = await ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, node, source: "canvas-generation", taskId });
        setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, assetId: result.assetId } } : item));
        if (domainProjectId) await queryClient.invalidateQueries({ queryKey: ["project", domainProjectId] });
    }, [domainProjectId, projectId, queryClient, setNodes]);

    const applyGenerationTaskResult = useCallback(async (nodeId: string, task: GenerationTask) => {
        const applied = await applyGenerationTaskResultToNodes(nodesRef.current, task, nodeId);
        if (!applied.updated || !applied.node) throw new Error("画布中找不到对应任务节点");
        setNodes((current) => current.map((node) => node.id === applied.nodeId ? applied.node! : node));
    }, [nodesRef, setNodes]);

    const recoverGenerationTask = useCallback(async (node: CanvasNodeData, initialTask?: GenerationTask) => {
        const taskId = initialTask?.id || node.metadata?.taskId;
        if (!taskId) {
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "此节点缺少任务编号，请先核对任务记录，避免重复生成。" } } : item));
            return;
        }
        // 刷新时的网络/下载失败不代表任务不存在；凭已保存编号进入同一条查询恢复流程。
        const task: GenerationTask = initialTask || {
            id: taskId, projectId, type: `canvas_${node.type}`, status: "running",
            prompt: node.metadata?.prompt || "", attempts: 1, continuePolling: true,
            providerRequestId: taskId, stage: "正在恢复原任务", progress: node.metadata?.taskProgress,
            createdAt: node.metadata?.taskCreatedAt || new Date().toISOString(),
            updatedAt: node.metadata?.taskUpdatedAt || new Date().toISOString(),
        };
        if (recoveringTaskIdsRef.current.has(task.id)) return;
        recoveringTaskIdsRef.current.add(task.id);
        updateGenerationTaskBinding(node.id, task);
        try {
            const completed = task.status === "succeeded" ? task : await waitForGenerationTask(task.id, { initialTask: task, onTaskUpdate: (update) => updateGenerationTaskBinding(node.id, update) });
            if (node.type === CanvasNodeType.Script && completed.type === "agent_storyboard_rows") {
                const result = storyboardRowsFromTask(completed);
                setNodes((current) => current.map((item) => item.id === node.id ? { ...item, title: result.title || item.title, metadata: { ...item.metadata, ...generationTaskMetadata(completed), status: NODE_STATUS_SUCCESS, errorDetails: undefined, generationErrorCode: undefined, failedPromptFingerprint: undefined, storyboard: { rows: result.rows, visibleColumns: cinematicStoryboardColumns(item.metadata?.storyboard?.visibleColumns), referenceNodeIds: item.metadata?.storyboard?.referenceNodeIds || [] } } } : item));
            } else {
                await applyGenerationTaskResult(node.id, completed);
            }
        } catch (error) {
            const failure = generationFailureMetadata(error, node.metadata?.composerContent || node.metadata?.prompt || task.prompt || "");
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item));
        } finally {
            recoveringTaskIdsRef.current.delete(task.id);
        }
    }, [applyGenerationTaskResult, projectId, setNodes, updateGenerationTaskBinding]);

    const recoverInterruptedGenerationTasks = useCallback(async () => {
        const recoveryNodes = nodesRef.current.filter((node) => {
            const aggregateBatchRoot = node.metadata?.isBatchRoot && node.metadata.batchChildIds?.length && !node.metadata.taskId;
            if (aggregateBatchRoot) return false;
            return node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.errorDetails === "页面刷新后生成已中断，请重新生成。" || Boolean(node.metadata?.taskId && node.metadata.status !== NODE_STATUS_SUCCESS);
        });
        const taskIds = Array.from(new Set(recoveryNodes.map((node) => node.metadata?.taskId).filter((id): id is string => Boolean(id))));
        taskIds.forEach((taskId) => autoRecoveredTaskIdsRef.current.add(taskId));
        const tasks = (await Promise.all(taskIds.map((id) => queryGenerationTask(id).catch(() => undefined)))).filter((task): task is GenerationTask => Boolean(task));
        if (recoveryNodes.some((node) => !node.metadata?.taskId)) {
            const recentTasks = await listGenerationTasks(30, { projectId }).catch(() => []);
            tasks.push(...recentTasks.filter((task) => !tasks.some((item) => item.id === task.id)));
        }
        const projectTasks = tasks.filter((task) => task.projectId === projectId && (task.type.startsWith("canvas_") || task.type === "agent_storyboard_rows"));
        await Promise.all(recoveryNodes.map(async (node) => {
            let task = projectTasks.find((item) => item.id === node.metadata?.taskId) || projectTasks.find((item) => generationTaskNodeId(item) === node.id);
            if (!task && node.metadata?.taskId) task = await queryGenerationTask(node.metadata.taskId).catch(() => undefined);
            await recoverGenerationTask(node, task);
        }));
        setNodes((current) => current.map((node) => {
            if (!node.metadata?.isBatchRoot || !node.metadata.batchChildIds?.length || node.metadata.taskId) return node;
            const children = node.metadata.batchChildIds.map((id) => current.find((item) => item.id === id)).filter(Boolean) as CanvasNodeData[];
            const primary = children.find((item) => item.id === node.metadata?.primaryImageId && item.metadata?.content) || children.find((item) => item.metadata?.content);
            const loading = children.some((item) => item.metadata?.status === NODE_STATUS_LOADING);
            const failed = children.find((item) => item.metadata?.status === NODE_STATUS_ERROR);
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    ...(primary ? {
                        content: primary.metadata?.content,
                        storageKey: primary.metadata?.storageKey,
                        mimeType: primary.metadata?.mimeType,
                        bytes: primary.metadata?.bytes,
                        naturalWidth: primary.metadata?.naturalWidth,
                        naturalHeight: primary.metadata?.naturalHeight,
                        primaryImageId: primary.id,
                    } : {}),
                    status: primary ? NODE_STATUS_SUCCESS : loading ? NODE_STATUS_LOADING : NODE_STATUS_ERROR,
                    errorDetails: primary ? undefined : failed?.metadata?.errorDetails || "全部图片生成失败",
                },
            };
        }));
    }, [nodesRef, projectId, recoverGenerationTask, setNodes]);

    useEffect(() => {
        if (!projectLoaded) return;
        void recoverInterruptedGenerationTasks();
    }, [projectLoaded, recoverInterruptedGenerationTasks]);

    useEffect(() => {
        if (!projectLoaded) return;
        const ignoredTaskIds = new Set([...locallySubmittedTaskIdsRef.current, ...autoRecoveredTaskIdsRef.current]);
        recoverableGenerationTaskIds(nodes, ignoredTaskIds).forEach((taskId) => {
            const node = nodes.find((item) => item.metadata?.taskId === taskId);
            if (!node) return;
            autoRecoveredTaskIdsRef.current.add(taskId);
            void recoverGenerationTask(node);
        });
    }, [nodes, projectLoaded, recoverGenerationTask]);

    useEffect(() => {
        if (!projectLoaded) return;
        nodes.forEach((node) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.content || node.metadata.status !== NODE_STATUS_SUCCESS || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio)) return;
            const saveKey = `${taskId}:${node.id}:${domainProjectId || "personal"}`;
            if (autoSavedTaskIdsRef.current.has(saveKey)) return;
            autoSavedTaskIdsRef.current.add(saveKey);
            void saveGeneratedAsset(node, taskId).catch((error) => {
                autoSavedTaskIdsRef.current.delete(saveKey);
                message.warning(error instanceof Error ? `生成结果已保留，但项目资产同步失败：${error.message}` : "生成结果已保留，但项目资产同步失败");
            });
        });
    }, [domainProjectId, message, nodes, projectLoaded, saveGeneratedAsset]);

    return {
        bindGenerationTask,
        cancelNodeTask,
        confirmStopGeneration,
        finishGenerationRequest,
        openNodeTaskDetails,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail,
        taskDetailLoading,
        taskDetailLogs,
    };
}
