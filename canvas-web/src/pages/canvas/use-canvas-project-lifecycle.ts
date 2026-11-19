import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { App } from "antd";
import { useNavigate } from "react-router";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { hydrateAssistantImages, hydrateCanvasImages, resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { normalizeDefaultMediaNodes } from "@/lib/canvas/canvas-project-domain";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { createCanvasProjectWithRemoteSync, deleteCanvasProjectWithRemoteSync, refreshRemoteCanvasProject, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { flushTeamCanvas } from "@/services/team-canvas-session";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasNodeMetadata, ViewportTransform } from "@/types/canvas";
import type { CanvasHistorySnapshot } from "./use-canvas-history";

type UseCanvasProjectLifecycleOptions = {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    viewportRef: MutableRefObject<ViewportTransform>;
    historyPausedRef: MutableRefObject<boolean>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setChatSessions: Dispatch<SetStateAction<CanvasAssistantSession[]>>;
    setActiveChatId: Dispatch<SetStateAction<string | null>>;
    setBackgroundMode: Dispatch<SetStateAction<CanvasBackgroundMode>>;
    setShowImageInfo: Dispatch<SetStateAction<boolean>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setProjectLoaded: Dispatch<SetStateAction<boolean>>;
    resetHistory: (snapshot: CanvasHistorySnapshot) => void;
    cleanupAssetImages: (options?: unknown) => void;
    cleanupCanvasFiles: (extra?: unknown) => void;
};

export function useCanvasProjectLifecycle({
    projectId,
    projectLoaded,
    nodes,
    connections,
    chatSessions,
    activeChatId,
    backgroundMode,
    showImageInfo,
    viewport,
    nodesRef,
    connectionsRef,
    viewportRef,
    historyPausedRef,
    setNodes,
    setConnections,
    setChatSessions,
    setActiveChatId,
    setBackgroundMode,
    setShowImageInfo,
    setViewport,
    setProjectLoaded,
    resetHistory,
    cleanupAssetImages,
    cleanupCanvasFiles,
}: UseCanvasProjectLifecycleOptions) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const [addedSkills, setAddedSkills] = useState<Skill[]>([]);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingRemoteProjectRef = useRef(false);

    useEffect(() => {
        if (!hydrated) return;
        let cancelled = false;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            navigate("/canvas", { replace: true });
            return;
        }

        const applyRestoredProject = (restoredNodes: CanvasNodeData[], restoredSessions: CanvasAssistantSession[]) => {
            if (cancelled) return;
            const snapshot: CanvasHistorySnapshot = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: "blank",
                showImageInfo: project.showImageInfo || false,
            };
            nodesRef.current = snapshot.nodes;
            connectionsRef.current = snapshot.connections;
            viewportRef.current = project.viewport;
            setNodes(snapshot.nodes);
            setConnections(snapshot.connections);
            setChatSessions(snapshot.chatSessions);
            setActiveChatId(snapshot.activeChatId);
            setBackgroundMode(snapshot.backgroundMode);
            setShowImageInfo(snapshot.showImageInfo);
            setViewport(project.viewport);
            resetHistory(snapshot);
            setProjectLoaded(true);
        };

        const restore = async () => {
            const initialNodes = normalizeDefaultMediaNodes(normalizeImportedVideoNodeLayout(resetInterruptedGeneration(project.nodes)));
            const initialSessions = project.chatSessions || [];

            // 先恢复可交互的节点和布局，媒体缓存/资源校验放到后台，避免首屏被远程资源拖住。
            applyRestoredProject(initialNodes, initialSessions);
            const [nodesResult, sessionsResult] = await Promise.allSettled([hydrateCanvasImages(initialNodes), hydrateAssistantImages(initialSessions)]);
            if (cancelled) return;
            if (nodesResult.status === "fulfilled") setNodes((current) => mergeHydratedNodeMedia(current, initialNodes, nodesResult.value));
            if (sessionsResult.status === "fulfilled") setChatSessions((current) => mergeHydratedSessions(current, sessionsResult.value));
            if (nodesResult.status === "rejected" || sessionsResult.status === "rejected") message.warning("部分本地媒体恢复失败，已使用项目记录继续打开");
        };
        void restore();
        return () => {
            cancelled = true;
        };
    }, [hydrated, message, navigate, openProject, projectId, resetHistory, setActiveChatId, setBackgroundMode, setChatSessions, setConnections, setNodes, setShowImageInfo, setViewport]);

    useEffect(() => {
        if (!projectLoaded) return;
        let cancelled = false;
        listAddedSkills()
            .then(({ skills }) => {
                if (!cancelled) setAddedSkills(skills);
            })
            .catch(() => {
                if (!cancelled) setAddedSkills([]);
            });
        return () => {
            cancelled = true;
        };
    }, [projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode: "blank", showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, historyPausedRef, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const pollRemoteProject = async () => {
            try {
                const remoteProject = await refreshRemoteCanvasProject(projectId);
                if (!cancelled && remoteProject) {
                    const snapshot: CanvasHistorySnapshot = {
                        nodes: remoteProject.nodes,
                        connections: remoteProject.connections,
                        chatSessions: remoteProject.chatSessions || [],
                        activeChatId: remoteProject.activeChatId || null,
                        backgroundMode: "blank",
                        showImageInfo: remoteProject.showImageInfo || false,
                    };
                    // Reset the undo baseline for an external agent write and
                    // pause the persistence effect for this one React commit.
                    resetHistory(snapshot);
                    historyPausedRef.current = true;
                    applyingRemoteProjectRef.current = true;
                    nodesRef.current = snapshot.nodes;
                    connectionsRef.current = snapshot.connections;
                    viewportRef.current = remoteProject.viewport;
                    setNodes(snapshot.nodes);
                    setConnections(snapshot.connections);
                    setChatSessions(snapshot.chatSessions);
                    setActiveChatId(snapshot.activeChatId);
                    setBackgroundMode(snapshot.backgroundMode);
                    setShowImageInfo(snapshot.showImageInfo);
                    setViewport(remoteProject.viewport);
                }
            } catch {
                // A transient poll failure must not interrupt the open canvas;
                // the next scheduled poll retries the same project.
            } finally {
                if (!cancelled) timer = setTimeout(() => void pollRemoteProject(), 2000);
            }
        };

        timer = setTimeout(() => void pollRemoteProject(), 2000);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [connectionsRef, historyPausedRef, projectId, projectLoaded, resetHistory, setActiveChatId, setBackgroundMode, setChatSessions, setConnections, setNodes, setShowImageInfo, setViewport, viewportRef, nodesRef]);

    useEffect(() => {
        if (!applyingRemoteProjectRef.current) return;
        applyingRemoteProjectRef.current = false;
        historyPausedRef.current = false;
    }, [activeChatId, backgroundMode, chatSessions, connections, historyPausedRef, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport, viewportRef]);

    useEffect(() => () => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        updateProject(projectId, { viewport: viewportRef.current });
    }, [projectId, projectLoaded, updateProject, viewportRef]);

    const createAndOpenProject = useCallback(() => {
        void createCanvasProjectWithRemoteSync(`自由画布 ${useCanvasStore.getState().projects.length + 1}`).then(({ id, syncError }) => {
            if (syncError) message.warning(syncError instanceof Error ? `画布已在本地创建，云端同步失败：${syncError.message}` : "画布已在本地创建，云端同步失败");
            navigate(`/canvas/${id}`);
        });
    }, [message, navigate]);

    const deleteCurrentProject = useCallback(() => {
        if (projectId.startsWith("tc_")) { message.info("团队作品请到团队项目中管理与回收"); return; }
        const drawingIds = nodesRef.current.flatMap((node) => node.type === "drawing" && node.metadata?.drawingId ? [node.metadata.drawingId] : []);
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId)))
                .catch(() => message.warning("项目已删除，但部分本地绘图缓存清理失败"));
        }
        cleanupAssetImages();
        void deleteCanvasProjectWithRemoteSync(projectId).catch(() => message.warning("画布已从本地移除，云端删除将在后台重试"));
        navigate("/canvas");
    }, [cleanupAssetImages, message, navigate, nodesRef, projectId]);

    const renameCurrentProject = useCallback((title: string) => {
        renameProject(projectId, title);
    }, [projectId, renameProject]);

    const saveCanvasProject = useCallback(async () => {
        try {
            updateProject(projectId, {
                nodes: nodesRef.current,
                connections: connectionsRef.current,
                chatSessions,
                activeChatId,
                backgroundMode: "blank",
                showImageInfo,
                viewport: viewportRef.current,
                directorScenes: currentProject?.directorScenes || [],
                previsScenes: currentProject?.previsScenes || [],
            });
            await flushCanvasStorePersistence();
        } catch {
            message.error("画布保存失败，请稍后重试");
            return;
        }
        try {
            if (projectId.startsWith("tc_")) await flushTeamCanvas(projectId);
            else await saveRemoteUserDataNow();
            message.success("画布布局和位置已保存");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "未知错误";
            message.warning(`本地画布布局已保存，云端同步失败：${detail}`);
        }
    }, [activeChatId, backgroundMode, chatSessions, connectionsRef, currentProject?.directorScenes, currentProject?.previsScenes, message, nodesRef, projectId, showImageInfo, updateProject, viewportRef]);

    const clearCanvasFiles = useCallback(() => {
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, projectId]);

    return {
        addedSkills,
        clearCanvasFiles,
        createAndOpenProject,
        currentProject,
        deleteCurrentProject,
        renameCurrentProject,
        saveCanvasProject,
        updateProject,
    };
}

/**
 * 修复旧版“添加到画布”视频节点的几何数据。
 *
 * 旧节点在视频元数据尚未返回宽高时使用了 480×480 的方形回退值，
 * 播放器会因此在 16:9 视频上下留下大块黑边。只迁移带有素材导入
 * 标记且没有真实宽高的旧节点，不影响用户主动选择的 1:1 视频节点。
 */
function normalizeImportedVideoNodeLayout(nodes: CanvasNodeData[]) {
    const defaultSize = NODE_DEFAULT_SIZE.video;
    let changed = false;
    const normalized = nodes.map((node) => {
        const metadata = node.metadata;
        const isLegacySquareImport = node.type === "video"
            && metadata?.generationMode === "video"
            && Boolean(metadata.assetId)
            && !(metadata.naturalWidth && metadata.naturalHeight)
            && Math.abs(node.width - node.height) < 1
            && Math.abs(node.width - defaultSize.width) < 1;
        if (!isLegacySquareImport) return node;
        changed = true;
        return {
            ...node,
            width: defaultSize.width,
            height: defaultSize.height,
            position: {
                x: node.position.x + (node.width - defaultSize.width) / 2,
                y: node.position.y + (node.height - defaultSize.height) / 2,
            },
        };
    });
    return changed ? normalized : nodes;
}

const hydratedMediaMetadataKeys = ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs"] as const satisfies readonly (keyof CanvasNodeMetadata)[];

function mergeHydratedNodeMedia(currentNodes: CanvasNodeData[], initialNodes: CanvasNodeData[], hydratedNodes: CanvasNodeData[]) {
    const initialById = new Map(initialNodes.map((node) => [node.id, node]));
    const hydratedById = new Map(hydratedNodes.map((node) => [node.id, node]));
    return currentNodes.map((node) => {
        const initial = initialById.get(node.id);
        const hydrated = hydratedById.get(node.id);
        if (!initial || !hydrated || node.metadata?.content !== initial.metadata?.content) return node;
        const metadata = { ...node.metadata } as CanvasNodeMetadata;
        hydratedMediaMetadataKeys.forEach((key) => {
            const value = hydrated.metadata?.[key];
            if (value !== undefined) (metadata as Record<string, unknown>)[key] = value;
        });
        return { ...node, metadata };
    });
}

function mergeHydratedSessions(currentSessions: CanvasAssistantSession[], hydratedSessions: CanvasAssistantSession[]) {
    const hydratedById = new Map(hydratedSessions.map((session) => [session.id, session]));
    return currentSessions.map((session) => {
        const hydrated = hydratedById.get(session.id);
        if (!hydrated) return session;
        const hydratedMessages = new Map(hydrated.messages.map((message) => [message.id, message]));
        return {
            ...session,
            messages: session.messages.map((message) => {
                const hydratedMessage = hydratedMessages.get(message.id);
                if (!hydratedMessage || !message.references?.length) return message;
                const hydratedReferences = new Map((hydratedMessage.references || []).map((reference) => [reference.id, reference]));
                return {
                    ...message,
                    references: message.references.map((reference) => {
                        const hydratedReference = hydratedReferences.get(reference.id);
                        return hydratedReference ? { ...reference, dataUrl: hydratedReference.dataUrl, storageKey: hydratedReference.storageKey } : reference;
                    }),
                };
            }),
        };
    });
}
