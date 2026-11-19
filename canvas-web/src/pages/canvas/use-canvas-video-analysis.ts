import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { createVideoAnalysisArtifacts, parseVideoAnalysis, videoAnalysisBusy } from "@/lib/canvas/canvas-video-analysis";
import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { videoNodeSize } from "@/lib/canvas/canvas-node-size";
import { localizeErrorMessage } from "@/lib/generation-error";
import { getActiveUserScope } from "@/lib/user-scope";
import { prepareVideoAnalysis, recoverVideoAnalysisTask, submitVideoAnalysis, validateVideoAnalysisModel } from "@/services/canvas-video-analysis";
import { queryGenerationTask } from "@/services/api/task-center";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { uploadMediaFile } from "@/services/file-storage";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { VideoAnalysisWorkflow } from "@/types/canvas-video-analysis";

type Options = {
    projectId: string;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
};

export function useCanvasVideoAnalysis({ projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds }: Options) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const userScope = getActiveUserScope();
    const active = useRef(new Map<string, AbortController>());
    const scope = useRef(projectId);
    scope.current = projectId;
    const commit = useCallback((next: CanvasNodeData[], connections = connectionsRef.current) => {
        if (scope.current !== projectId || getActiveUserScope() !== userScope) return;
        nodesRef.current = next;
        connectionsRef.current = connections;
        useCanvasStore.getState().updateProject(projectId, { nodes: next, connections });
        setNodes(next);
        setConnections(connections);
    }, [connectionsRef, nodesRef, projectId, setConnections, setNodes, userScope]);
    const patch = useCallback((id: string, changes: Partial<VideoAnalysisWorkflow>) => {
        commit(nodesRef.current.map((node) => node.id === id && node.metadata?.videoAnalysis ? { ...node, metadata: { ...node.metadata, videoAnalysis: { ...node.metadata.videoAnalysis, ...changes } } } : node));
    }, [commit, nodesRef]);

    const create = useCallback((source: CanvasNodeData) => {
        if (source.type !== CanvasNodeType.Video || (!source.metadata?.content && !source.metadata?.storageKey)) { message.error("请先选择有内容的视频节点"); return; }
        const existing = nodesRef.current.find((node) => node.metadata?.videoAnalysis?.sourceNodeId === source.id);
        if (existing) { setSelectedNodeIds(new Set([existing.id])); return; }
        const node = createCanvasNode(CanvasNodeType.Text, source.position, {
            videoAnalysis: { version: 1, sourceNodeId: source.id, stage: "idle", model: config.model || "", inputMode: "video", dimensions: ["storyboard", "motion", "music"], frames: [] },
        });
        Object.assign(node, { title: "逐帧拉片", width: 360, height: 620 });
        node.position = findAvailableGenerationGroupPosition(nodesRef.current, { x: source.position.x + source.width + 96, y: source.position.y }, node);
        commit([...nodesRef.current, node], [...connectionsRef.current, { id: nanoid(), fromNodeId: source.id, toNodeId: node.id }]);
        setSelectedNodeIds(new Set([node.id]));
    }, [commit, config.model, connectionsRef, message, nodesRef, setSelectedNodeIds]);

    const configure = useCallback((id: string, changes: Pick<Partial<VideoAnalysisWorkflow>, "model" | "inputMode" | "dimensions" | "sourceNodeId">) => {
        const current = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
        if (!current || videoAnalysisBusy(current) || current.result || active.current.has(id)) return;
        if (changes.sourceNodeId) {
            const source = nodesRef.current.find((node) => node.id === changes.sourceNodeId);
            if (source?.type !== CanvasNodeType.Video || (!source.metadata?.storageKey && !source.metadata?.content)) throw new Error("请选择已导入的视频");
            const links = connectionsRef.current.filter((link) => !(link.fromNodeId === current.sourceNodeId && link.toNodeId === id));
            links.push({ id: nanoid(), fromNodeId: source.id, toNodeId: id });
            commit(nodesRef.current.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, videoAnalysis: { ...current, ...changes, stage: "idle", frames: [], error: undefined, taskId: undefined, taskStatus: undefined, runId: undefined } } } : node), links);
            return;
        }
        const dimensions = changes.dimensions || current.dimensions;
        patch(id, { ...changes, dimensions: (changes.inputMode || current.inputMode) === "frames" ? dimensions.filter((item) => item !== "music") : dimensions });
    }, [commit, connectionsRef, nodesRef, patch]);

    const replaceFile = useCallback(async (id: string, file: File) => {
        const owner = nodesRef.current.find((node) => node.id === id);
        const workflow = owner?.metadata?.videoAnalysis;
        if (!owner || !workflow || videoAnalysisBusy(workflow) || workflow.result || active.current.has(id)) return;
        if (!file.type.startsWith("video/")) throw new Error("请选择视频文件");
        const controller = new AbortController();
        active.current.set(id, controller);
        try {
            const media = await uploadMediaFile(file, "video");
            if (scope.current !== projectId || getActiveUserScope() !== userScope || controller.signal.aborted) return;
            const current = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
            if (!current || videoAnalysisBusy(current) || current.result) return;
            const source = createCanvasNode(CanvasNodeType.Video, owner.position, videoMetadata(media));
            source.title = file.name;
            Object.assign(source, videoNodeSize(media.width, media.height));
            source.position = findAvailableGenerationGroupPosition(nodesRef.current, { x: owner.position.x - source.width - 96, y: owner.position.y }, source);
            commit([...nodesRef.current, source]);
            active.current.delete(id);
            configure(id, { sourceNodeId: source.id });
            if (!resourceIdFromStorageKey(media.storageKey)) message.warning("视频已保存到本机，开始分析时将重新尝试上传");
        } finally { active.current.delete(id); }
    }, [commit, configure, message, nodesRef, projectId, userScope]);

    const start = useCallback(async (id: string) => {
        const workflow = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
        if (!workflow || active.current.has(id) || videoAnalysisBusy(workflow) || workflow.result) return;
        if (!workflow.dimensions.length) throw new Error("至少选择一个拆解维度");
        if (!workflow.model || !useConfigStore.getState().isAiConfigReady(config, workflow.model)) throw new Error("请先选择可用的分析模型");
        validateVideoAnalysisModel(config, workflow.model);
        const source = nodesRef.current.find((node) => node.id === workflow.sourceNodeId);
        if (!source) throw new Error("原视频已删除，请替换素材");
        const controller = new AbortController();
        active.current.set(id, controller);
        let submitting = false;
        patch(id, { stage: "preparing", taskId: undefined, taskStatus: undefined, runId: undefined, frames: [], error: undefined, pollingError: undefined, progress: 0 });
        try {
            const prepared = await prepareVideoAnalysis(source, controller.signal, (progress) => patch(id, { progress }));
            controller.signal.throwIfAborted();
            if (!nodesRef.current.some((node) => node.id === id)) return;
            const next: VideoAnalysisWorkflow = { ...workflow, ...prepared, runId: nanoid(), stage: "submitting", taskId: undefined, taskStatus: undefined, error: undefined, progress: undefined };
            patch(id, next);
            // 提交前持久化批次标识；回包丢失时只找回这一任务，不能自动再付费提交。
            await flushCanvasStorePersistence();
            controller.signal.throwIfAborted();
            if (getActiveUserScope() !== userScope) return;
            submitting = true;
            const task = await submitVideoAnalysis({ projectId, nodeId: id, source, workflow: next, config, signal: controller.signal });
            if (controller.signal.aborted || scope.current !== projectId) {
                const store = useCanvasStore.getState();
                const project = store.projects.find((item) => item.id === projectId);
                if (project && getActiveUserScope() === userScope) store.updateProject(projectId, { nodes: project.nodes.map((node) => node.id === id && node.metadata?.videoAnalysis && node.metadata.videoAnalysis.runId === next.runId ? { ...node, metadata: { ...node.metadata, videoAnalysis: { ...node.metadata.videoAnalysis, stage: "analyzing", taskId: task.id, taskStatus: task.status } } } : node) });
                return;
            }
            patch(id, { stage: "analyzing", taskId: task.id, taskStatus: task.status, progress: task.progress });
            await flushCanvasStorePersistence();
        } catch (error) {
            if (!controller.signal.aborted && scope.current === projectId) {
                const current = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
                if (current?.taskId) patch(id, { pollingError: "任务已提交，保存状态暂未同步，正在继续获取结果" });
                else patch(id, { stage: submitting ? "recovering" : "error", error: submitting ? undefined : localizeErrorMessage(error, "素材准备失败，请重试"), pollingError: submitting ? "提交状态待确认，正在找回任务，请勿重复提交" : undefined });
            }
        } finally { active.current.delete(id); }
    }, [config, nodesRef, patch, projectId, userScope]);

    const complete = useCallback((id: string, workflow: VideoAnalysisWorkflow) => {
        const owner = nodesRef.current.find((node) => node.id === id);
        if (!owner || owner.metadata?.videoAnalysis?.result || owner.metadata?.videoAnalysis?.runId !== workflow.runId) return;
        const artifacts = createVideoAnalysisArtifacts(owner, workflow, nodesRef.current);
        const next = { ...workflow, stage: "ready" as const, taskStatus: "succeeded", progress: 100, pollingError: undefined, error: undefined, documentNodeId: artifacts.documentNodeId, storyboardNodeId: artifacts.storyboardNodeId };
        commit([...nodesRef.current.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, videoAnalysis: next } } : node), ...artifacts.nodes], [...connectionsRef.current, ...artifacts.connections]);
    }, [commit, connectionsRef, nodesRef]);

    const pendingKey = nodes.filter((node) => node.metadata?.videoAnalysis && ["analyzing", "recovering", "submitting"].includes(node.metadata.videoAnalysis.stage)).map((node) => `${node.id}:${node.metadata!.videoAnalysis!.runId}:${node.metadata!.videoAnalysis!.taskId}`).join("|");
    useEffect(() => {
        let disposed = false;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const poll = async (id: string) => {
            const workflow = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
            if (!workflow || !["analyzing", "submitting", "recovering"].includes(workflow.stage)) return;
            try {
                if (!active.current.has(id)) {
                    const task = workflow.taskId ? await queryGenerationTask(workflow.taskId) : workflow.runId ? await recoverVideoAnalysisTask(projectId, id, workflow.runId) : undefined;
                    const latest = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
                    if (disposed || scope.current !== projectId || getActiveUserScope() !== userScope || latest?.runId !== workflow.runId) return;
                    if (!task) patch(id, { stage: "recovering", pollingError: "暂未找到提交凭证，将继续查询；也可到任务中心核对，请勿重复提交" });
                    else if (task.status === "succeeded") {
                        try {
                            const result = parseVideoAnalysis(parseBackendGenerationResult(task).text || "", workflow);
                            complete(id, { ...workflow, taskId: task.id, result });
                        } catch (error) { patch(id, { stage: "error", taskId: task.id, taskStatus: task.status, error: localizeErrorMessage(error, "结果结构不完整，可在任务中心查看原结果"), pollingError: undefined }); }
                        return;
                    } else if (task.status === "failed" || task.status === "cancelled") {
                        patch(id, { stage: "error", taskId: task.id, taskStatus: task.status, error: localizeErrorMessage(task.error, "分析任务已结束，请检查模型是否支持所选素材"), pollingError: undefined });
                        return;
                    } else patch(id, { stage: "analyzing", taskId: task.id, taskStatus: task.status, progress: task.progress, pollingError: undefined });
                }
            } catch { if (!disposed) patch(id, { pollingError: "连接暂时中断，正在继续获取同一任务的结果" }); }
            if (!disposed) { const timer = setTimeout(() => { timers.delete(timer); void poll(id); }, 4000); timers.add(timer); }
        };
        nodesRef.current.filter((node) => node.metadata?.videoAnalysis && ["analyzing", "submitting", "recovering"].includes(node.metadata.videoAnalysis.stage)).forEach((node) => void poll(node.id));
        return () => { disposed = true; timers.forEach(clearTimeout); };
    }, [complete, nodesRef, patch, pendingKey, projectId, userScope]);

    const preparingKey = nodes.filter((node) => node.metadata?.videoAnalysis?.stage === "preparing").map((node) => node.id).join("|");
    useEffect(() => {
        nodesRef.current.filter((node) => node.metadata?.videoAnalysis?.stage === "preparing" && !active.current.has(node.id)).forEach((node) => patch(node.id, { stage: "error", error: "素材准备已中断，可重新开始，尚未提交分析任务" }));
    }, [nodesRef, patch, preparingKey]);
    useEffect(() => {
        active.current.forEach((controller, id) => { if (!nodes.some((node) => node.id === id)) controller.abort(); });
    }, [nodes]);
    useEffect(() => () => { active.current.forEach((controller) => controller.abort()); active.current.clear(); }, [projectId, userScope]);

    const resetUnsubmitted = useCallback((id: string) => {
        const current = nodesRef.current.find((node) => node.id === id)?.metadata?.videoAnalysis;
        // 只允许用户核对后解除无凭证状态；已有凭证的任务始终继续查询。
        if (current?.stage !== "recovering" || current.taskId || active.current.has(id)) return;
        patch(id, { stage: "idle", runId: undefined, error: undefined, pollingError: undefined, progress: undefined });
    }, [nodesRef, patch]);
    return { create, configure, replaceFile, start, resetUnsubmitted };
}
