import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { localizeErrorMessage } from "@/lib/generation-error";
import { newScreenplay, reviseScreenplay, screenplayBusy, screenplaySummary, screenplayText, validateScene, validateScreenplay } from "@/lib/canvas/canvas-screenplay";
import { screenplayStoryboard } from "@/lib/canvas/canvas-screenplay-artifacts";
import { mergeScreenplayResult } from "@/lib/canvas/canvas-screenplay-result";
import { submitScreenplayGeneration } from "@/services/canvas-screenplay-generation";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import { cancelGenerationTask, listGenerationTasks, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { configuredModelMatchesCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";
import type { ScreenplayAgentRequest, ScreenplayDocument, ScreenplayGenerationRequest, ScreenplayTask, ScreenplayWorkflow } from "@/types/canvas-screenplay";

type Options = {
    projectId: string; nodes: CanvasNodeData[]; nodesRef: { current: CanvasNodeData[] }; connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>; setConnections: Dispatch<SetStateAction<CanvasConnection[]>>; setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
};
const errorText = (error: unknown) => localizeErrorMessage(error, "剧本任务处理失败，请稍后重试。");

export function useCanvasScreenplay({ projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds }: Options) {
    const config = useEffectiveConfig();
    const scope = useRef(projectId); scope.current = projectId;
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [visibleId, setVisibleId] = useState<string | null>(null);
    const submitting = useRef(new Set<string>());
    const open = useCallback((id: string | null) => { if (id) setWorkspaceId(id); setVisibleId(id); }, []);
    const commit = useCallback((next: CanvasNodeData[], links = connectionsRef.current) => {
        if (scope.current !== projectId) throw new Error("画布已切换，请返回原项目继续");
        nodesRef.current = next; connectionsRef.current = links;
        useCanvasStore.getState().updateProject(projectId, { nodes: next, connections: links });
        setNodes(next); setConnections(links);
    }, [projectId, nodesRef, connectionsRef, setNodes, setConnections]);
    const get = useCallback((id: string) => {
        if (scope.current !== projectId) throw new Error("画布已切换，请返回原项目继续");
        const node = nodesRef.current.find((item) => item.id === id);
        if (!node?.metadata?.screenplay) throw new Error("剧本节点不存在，请重新读取画布");
        return { node, workflow: node.metadata.screenplay };
    }, [nodesRef, projectId]);
    const patch = useCallback((id: string, workflow: ScreenplayWorkflow) => {
        get(id);
        commit(nodesRef.current.map((node) => node.id === id ? { ...node, title: workflow.document.title, metadata: { ...node.metadata, screenplay: workflow, content: screenplayText(workflow.document) } } : node));
    }, [get, commit, nodesRef]);
    const save = useCallback((id: string, document: ScreenplayDocument, revision: number, label = "手动编辑") => {
        const { workflow } = get(id);
        if (document.assets.some((asset) => asset.referenceNodeId && !nodesRef.current.some((node) => node.id === asset.referenceNodeId && node.id !== id && (node.type === CanvasNodeType.Image || node.metadata?.characterAssetId || node.metadata?.screenplaySource?.assetId)))) throw new Error("存在已删除或类型不支持的绑定资产，请重新选择");
        const next = reviseScreenplay(workflow, document, revision, label);
        patch(id, next);
        commit(nodesRef.current.map((node) => node.metadata?.screenplaySource?.nodeId === id ? { ...node, metadata: { ...node.metadata, screenplaySource: { ...node.metadata.screenplaySource, stale: true } } } : node));
        return next;
    }, [get, patch, commit, nodesRef]);
    const create = useCallback((position?: Position, sourceId?: string, initial?: Partial<ScreenplayDocument>) => {
        const source = sourceId ? nodesRef.current.find((node) => node.id === sourceId) : undefined;
        const workflow = newScreenplay();
        workflow.document = validateScreenplay({ ...workflow.document, ...initial, version: 1, revision: 0 });
        if (source?.type === CanvasNodeType.Text && source.metadata?.content && !initial?.source) workflow.document.source = source.metadata.content;
        if (workflow.document.source.length > 60000) throw new Error("连接的文本超过 60000 字，请先按章节拆分");
        const anchor = position || { x: Math.max(0, ...nodesRef.current.map((node) => node.position.x + node.width)) + 260, y: 200 };
        const node = createCanvasNode(CanvasNodeType.Text, anchor, { screenplay: workflow, workflowTitle: "剧本创作", content: screenplayText(workflow.document) });
        node.title = workflow.document.title; node.width = 360; node.height = 360;
        const links = source ? [...connectionsRef.current, { id: nanoid(), fromNodeId: source.id, toNodeId: node.id }] : connectionsRef.current;
        commit([...nodesRef.current, node], links); setSelectedNodeIds(new Set([node.id])); open(node.id);
        return node.id;
    }, [nodesRef, connectionsRef, commit, open, setSelectedNodeIds]);
    const approve = useCallback((id: string, revision: number) => {
        const { workflow } = get(id);
        if (screenplayBusy(workflow)) throw new Error("请等待当前任务结束后确认剧本");
        if (workflow.document.revision !== revision) throw new Error("剧本版本已变化，请重新确认");
        validateScreenplay(workflow.document);
        if (!workflow.document.episodes.some((episode) => episode.scenes.some((scene) => scene.beats.some((beat) => beat.text.trim())))) throw new Error("请先完成至少一集分场剧本；已有小说正文可先改编为分场");
        if (workflow.document.episodes.some((episode) => episode.scenes.some((scene) => !scene.beats.length || scene.beats.some((beat) => !beat.text.trim())))) throw new Error("场次中还有空白动作或对白，请补全或删除后确认");
        patch(id, { ...workflow, approvedRevision: revision });
    }, [get, patch]);
    const extractAssets = useCallback((id: string) => {
        const { node: owner, workflow } = get(id);
        if (screenplayBusy(workflow)) throw new Error("请先等待当前任务结束，再提取资产");
        if (workflow.approvedRevision !== workflow.document.revision) throw new Error("请先确认当前剧本版本");
        const next = [...nodesRef.current], links = [...connectionsRef.current];
        const assets = workflow.document.assets.map((asset, index) => {
            if (asset.referenceNodeId) {
                if (!next.some((node) => node.id === asset.referenceNodeId)) throw new Error(`「${asset.name}」绑定的节点已删除，请重新选择`);
                return asset;
            }
            const existing = next.find((node) => node.metadata?.screenplaySource?.nodeId === id && node.metadata.screenplaySource.assetId === asset.id);
            if (existing) return { ...asset, referenceNodeId: existing.id };
            const right = Math.max(owner.position.x + owner.width, ...nodesRef.current.filter((node) => node.metadata?.screenplaySource?.nodeId === id).map((node) => node.position.x + node.width));
            const node = createCanvasNode(CanvasNodeType.Text, { x: right + 260 + index % 3 * 380, y: owner.position.y + Math.floor(index / 3) * 340 + 140 }, {
                content: `${asset.name}\n\n${asset.description}`, prompt: asset.description,
                assetCategory: asset.kind === "location" ? "environment" : asset.kind,
                screenplaySource: { nodeId: id, revision: workflow.document.revision, assetId: asset.id },
            });
            node.title = `${asset.kind === "character" ? "人物" : asset.kind === "location" ? "场景" : "道具"} · ${asset.name}`;
            node.width = 320; node.height = 260; next.push(node); links.push({ id: nanoid(), fromNodeId: id, toNodeId: node.id });
            return { ...asset, referenceNodeId: node.id };
        });
        const updated = { ...workflow, document: { ...workflow.document, assets } };
        commit(next.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, screenplay: updated } } : node), links);
        return { assetNodeIds: assets.map((asset) => asset.referenceNodeId) };
    }, [get, nodesRef, connectionsRef, commit]);
    const acceptTask = useCallback((id: string, task: GenerationTask) => {
        const { node, workflow } = get(id), pending = workflow.task;
        if (!pending || pending.taskId !== task.id || !screenplayBusy(workflow)) return;
        if (task.status === "failed" || task.status === "cancelled") { patch(id, { ...workflow, task: { ...pending, status: task.status, error: errorText(task.error || "任务已结束，未产生可用结果") } }); return; }
        if (task.status !== "succeeded") { patch(id, { ...workflow, task: { ...pending, status: "running", progress: task.progress, error: undefined } }); return; }
        let raw = "";
        try { raw = parseBackendGenerationResult(task).text || ""; }
        catch (error) { patch(id, { ...workflow, task: { ...pending, status: "invalid", error: errorText(error) } }); return; }
        if (workflow.document.revision !== pending.baseRevision) { patch(id, { ...workflow, task: { ...pending, status: "conflict", resultText: raw, error: "任务期间剧本已修改，结果已保留。可另存为新剧本，避免覆盖当前版本。" } }); return; }
        try {
            if (pending.action === "storyboard") {
                const script = screenplayStoryboard(node, pending, raw, nodesRef.current);
                const links = [...connectionsRef.current, { id: nanoid(), fromNodeId: id, toNodeId: script.id }, ...(script.metadata?.storyboard?.referenceNodeIds || []).map((refId) => ({ id: nanoid(), fromNodeId: refId, toNodeId: script.id }))];
                commit([...nodesRef.current.map((item) => item.id === id ? { ...item, metadata: { ...item.metadata, screenplay: { ...workflow, task: { ...pending, status: "succeeded" as const, baseDocument: undefined, error: undefined } } } } : item), script], links);
            } else {
                const updated = save(id, mergeScreenplayResult(workflow.document, pending, raw), pending.baseRevision, `AI · ${pending.action}`);
                patch(id, { ...updated, task: { ...pending, status: "succeeded", baseDocument: undefined, error: undefined } });
            }
        } catch (error) { patch(id, { ...get(id).workflow, task: { ...pending, status: "invalid", resultText: raw, error: errorText(error) } }); }
    }, [get, patch, save, nodesRef, connectionsRef, commit]);
    const generate = useCallback(async (id: string, request: ScreenplayGenerationRequest) => {
        const { workflow } = get(id), doc = workflow.document;
        if (submitting.current.has(id) || screenplayBusy(workflow)) throw new Error("已有任务进行中，请等待完成或先恢复状态");
        if (["conflict", "invalid"].includes(workflow.task?.status || "")) throw new Error("请先另存或放弃保留的结果，再提交新任务");
        const model = request.model || config.textModel;
        if (!model || !configuredModelMatchesCapability(config, model, "text") || !useConfigStore.getState().isAiConfigReady(config, model)) throw new Error("请选择可用的文本模型并配置渠道");
        validateScreenplay(doc);
        const episode = doc.episodes.find((item) => item.id === request.episodeId);
        const hasEpisodeContent = Boolean(episode?.novelText?.trim() || episode?.scenes.some((scene) => scene.beats.some((beat) => beat.text.trim())));
        if (!doc.brief.trim() && !doc.source.trim() && !episode?.synopsis.trim() && !hasEpisodeContent) throw new Error("请填写故事想法、分集梗概或导入正文素材");
        if (doc.mode !== "original" && !doc.source.trim() && !hasEpisodeContent) throw new Error("改编或改写模式需要原始文本素材或本集正文");
        if (request.action === "outline" && doc.episodes.some((item) => item.scenes.length || item.novelText?.trim())) throw new Error("已有小说或分场剧本，请新建剧本后重新规划大纲");
        if (request.action !== "outline" && !episode) throw new Error("请先生成或补充分集大纲，再选择目标集");
        if (request.action === "write_novel" && episode?.novelText?.trim()) throw new Error("本集已有小说正文，请使用改写小说正文");
        if ((request.action === "rewrite_novel" || request.action === "adapt_episode") && !episode?.novelText?.trim()) throw new Error("请先填写或生成本集完整小说正文");
        if (request.action === "adapt_episode" && episode?.scenes.length && !request.replaceExistingScenes) throw new Error("本集已有场次，重新改编须明确确认替换；原版本会保留到历史记录");
        if (request.action === "write_episode" && episode?.scenes.length) throw new Error("本集已有分场剧本，请改写场次或续写");
        if (request.action === "continue_episode" && !episode?.scenes.length) throw new Error("请先生成本集分场剧本");
        if (request.action === "rewrite_scene" && !episode?.scenes.some((scene) => scene.id === request.sceneId)) throw new Error("请选择真实场次");
        if (request.action === "storyboard" && (workflow.approvedRevision !== doc.revision || !episode?.scenes.length)) throw new Error("请先完成本集分场剧本，并确认当前剧本版本");
        const pending: ScreenplayTask = { requestId: nanoid(), ...request, instruction: request.instruction || "", model, baseRevision: doc.revision, baseDocument: doc, status: "submitting" };
        submitting.current.add(id);
        patch(id, { ...workflow, task: pending });
        let submissionStarted = false;
        try {
            await flushCanvasStorePersistence();
            if (scope.current !== projectId) throw new Error("画布已切换，尚未提交任务");
            const task = await submitScreenplayGeneration(projectId, id, doc, pending, config, () => {
                if (scope.current !== projectId || !nodesRef.current.some((node) => node.id === id)) throw new Error("画布已切换或剧本已删除，未提交任务");
                submissionStarted = true;
            });
            // 切换项目也必须保留返回凭证；不能把返回丢弃后再次计费。
            if (scope.current !== projectId) {
                const store = useCanvasStore.getState(), project = store.projects.find((item) => item.id === projectId);
                if (project) store.updateProject(projectId, { nodes: project.nodes.map((node) => node.id === id && node.metadata?.screenplay ? { ...node, metadata: { ...node.metadata, screenplay: { ...node.metadata.screenplay, task: { ...pending, taskId: task.id, status: "running" } } } } : node) });
            } else patch(id, { ...get(id).workflow, task: { ...pending, taskId: task.id, status: "running" } });
            await flushCanvasStorePersistence();
            return { nodeId: id, taskId: task.id, status: task.status };
        } catch (error) {
            if (scope.current === projectId) {
                const current = get(id).workflow;
                patch(id, { ...current, task: { ...(current.task || pending), status: current.task?.taskId ? "running" : submissionStarted ? "unknown" : "failed", error: errorText(error) } });
            }
            throw error;
        } finally { submitting.current.delete(id); }
    }, [get, config, patch, projectId, nodesRef]);
    const recover = useCallback(async (id: string) => {
        const { workflow } = get(id), pending = workflow.task;
        if (!pending) throw new Error("没有待恢复任务");
        if (pending.taskId) { const task = await queryGenerationTask(pending.taskId); if (scope.current === projectId) acceptTask(id, task); return; }
        const tasks = await listGenerationTasks(100, { projectId });
        const candidates = await Promise.all(tasks.filter((task) => task.type === "canvas_text").map(async (task) => task.inputJson ? task : queryGenerationTask(task.id)));
        if (scope.current !== projectId) return;
        const task = candidates.find((item) => {
            try { return JSON.parse(item.inputJson || "{}").metadata?.screenplayRequestId === pending.requestId; } catch { return false; }
        });
        if (!task) {
            const current = get(id).workflow;
            if (current.task?.requestId === pending.requestId) patch(id, { ...current, task: { ...pending, status: "unknown" } });
            throw new Error("尚未找到提交记录。请稍后恢复，或在任务中心确认；系统不会自动重复计费提交。");
        }
        const current = get(id).workflow;
        if (current.task?.requestId !== pending.requestId) return;
        patch(id, { ...current, task: { ...pending, taskId: task.id, status: "running", error: undefined } });
        acceptTask(id, task);
    }, [get, projectId, patch, acceptTask]);
    const cancel = useCallback(async (id: string) => {
        const { workflow } = get(id);
        if (!workflow.task?.taskId) throw new Error("提交状态未确认，请先恢复任务记录");
        await cancelGenerationTask(workflow.task.taskId);
        await recover(id);
    }, [get, recover]);
    const resolveResult = useCallback((id: string, copy: boolean, resetUnconfirmed = false) => {
        const { workflow, node } = get(id), task = workflow.task;
        if (screenplayBusy(workflow) && !(resetUnconfirmed && !copy && task?.status === "unknown" && !task.taskId && !submitting.current.has(id))) throw new Error("任务仍在进行，不能清除提交记录");
        if (copy) {
            if (!task?.resultText || !task.baseDocument) throw new Error("没有可另存的结果");
            if (task.action === "storyboard") throw new Error("分镜结果格式不完整，请复制原始结果处理，或放弃后重新拆镜");
            const document = mergeScreenplayResult(task.baseDocument, task, task.resultText);
            create({ x: node.position.x + node.width + 300, y: node.position.y + 400 }, undefined, { ...document, title: `${document.title} · 结果副本` });
        }
        patch(id, { ...workflow, task: undefined });
    }, [get, create, patch]);

    const pendingKey = nodes.filter((node) => node.metadata?.screenplay && screenplayBusy(node.metadata.screenplay) && node.metadata.screenplay.task?.status !== "unknown").map((node) => `${node.id}:${node.metadata!.screenplay!.task?.taskId || "recover"}`).join("|");
    useEffect(() => {
        let disposed = false;
        const timer = setTimeout(async function poll() {
            for (const node of nodesRef.current.filter((item) => item.metadata?.screenplay && screenplayBusy(item.metadata.screenplay) && item.metadata.screenplay.task?.status !== "unknown")) {
                if (disposed || scope.current !== projectId) return;
                if (!node.metadata?.screenplay?.task?.taskId && submitting.current.has(node.id)) continue;
                try { await recover(node.id); }
                catch (error) {
                    if (!disposed && scope.current === projectId && nodesRef.current.some((item) => item.id === node.id)) {
                        const current = get(node.id).workflow;
                        patch(node.id, { ...current, task: current.task ? { ...current.task, error: errorText(error) } : undefined });
                    }
                }
            }
            if (!disposed) nextTimer = setTimeout(poll, 5000);
        }, 1000);
        let nextTimer: ReturnType<typeof setTimeout> | undefined;
        return () => { disposed = true; clearTimeout(timer); clearTimeout(nextTimer); };
    }, [pendingKey, projectId, nodesRef, get, patch, recover]);
    useEffect(() => {
        scope.current = projectId;
        setWorkspaceId(null); setVisibleId(null);
        return () => { scope.current = ""; };
    }, [projectId]);

    const agentAction = useCallback(async (request: ScreenplayAgentRequest) => {
        if (request.action === "create") return { nodeId: create(undefined, undefined, { title: request.title || "未命名剧本", brief: request.brief || "", source: request.source || "", genre: request.genre || "", audience: request.audience || "", tone: request.tone || "", mode: request.mode || "original", episodeCount: request.episodeCount ?? 6, targetSeconds: request.targetSeconds ?? 120 }), status: "created" };
        if (!request.nodeId) throw new Error("请提供真实剧本节点 ID");
        const { workflow } = get(request.nodeId);
        if (request.action === "read") {
            const episode = request.episodeId ? workflow.document.episodes.find((item) => item.id === request.episodeId) : undefined;
            if (request.episodeId && !episode) throw new Error("分集不存在");
            return episode ? { revision: workflow.document.revision, assets: workflow.document.assets, episode } : screenplaySummary(workflow);
        }
        if (request.action === "open") { open(request.nodeId); return screenplaySummary(workflow); }
        if (request.action === "bind_asset") {
            if (request.revision === undefined || !workflow.document.assets.some((asset) => asset.id === request.assetId)) throw new Error("请提供真实资产 ID 和读取到的版本");
            save(request.nodeId, { ...workflow.document, assets: workflow.document.assets.map((asset) => asset.id === request.assetId ? { ...asset, referenceNodeId: request.referenceNodeId || undefined } : asset) }, request.revision, "Agent · 资产绑定");
            return screenplaySummary(get(request.nodeId).workflow);
        }
        if (request.action === "save_novel") {
            if (request.revision === undefined || !request.episodeId || typeof request.novelText !== "string") throw new Error("保存小说须提供版本、分集ID及完整小说正文");
            if (!workflow.document.episodes.some((item) => item.id === request.episodeId)) throw new Error("目标分集不存在");
            save(request.nodeId, { ...workflow.document, episodes: workflow.document.episodes.map((item) => item.id === request.episodeId ? { ...item, novelText: request.novelText } : item) }, request.revision, "Agent · 小说正文编辑");
        } else if (request.action === "save_scene") {
            if (request.revision === undefined || !request.episodeId || !request.sceneId || !request.scene) throw new Error("保存场次须提供版本、分集ID、场次ID及完整场次");
            const scene = validateScene(request.scene, workflow.document.assets);
            const episode = workflow.document.episodes.find((item) => item.id === request.episodeId);
            if (scene.id !== request.sceneId || !episode?.scenes.some((item) => item.id === request.sceneId)) throw new Error("目标场次不匹配");
            save(request.nodeId, { ...workflow.document, episodes: workflow.document.episodes.map((item) => item.id === episode.id ? { ...item, scenes: item.scenes.map((old) => old.id === scene.id ? scene : old) } : item) }, request.revision, "Agent · 场次编辑");
        } else if (request.action === "approve") {
            if (request.revision === undefined) throw new Error("确认须提供真实版本");
            approve(request.nodeId, request.revision);
        } else if (request.action === "extract_assets") return extractAssets(request.nodeId);
        else return generate(request.nodeId, { action: request.action, episodeId: request.episodeId, sceneId: request.sceneId, instruction: request.instruction, model: request.model, replaceExistingScenes: request.replaceExistingScenes });
        return screenplaySummary(get(request.nodeId).workflow);
    }, [create, get, open, save, approve, extractAssets, generate]);
    return { create, open, visibleId, workspaceNode: nodes.find((node) => node.id === workspaceId && node.metadata?.screenplay), save, approve, extractAssets, generate, recover, cancel, resolveResult, agentAction };
}
