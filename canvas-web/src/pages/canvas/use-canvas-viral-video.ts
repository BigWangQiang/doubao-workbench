import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { App } from "antd";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { parseViralVideoAnalysis, viralVideoPromptDocument, viralVideoStoryboardRows } from "@/lib/canvas/canvas-viral-video";
import { layoutViralVideoAssets } from "@/lib/canvas/canvas-viral-video-layout";
import { resolveViralVideoAnalysisModel, VIRAL_VIDEO_ANALYSIS_MODEL, VIRAL_VIDEO_ANALYSIS_MODEL_LABEL } from "@/lib/canvas/canvas-viral-video-policy";
import { prepareViralVideoAnalysis, submitViralVideoAnalysis } from "@/services/canvas-viral-video-analysis";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { listGenerationTasks, queryGenerationTask } from "@/services/api/task-center";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { uploadImage } from "@/services/image-storage";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { useCanvasStore, flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { ViralVideoWorkflow } from "@/types/canvas-viral-video";

type Options = {
    projectId: string;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
};

export function useCanvasViralVideo({ projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds }: Options) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const [openNodeId, setOpenNodeId] = useState<string | null>(null);
    const [workspaceNodeId, setWorkspaceNodeId] = useState<string | null>(null);
    // 最小化只隐藏工作区，保留组件的页签和编辑草稿；分析轮询由画布继续维护。
    const open = useCallback((id: string | null) => {
        if (id) setWorkspaceNodeId(id);
        setOpenNodeId(id);
    }, []);
    const preparing = useRef(new Map<string, AbortController>());
    const scope = useRef(projectId);
    scope.current = projectId;

    const commit = useCallback((nextNodes: CanvasNodeData[], nextConnections = connectionsRef.current) => {
        if (scope.current !== projectId) return;
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        useCanvasStore.getState().updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
        setNodes(nextNodes);
        setConnections(nextConnections);
    }, [connectionsRef, nodesRef, projectId, setConnections, setNodes]);

    const patchWorkflow = useCallback((id: string, patch: Partial<ViralVideoWorkflow>) => {
        commit(nodesRef.current.map((node) => node.id === id && node.metadata?.viralVideo ? {
            ...node, metadata: { ...node.metadata, viralVideo: { ...node.metadata.viralVideo, ...patch } },
        } : node));
    }, [commit, nodesRef]);

    const materialize = useCallback((id: string, workflow: ViralVideoWorkflow) => {
        const analysisNode = nodesRef.current.find((node) => node.id === id);
        if (!analysisNode || !workflow.analysis) return;
        const next = [...nodesRef.current];
        const links = [...connectionsRef.current];
        const assets = workflow.analysis.assets.map((asset) => {
            const frame = workflow.frames[asset.frameIndex];
            if (!frame) throw new Error("资产证据帧已失效");
            const assetNode = createCanvasNode(CanvasNodeType.Image, { x: analysisNode.position.x, y: analysisNode.position.y }, {
                content: resourceFileUrl(resourceIdFromStorageKey(frame.storageKey)), storageKey: frame.storageKey,
                naturalWidth: frame.width, naturalHeight: frame.height, mimeType: "image/jpeg", status: "success",
                workflowKind: "reference_set", workflowTitle: "复刻资产证据帧", viralVideoAnalysisNodeId: id,
                assetCategory: asset.kind === "scene" ? "environment" : asset.kind === "product" ? "prop" : asset.kind === "style" ? "style" : asset.kind,
            });
            assetNode.title = `${asset.name} · 证据帧`;
            const size = fitNodeSize(frame.width, frame.height, 320, 320);
            assetNode.width = size.width;
            assetNode.height = size.height;
            workflow.assetNodeIds[asset.id] = assetNode.id;
            return assetNode;
        });
        const layout = layoutViralVideoAssets(analysisNode, assets, next);
        next.push(...assets.map((node) => ({ ...node, position: layout.positions.get(node.id)! })));
        const x = Math.max(analysisNode.position.x + analysisNode.width, layout.right) + 96;
        const rows = viralVideoStoryboardRows(workflow, next);
        const prompt = createCanvasNode(CanvasNodeType.Text, { x: x + 200, y: analysisNode.position.y + 140 }, { content: viralVideoPromptDocument(workflow, rows, next), viralVideoAnalysisNodeId: id });
        prompt.title = "整片复刻提示词";
        prompt.width = 400;
        prompt.height = 300;
        prompt.position = { x, y: analysisNode.position.y };
        const script = createCanvasNode(CanvasNodeType.Script, { x: x + 360, y: analysisNode.position.y + 520 }, {
            workflowKind: "storyboard", workflowTitle: "爆款复刻分镜", viralVideoAnalysisNodeId: id,
            size: (() => { const source = next.find((node) => node.id === workflow.sourceNodeId); const width = source?.metadata?.naturalWidth || 0; const height = source?.metadata?.naturalHeight || 0; return width && height ? width < height ? "9:16" : width === height ? "1:1" : "16:9" : "auto"; })(),
            storyboardVideoInputMode: "keyframe", storyboard: { rows, visibleColumns: ["shotNumber", "durationSeconds", "plotDescription", "imageGenerationPrompt", "videoMotionPrompt"], referenceNodeIds: [] },
        });
        script.title = "复刻分镜表";
        script.position = { x, y: prompt.position.y + prompt.height + 80 };
        workflow = { ...workflow, stage: "ready", taskStatus: "succeeded", error: undefined, pollingError: undefined, progress: 100, promptNodeId: prompt.id, storyboardNodeId: script.id };
        next.push(prompt, script);
        [prompt, script].forEach((node) => links.push({ id: nanoid(), fromNodeId: id, toNodeId: node.id }));
        rows.forEach((row) => row.referenceNodeIds.forEach((referenceId) => links.push({ id: nanoid(), fromNodeId: referenceId, toNodeId: script.id, toHandleId: `row:${row.id}` })));
        commit(next.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, viralVideo: workflow } } : node), links);
    }, [commit, connectionsRef, nodesRef]);

    const arrangeAssets = useCallback((id: string) => {
        const owner = nodesRef.current.find((node) => node.id === id);
        const analysis = owner?.metadata?.viralVideo?.analysis;
        if (!owner || !analysis) throw new Error("复刻分析结果尚未就绪");
        const assets = analysis.assets.flatMap((asset) => {
            const node = nodesRef.current.find((item) => item.id === owner.metadata!.viralVideo!.assetNodeIds[asset.id]
                && item.type === CanvasNodeType.Image && item.metadata?.viralVideoAnalysisNodeId === id);
            return node ? [node] : [];
        });
        if (!assets.length) throw new Error("暂无可整理的参考图");
        if (assets.some((node) => node.metadata?.locked)) throw new Error("请先解锁参考图，再整理宫格");
        const assetIds = new Set(assets.map((node) => node.id));
        const { positions } = layoutViralVideoAssets(owner, assets, nodesRef.current.filter((node) => !assetIds.has(node.id)));
        commit(nodesRef.current.map((node) => {
            const position = positions.get(node.id);
            return position ? { ...node, position } : node;
        }));
    }, [commit, nodesRef]);

    const analyze = useCallback(async (id: string) => {
        const workflow = nodesRef.current.find((node) => node.id === id)?.metadata?.viralVideo;
        if (!workflow || preparing.current.has(id) || workflow.stage === "analyzing") return;
        if (workflow.analysis) throw new Error("已有分析结果，请新建一轮复刻，避免覆盖已编辑分镜");
        const model = resolveViralVideoAnalysisModel(config);
        const source = nodesRef.current.find((node) => node.id === workflow.sourceNodeId);
        const controller = new AbortController();
        preparing.current.set(id, controller);
        patchWorkflow(id, { stage: "sampling", error: undefined, pollingError: undefined, taskId: undefined, taskStatus: undefined, model: model || VIRAL_VIDEO_ANALYSIS_MODEL, progress: 0 });
        try {
            if (!source) throw new Error("源视频节点已删除");
            // 提交回包前刷新可能丢失本地凭证，先找回同一分析节点的既有任务，避免重复计费。
            if (!workflow.taskId && workflow.frames.length) {
                const tasks = await listGenerationTasks(100, { projectId });
                if (controller.signal.aborted) return;
                const existing = tasks.find((task) => {
                    if (task.type !== "canvas_text" || !task.inputJson || task.status === "failed" || task.status === "cancelled") return false;
                    try { return (JSON.parse(task.inputJson) as { metadata?: { viralVideoAnalysisNodeId?: string } }).metadata?.viralVideoAnalysisNodeId === id; } catch { return false; }
                });
                if (existing) { patchWorkflow(id, { stage: "analyzing", taskId: existing.id, taskStatus: existing.status }); return; }
            }
            if (!model || !useConfigStore.getState().isAiConfigReady(config, model)) throw new Error(`${VIRAL_VIDEO_ANALYSIS_MODEL_LABEL} 系统模型不可用，请联系管理员`);
            const prepared = await prepareViralVideoAnalysis(source, controller.signal, (progress) => patchWorkflow(id, { progress }));
            patchWorkflow(id, { frames: prepared.frames, durationSeconds: prepared.durationSeconds });
            await flushCanvasStorePersistence();
            if (!nodesRef.current.some((node) => node.id === id)) return;
            const task = await submitViralVideoAnalysis({ projectId, analysisNodeId: id, config, signal: controller.signal, prepared });
            if (controller.signal.aborted) {
                const store = useCanvasStore.getState();
                const project = store.projects.find((item) => item.id === projectId);
                if (project) store.updateProject(projectId, { nodes: project.nodes.map((node) => node.id === id && node.metadata?.viralVideo ? { ...node, metadata: { ...node.metadata, viralVideo: { ...node.metadata.viralVideo, stage: "analyzing", taskId: task.id, taskStatus: task.status } } } : node) });
                return;
            }
            patchWorkflow(id, { stage: "analyzing", taskId: task.id, taskStatus: task.status, progress: task.progress || 0 });
            await flushCanvasStorePersistence();
        } catch (error) {
            if (!controller.signal.aborted) {
                // 已提交的任务继续查询，不能因为本地持久化失败再创建一个计费任务。
                const current = nodesRef.current.find((node) => node.id === id)?.metadata?.viralVideo;
                patchWorkflow(id, current?.taskId ? { pollingError: String(error instanceof Error ? error.message : error) } : { stage: "error", error: error instanceof Error ? error.message : "视频分析失败" });
            }
        } finally {
            preparing.current.delete(id);
        }
    }, [config, nodesRef, patchWorkflow, projectId]);

    const create = useCallback((source: CanvasNodeData) => {
        const existing = nodesRef.current.find((node) => node.metadata?.viralVideo?.sourceNodeId === source.id);
        if (existing) { open(existing.id); return existing.id; }
        const analysis = createCanvasNode(CanvasNodeType.Text, { x: source.position.x + source.width + 280, y: source.position.y + 150 }, {
            workflowTitle: "爆款复刻分析", content: "视频分析与复刻方案",
            viralVideo: { version: 1, sourceNodeId: source.id, stage: "sampling", model: resolveViralVideoAnalysisModel(config) || VIRAL_VIDEO_ANALYSIS_MODEL, frames: [], bindings: {}, assetNodeIds: {} },
        });
        analysis.title = "爆款复刻 · 视频分析";
        analysis.width = 360;
        analysis.height = 280;
        analysis.position = { x: source.position.x + source.width + 96, y: source.position.y };
        const currentNodes = nodesRef.current.some((node) => node.id === source.id) ? nodesRef.current : [...nodesRef.current, source];
        commit([...currentNodes.map((node) => node.id === source.id ? { ...node, metadata: { ...node.metadata, workflowKind: "reference_video" as const, workflowTitle: "爆款视频复刻" } } : node), analysis], [...connectionsRef.current, { id: nanoid(), fromNodeId: source.id, toNodeId: analysis.id }]);
        setSelectedNodeIds(new Set([analysis.id]));
        open(analysis.id);
        void analyze(analysis.id);
        return analysis.id;
    }, [analyze, commit, config, connectionsRef, nodesRef, open, setSelectedNodeIds]);

    const pendingKey = nodes.filter((node) => node.metadata?.viralVideo?.stage === "analyzing").map((node) => `${node.id}:${node.metadata!.viralVideo!.taskId}`).join("|");
    useEffect(() => {
        let disposed = false;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const poll = async (id: string, taskId: string) => {
            try {
                const task = await queryGenerationTask(taskId);
                if (disposed) return;
                const workflow = nodesRef.current.find((node) => node.id === id)?.metadata?.viralVideo;
                if (!workflow || workflow.taskId !== taskId || workflow.stage !== "analyzing") return;
                if (task.status === "succeeded") {
                    try {
                        const result = parseBackendGenerationResult(task);
                        const analysis = parseViralVideoAnalysis(result.text || "", workflow.durationSeconds || 0, workflow.frames.length);
                        materialize(id, { ...workflow, analysis, assetNodeIds: {} });
                    } catch (error) {
                        patchWorkflow(id, { stage: "error", taskStatus: task.status, error: `分析结果未通过完整性检查：${error instanceof Error ? error.message : "结果格式错误"}` });
                    }
                    return;
                }
                if (task.status === "failed" || task.status === "cancelled") {
                    patchWorkflow(id, { stage: "error", taskStatus: task.status, error: task.error || "分析任务已取消" });
                    return;
                }
                patchWorkflow(id, { taskStatus: task.status, progress: task.progress, pollingError: undefined });
            } catch (error) {
                if (disposed) return;
                const workflow = nodesRef.current.find((node) => node.id === id)?.metadata?.viralVideo;
                if (workflow?.stage !== "analyzing") return;
                patchWorkflow(id, { pollingError: error instanceof Error ? error.message : "结果读取失败" });
                // 格式错误也保留原任务，可恢复读取或由用户决定重新付费分析。
            }
            if (!disposed) { const timer = setTimeout(() => { timers.delete(timer); void poll(id, taskId); }, 3000); timers.add(timer); }
        };
        nodesRef.current.filter((node) => node.metadata?.viralVideo?.stage === "analyzing" && node.metadata.viralVideo.taskId).forEach((node) => void poll(node.id, node.metadata!.viralVideo!.taskId!));
        return () => { disposed = true; timers.forEach(clearTimeout); };
    }, [pendingKey, materialize, nodesRef, patchWorkflow]);

    const samplingKey = nodes.filter((node) => node.metadata?.viralVideo?.stage === "sampling").map((node) => node.id).join("|");
    useEffect(() => {
        nodesRef.current.filter((node) => node.metadata?.viralVideo?.stage === "sampling" && !preparing.current.has(node.id)).forEach((node) => patchWorkflow(node.id, { stage: "error", error: "素材准备已中断，点击重新分析继续" }));
    }, [samplingKey, nodesRef, patchWorkflow]);

    useEffect(() => () => { preparing.current.forEach((controller) => controller.abort()); preparing.current.clear(); }, [projectId]);

    const updatePlan = useCallback((id: string, rows: StoryboardRow[], workflow?: ViralVideoWorkflow) => {
        const current = nodesRef.current.find((node) => node.id === id)?.metadata?.viralVideo;
        const plan = workflow || current;
        if (!plan?.analysis || !plan.storyboardNodeId || !plan.promptNodeId) throw new Error("复刻方案尚未就绪");
        if (!nodesRef.current.some((node) => node.id === plan.storyboardNodeId) || !nodesRef.current.some((node) => node.id === plan.promptNodeId)) throw new Error("分镜表或整片提示词节点已删除");
        const currentRows = nodesRef.current.find((node) => node.id === plan.storyboardNodeId)?.metadata?.storyboard?.rows || [];
        const changedIds = new Set(rows.filter((row) => {
            const old = currentRows.find((item) => item.id === row.id);
            return !old || old.durationSeconds !== row.durationSeconds || old.imageGenerationPrompt !== row.imageGenerationPrompt || old.videoMotionPrompt !== row.videoMotionPrompt || old.negativePrompt !== row.negativePrompt || old.referenceNodeIds.join() !== row.referenceNodeIds.join();
        }).map((row) => row.id));
        const script = nodesRef.current.find((node) => node.id === plan.storyboardNodeId);
        if (script?.metadata?.generationBatches?.some((batch) => batch.items.some((item) => changedIds.has(item.rowId) && ["waiting", "submitting", "queued", "running"].includes(item.status)))) throw new Error("相关镜头正在生成，请完成或停止队列后再修改");
        const nextRows = rows.map((row) => changedIds.has(row.id) ? { ...row, imageNodeId: undefined, videoNodeId: undefined, status: "idle" as const, errorDetails: undefined, imagePromptTemplateVariables: undefined, videoPromptTemplateVariables: undefined } : row);
        const next = nodesRef.current.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, viralVideo: plan } }
            : node.id === plan.promptNodeId ? { ...node, metadata: { ...node.metadata, content: viralVideoPromptDocument(plan, nextRows, nodesRef.current), richText: undefined } }
                : node.id === plan.storyboardNodeId ? { ...node, metadata: { ...node.metadata, storyboard: { rows: nextRows, visibleColumns: node.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "plotDescription"], referenceNodeIds: [] } } } : node);
        const affectedHandles = new Set([...changedIds].map((rowId) => `row:${rowId}`));
        const links = connectionsRef.current.filter((link) => !(link.toNodeId === plan.storyboardNodeId && affectedHandles.has(link.toHandleId || "")) && !(link.fromNodeId === plan.storyboardNodeId && affectedHandles.has(link.fromHandleId || "")));
        nextRows.filter((row) => changedIds.has(row.id)).forEach((row) => row.referenceNodeIds.forEach((referenceId) => links.push({ id: nanoid(), fromNodeId: referenceId, toNodeId: plan.storyboardNodeId!, toHandleId: `row:${row.id}` })));
        commit(next, links);
    }, [commit, connectionsRef, nodesRef]);

    const replaceAsset = useCallback((id: string, assetId: string, nodeId?: string) => {
        const current = nodesRef.current.find((node) => node.id === id)?.metadata?.viralVideo;
        if (!current?.analysis?.assets.some((asset) => asset.id === assetId)) throw new Error("复刻资产不存在");
        if (nodeId && !nodesRef.current.some((node) => node.id === nodeId && node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey) && !node.metadata.viralVideoAnalysisNodeId)) throw new Error("请选择可用的用户图片资产");
        const workflow = { ...current, bindings: { ...current.bindings } };
        if (nodeId) workflow.bindings[assetId] = nodeId; else delete workflow.bindings[assetId];
        const regenerated = viralVideoStoryboardRows(workflow, nodesRef.current);
        const currentRows = nodesRef.current.find((node) => node.id === workflow.storyboardNodeId)?.metadata?.storyboard?.rows || [];
        const affected = new Set(workflow.analysis!.shots.filter((shot) => shot.assetIds.includes(assetId) || (workflow.promptOverride ?? workflow.analysis!.globalPrompt).includes(`{{${assetId}}}`)).map((shot) => shot.id));
        updatePlan(id, currentRows.map((row) => affected.has(row.id) ? { ...row, ...regenerated.find((item) => item.id === row.id), durationSeconds: row.durationSeconds, shotNumber: row.shotNumber } : row), workflow);
    }, [nodesRef, updatePlan]);

    const uploadAsset = useCallback(async (id: string, assetId: string, file: File) => {
        if (!file.type.startsWith("image/")) throw new Error("请选择图片资产");
        const owner = nodesRef.current.find((node) => node.id === id);
        if (!owner?.metadata?.viralVideo?.analysis) throw new Error("复刻方案不存在");
        const image = await uploadImage(file);
        if (scope.current !== projectId || !nodesRef.current.some((node) => node.id === id)) throw new Error("原复刻工作区已关闭或删除，图片未绑定");
        const size = fitNodeSize(image.width, image.height, 320, 320);
        const node = createCanvasNode(CanvasNodeType.Image, { x: owner.position.x - 240, y: owner.position.y + 400 }, imageMetadata(image));
        node.title = file.name.replace(/\.[^.]+$/, "") || "我的替换资产";
        node.width = size.width;
        node.height = size.height;
        commit([...nodesRef.current, node]);
        replaceAsset(id, assetId, node.id);
        if (!resourceIdFromStorageKey(image.storageKey)) message.warning("图片已缓存到本机，生成时需成功同步服务器后才能使用");
    }, [commit, message, nodesRef, projectId, replaceAsset]);

    const retry = useCallback((id: string) => { void analyze(id).catch((error) => message.error(error instanceof Error ? error.message : "无法重新分析")); }, [analyze, message]);
    return { createViralVideo: create, viralVideoOpenNodeId: openNodeId, viralVideoWorkspaceNodeId: workspaceNodeId, openViralVideo: open, retryViralVideo: retry, arrangeViralVideoAssets: arrangeAssets, replaceViralVideoAsset: replaceAsset, uploadViralVideoAsset: uploadAsset, updateViralVideoPlan: updatePlan };
}
