import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { uploadMediaFile } from "@/services/file-storage";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import copyToClipboard from "copy-to-clipboard";
import { nanoid } from "nanoid";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { persistCanvasMediaPerformanceMode, readCanvasMediaPerformanceMode } from "@/lib/canvas/canvas-performance-mode";
import { summarizeCanvasContext } from "@/lib/canvas/canvas-context-summary";
import { refreshCanvasCharacterReferenceNodes } from "@/lib/canvas/canvas-character-reference";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import { App } from "antd";
import { getNodeSpec } from "@/constant/canvas";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasAssistantPanel } from "@/components/canvas/canvas-assistant-panel";
import { CanvasAgentFloatingWindow } from "./canvas-agent-floating-window";
import { DEFAULT_CANVAS_AGENT_FLOATING_SIZE, restoreCanvasAgentFloatingSize } from "@/lib/canvas/canvas-agent-floating-window";
import { AssistantPanelColumn, getPanelWidthBounds } from "./canvas-assistant-panel-column";
import { CanvasAssetTray } from "@/components/canvas/canvas-asset-tray";
import { CanvasProjectSidebar } from "@/components/canvas/canvas-project-sidebar";
import { CanvasProjectAssetModal } from "@/components/canvas/canvas-project-asset-modal";
import { CanvasCharacterReferenceNodeContent } from "@/components/canvas/canvas-character-reference-node";
import { CanvasCharacterReferenceModal } from "@/components/canvas/canvas-character-reference-modal";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { resolveProjectCanvasStyle } from "@/components/canvas/canvas-style-picker-modal";
import { createStyleProfileSnapshot, resolveStyleProfile, serializeStyleProfile } from "@/lib/canvas/style-profile";
import { CanvasNodeToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-toolbar";
import { CanvasSubtitleDialog } from "@/components/canvas/canvas-subtitle-dialog";
import { CanvasVideoSegmentDialog } from "@/components/canvas/canvas-video-segment-dialog";
import { CanvasVideoAnalysisNode } from "@/components/canvas/canvas-video-analysis-node";
import { useCanvasVideoAnalysis } from "./use-canvas-video-analysis";
import { useCanvasVideoSuperResolution } from "./use-canvas-video-super-resolution";
import { CanvasViralVideoAnalysisNode } from "@/components/canvas/canvas-viral-video-analysis-node";
import { CanvasViralVideoWorkspace } from "@/components/canvas/canvas-viral-video-workspace";
import { CanvasViralVideoImportDialog } from "@/components/canvas/canvas-viral-video-import-dialog";
import { GenerationCostIndicator } from "@/components/generation-cost-indicator";
import { estimateViralVideoGeneration } from "@/lib/canvas/canvas-viral-video-pricing";
import { VIRAL_VIDEO_ANALYSIS_CREDITS, VIRAL_VIDEO_ANALYSIS_MODEL_LABEL } from "@/lib/canvas/canvas-viral-video-policy";
import { useCanvasViralVideo } from "./use-canvas-viral-video";
import { useCanvasScreenplay } from "./use-canvas-screenplay";
import { CanvasScreenplayNode } from "@/components/canvas/canvas-screenplay-node";
import { CanvasScreenplayWorkspace } from "@/components/canvas/canvas-screenplay-workspace";
import type { ViralVideoAgentRequest } from "@/types/canvas-viral-video";
import { CanvasVideoSubtitleRemovalDialog } from "@/components/canvas/canvas-video-subtitle-removal-dialog";
import { CanvasTimelineDialog } from "@/components/canvas/canvas-timeline-dialog";
import { syncNodeSubtitlesToTimeline } from "@/lib/timeline/timeline-build";
import { applyCompletedTimelineReplacements } from "@/lib/timeline/timeline-versions";
import type { TimelineDirectMedia } from "@/types/timeline";
import { CanvasNodeAnglePanel } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasTextEditorModal } from "@/components/canvas/canvas-text-editor-modal";
import { CanvasNodeSearchModal } from "@/components/canvas/canvas-node-search-modal";
import { CanvasStylePickerModal } from "@/components/canvas/canvas-style-picker-modal";
import { CanvasFileDropOverlay } from "@/components/canvas/canvas-file-drop-overlay";
import { CanvasUploadModal } from "@/components/canvas/canvas-upload-modal";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasLibraryPanel } from "@/components/canvas/canvas-library-panel";
import { instantiateLibraryTemplate } from "@/lib/canvas/library-insertion";
import { getProject } from "@/services/api/projects";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { CanvasShareModal } from "@/components/canvas/canvas-share-modal";
import { CanvasScriptEditor, CanvasScriptNodeContent, STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT, storyboardMinNodeHeight, storyboardTableHeight } from "@/components/canvas/canvas-script-node";
import { CanvasPrevisNodePanel } from "@/components/canvas/previs/canvas-previs-node-panel";
import { CanvasPrevisTemplateModal } from "@/components/canvas/previs/canvas-previs-template-modal";
import { directorSceneToPrevisScene } from "@/lib/canvas/previs/previs-legacy-migration";
import { CanvasVersionCompareModal } from "@/components/canvas/canvas-version-compare-modal";
import { CanvasLocalAgentPanel } from "@/components/canvas/canvas-local-agent-panel";
import { useFocusMode } from "@/hooks/use-focus-mode";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasConnectionCreateMenu, CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasLeaferGraphicsLayer } from "@/components/canvas/canvas-leafer-graphics-layer";
import { CanvasLinkedProjectEmptyState, CanvasShortDramaGuide, CanvasStartEmptyState, CanvasStoryInputNodeContent, CanvasStylePlaceholderNodeContent } from "@/components/canvas/canvas-short-drama-entry";
import { createCanvasNode, getInputSummary, isHiddenBatchChild, persistCanvasWorkspaceMode, readCanvasWorkspaceMode } from "@/lib/canvas/canvas-project-domain";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasAgentChangeToast, CanvasMergeStatusToast, CanvasUploadStatusToast } from "./canvas-project-feedback";
import { backendProviderConfig, getGenerationCount } from "@/lib/canvas/canvas-project-generation";
import { CanvasTopBar } from "./canvas-project-top-bar";
import { CanvasFocusModeBar } from "@/components/canvas/canvas-focus-mode-bar";
import { CanvasProjectContextMenu } from "./canvas-project-context-menu";
import { CanvasProjectMediaDialogs } from "./canvas-project-media-dialogs";
import { CanvasProjectSelectionToolbar } from "./canvas-project-selection-toolbar";
import { CanvasProjectStatusDialogs } from "./canvas-project-status-dialogs";
import { CanvasProjectWorldLayers } from "./canvas-project-world-layers";
import { CanvasRefreshShell } from "./canvas-refresh-shell";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import { CanvasEmotionWorkspace } from "@/components/canvas/canvas-emotion-workspace";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { useCanvasConnectionController } from "./use-canvas-connection-controller";
import { useCanvasAgentOperations } from "./use-canvas-agent-operations";
import { useCanvasAssistantVisibility } from "./use-canvas-assistant-visibility";
import { useCanvasStyleWorkflow } from "./use-canvas-style-workflow";
import { useCanvasPrevis } from "./use-canvas-previs";
import { useCanvasGeneration } from "./use-canvas-generation";
import { useCanvasGenerationBatches } from "./use-canvas-generation-batches";
import { useCanvasGenerationExecutor } from "./use-canvas-generation-executor";
import { useCanvasGenerationRetry } from "./use-canvas-generation-retry";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasKeyboard } from "./use-canvas-keyboard";
import { useCanvasMediaTools } from "./use-canvas-media-tools";
import { useCanvasNodeEditor } from "./use-canvas-node-editor";
import { useCanvasNodeOperations } from "./use-canvas-node-operations";
import { useCanvasProjectLifecycle } from "./use-canvas-project-lifecycle";
import { TeamCanvasSession } from "@/components/canvas/team-canvas-session";
import { useCanvasBlenderBridge } from "./use-canvas-blender-bridge";
import { useCanvasRenderModel } from "./use-canvas-render-model";
import { useCanvasSelectionController } from "./use-canvas-selection-controller";
import { useCanvasShortDrama } from "./use-canvas-short-drama";
import { useCanvasStoryboard } from "./use-canvas-storyboard";
import { useCanvasUpload } from "./use-canvas-upload";
import { useCanvasViewportController } from "./use-canvas-viewport-controller";
import {
    CanvasNodeType,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasMediaPerformanceMode,
    type StoryboardColumn,
    type StoryboardShotCount,
    type StoryboardShotDuration,
    type CanvasWorkflowKind,
    type CanvasWorkspaceMode,
    type CanvasToolMode,
    type ContextMenuState,
    type Position,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

const CanvasPrevisWorkbench = lazy(() => import("@/components/canvas/previs/canvas-previs-workbench").then((module) => ({ default: module.CanvasPrevisWorkbench })));
const CanvasDrawingEditorModal = lazy(() => import("@/components/canvas/canvas-drawing-editor-modal").then((module) => ({ default: module.CanvasDrawingEditorModal })));

const NODE_STATUS_SUCCESS = "success" as const;
const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];
const ASSISTANT_WIDTH_STORAGE_KEY = "lalor-canvas-agent-panel-width";
const ASSISTANT_FLOATING_SIZE_STORAGE_KEY = "lalor-canvas-agent-floating-size";

function visibleGenerationBatch(node: CanvasNodeData) {
    const batches = node.metadata?.generationBatches || [];
    for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (batches[index].status === "queued" || batches[index].status === "running") return batches[index];
    }
    return batches.at(-1);
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);
    const { id = "" } = useParams();

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return id.startsWith("tc_") ? <TeamCanvasSession key={id} id={id}><InfiniteCanvasPage /></TeamCanvasSession> : <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    const params = useParams<{ id: string }>();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const localAgentConnected = useCanvasAgentStore((state) => state.connected);
    const localAgentActivity = useCanvasAgentStore((state) => state.activity);
    const localAgentEnabled = useCanvasAgentStore((state) => state.enabled);
    const containerRef = useRef<HTMLDivElement>(null);
    const didInitialCenterRef = useRef(false);
    // Focus nodes handed off by callers (for example, after adding a
    // generated result to this canvas) once the project has hydrated.
    const didFocusQueryNodesRef = useRef(false);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const assets = useAssetStore((state) => state.assets);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const theme = canvasThemes.dark;
    const defaultDrawingEngine = useUserStore((state) => state.drawingEngine.defaultEngine);
    const shortDramaEnabled = useUserStore((state) => state.features.shortDramaEnabled) && !projectId.startsWith("tc_");
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("blank");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [canvasTool, setCanvasTool] = useState<CanvasToolMode>("move");
    const [mediaPerformanceMode, setMediaPerformanceMode] = useState<CanvasMediaPerformanceMode>(readCanvasMediaPerformanceMode);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [workspaceMode, setWorkspaceMode] = useState<CanvasWorkspaceMode>(readCanvasWorkspaceMode);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [nodeSearchOpen, setNodeSearchOpen] = useState(false);
    const [viralVideoImportOpen, setViralVideoImportOpen] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [textEditorNodeId, setTextEditorNodeId] = useState<string | null>(null);
    const [characterReferenceNodeId, setCharacterReferenceNodeId] = useState<string | null>(null);
    const [drawingNodeId, setDrawingNodeId] = useState<string | null>(null);
    const [stylePickerOpen, setStylePickerOpen] = useState(false);
    const [projectAssetOpen, setProjectAssetOpen] = useState(false);
    const [projectAssetInitialCategory, setProjectAssetInitialCategory] = useState("all");
    const [projectAssetInsertPosition, setProjectAssetInsertPosition] = useState<Position | undefined>();
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [subtitleNodeId, setSubtitleNodeId] = useState<string | null>(null);
    const [timelineNodeId, setTimelineNodeId] = useState<string | null>(null);
    const [subtitleRemovalNodeId, setSubtitleRemovalNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    // 原图只在用户聚焦/放大媒体时启用；普通画布浏览继续使用缩略图和轻量播放源。
    const [originalMediaNodeIds, setOriginalMediaNodeIds] = useState<Set<string>>(new Set());
    const [scriptEditorNodeId, setScriptEditorNodeId] = useState<string | null>(null);
    const [scriptScrollTopById, setScriptScrollTopById] = useState<Record<string, number>>({});
    const [previsNodeId, setPrevisNodeId] = useState<string | null>(null);
    const [previsTemplateRequest, setPrevisTemplateRequest] = useState<{ position?: Position } | null>(null);
    const [versionCompareRootId, setVersionCompareRootId] = useState<string | null>(null);
    const codexAutoConnect = ["new", "recent", "choose"].includes(searchParams.get("mode") || "");
    const codexCompactAgent = codexAutoConnect && searchParams.has("agentUrl");
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [shortcutRequestNonce, setShortcutRequestNonce] = useState(0);
    const [cinematicAgentEntry, setCinematicAgentEntry] = useState(false);
    // 面板初始宽度根据视口宽度动态选择，避免小屏幕上初始就过宽
    const [assistantWidth, setAssistantWidth] = useState(() => {
        const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
        const stored = typeof window !== "undefined" ? Number(window.localStorage.getItem(ASSISTANT_WIDTH_STORAGE_KEY)) : NaN;
        if (Number.isFinite(stored) && stored > 0) return stored;
        if (vw < 768) return 300;
        if (vw < 1024) return 360;
        return Math.min(760, Math.max(420, Math.round(vw * 0.49)));
    });
    const [assistantFloatingSize, setAssistantFloatingSize] = useState(() => {
        if (typeof window === "undefined") return DEFAULT_CANVAS_AGENT_FLOATING_SIZE;
        try {
            return restoreCanvasAgentFloatingSize(JSON.parse(window.localStorage.getItem(ASSISTANT_FLOATING_SIZE_STORAGE_KEY) || "{}"));
        } catch {
            return DEFAULT_CANVAS_AGENT_FLOATING_SIZE;
        }
    });
    useEffect(() => {
        if (typeof window !== "undefined") window.localStorage.setItem(ASSISTANT_WIDTH_STORAGE_KEY, String(Math.round(assistantWidth)));
    }, [assistantWidth]);
    useEffect(() => {
        if (typeof window !== "undefined") window.localStorage.setItem(ASSISTANT_FLOATING_SIZE_STORAGE_KEY, JSON.stringify(assistantFloatingSize));
    }, [assistantFloatingSize]);
    // 窗口跨越断点时把面板宽度 clamp 到当前断点的合理区间，避免宽屏值在窄屏挤压画布
    useEffect(() => {
        const clamp = () => {
            const { min, max } = getPanelWidthBounds();
            setAssistantWidth((prev) => (prev < min ? min : prev > max ? max : prev));
        };
        window.addEventListener("resize", clamp);
        return () => window.removeEventListener("resize", clamp);
    }, []);
    const { agentMode, assistantClosing, assistantExpanded, assistantMounted, assistantOpen, closeAgent, collapseAgentToFloating, expandAgent, openAgent: openPersonalAgent, setAgentMode } = useCanvasAssistantVisibility();
    const openAgent = useCallback((...args: Parameters<typeof openPersonalAgent>) => {
        if (projectId.startsWith("tc_")) { message.info("团队画布请使用节点生成，暂不支持个人助手"); return; }
        openPersonalAgent(...args);
    }, [projectId, message, openPersonalAgent]);
    const { focusMode, enterFocusMode, exitFocusMode, toggleFocusMode } = useFocusMode();
    const [focusDockRevealed, setFocusDockRevealed] = useState(false);

    useEffect(() => {
        persistCanvasWorkspaceMode(workspaceMode);
    }, [workspaceMode]);

    useEffect(() => {
        persistCanvasMediaPerformanceMode(mediaPerformanceMode);
    }, [mediaPerformanceMode]);

    useEffect(() => {
        didInitialCenterRef.current = false;
        didFocusQueryNodesRef.current = false;
    }, [projectId]);

    useEffect(() => {
        const openSearch = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
            event.preventDefault();
            setNodeSearchOpen(true);
        };
        window.addEventListener("keydown", openSearch);
        return () => window.removeEventListener("keydown", openSearch);
    }, []);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>(null);

    const { getHistoryCleanupContext, historyPausedRef, historyState, redoCanvas, resetHistory, undoCanvas } = useCanvasHistory({
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        backgroundMode,
        showImageInfo,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        setBackgroundMode,
        setShowImageInfo,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, ...getHistoryCleanupContext() });
        },
        [cleanupAssetImages, getHistoryCleanupContext],
    );

    const { addedSkills, clearCanvasFiles, createAndOpenProject, currentProject, deleteCurrentProject, renameCurrentProject, saveCanvasProject, updateProject } = useCanvasProjectLifecycle({
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
    });
    const setAgentNodes: typeof setNodes = useCallback((updater) => {
        const nextNodes = typeof updater === "function" ? updater(nodesRef.current) : updater;
        nodesRef.current = nextNodes;
        updateProject(projectId, { nodes: nextNodes });
        setNodes(nextNodes);
    }, [nodesRef, projectId, setNodes, updateProject]);
    const setAgentConnections: typeof setConnections = useCallback((updater) => {
        const nextConnections = typeof updater === "function" ? updater(connectionsRef.current) : updater;
        connectionsRef.current = nextConnections;
        updateProject(projectId, { connections: nextConnections });
        setConnections(nextConnections);
    }, [connectionsRef, projectId, setConnections, updateProject]);
    const linkedProjectId = shortDramaEnabled ? currentProject?.projectId || "" : "";
    const linkedProjectQuery = useQuery({ queryKey: ["project", linkedProjectId], queryFn: () => getProject(linkedProjectId), enabled: Boolean(linkedProjectId) });
    const refetchLinkedProject = linkedProjectQuery.refetch;
    useEffect(() => {
        if (!projectLoaded || !linkedProjectQuery.data) return;
        setNodes((current) => refreshCanvasCharacterReferenceNodes(current, linkedProjectQuery.data.assets));
    }, [linkedProjectQuery.data, projectLoaded, setNodes]);
    const canvasContext = useMemo(() => summarizeCanvasContext(nodes, selectedNodeIds, linkedProjectQuery.data?.units), [linkedProjectQuery.data?.units, nodes, selectedNodeIds]);

    const { bindGenerationTask, cancelNodeTask, confirmStopGeneration, finishGenerationRequest, openNodeTaskDetails, runningNodeId, setRunningNodeId, setTaskDetail, startGenerationRequest, taskDetail, taskDetailLoading, taskDetailLogs } =
        useCanvasGeneration({ projectId, domainProjectId: linkedProjectId, projectLoaded, nodes, nodesRef, setNodes: setAgentNodes });
    const videoSuperResolution = useCanvasVideoSuperResolution({ projectId, nodesRef, setNodes: setAgentNodes, setConnections, setSelectedNodeIds });

    useEffect(() => {
        const currentTimeline = currentProject?.timeline;
        if (!projectLoaded || !currentTimeline) return;
        const nextTimeline = applyCompletedTimelineReplacements(currentTimeline, nodes);
        if (nextTimeline !== currentTimeline) updateProject(projectId, { timeline: nextTimeline });
    }, [currentProject?.timeline, nodes, projectId, projectLoaded, updateProject]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (searchParams.has("agentUrl")) {
            setAgentMode("local");
            return;
        }
        openAgent("local");
    }, [openAgent, projectLoaded, searchParams, setAgentMode]);

    // 沉浸专注进入时收起智能体与小地图、重置 Dock 唤出态；仅响应「进入」瞬间，避免关闭专注内主动唤出的面板。
    const prevFocusModeRef = useRef(focusMode);
    useEffect(() => {
        const enteredFocus = focusMode && !prevFocusModeRef.current;
        prevFocusModeRef.current = focusMode;
        if (!enteredFocus) return;
        closeAgent();
        setIsMiniMapOpen(false);
        setFocusDockRevealed(false);
    }, [closeAgent, focusMode]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
    }, [nodes, connections, selectedNodeIds, viewport]);

    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize((current) => (current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                const current = viewportRef.current;
                if (current.x === 0 && current.y === 0 && current.k === 1) {
                    const centered = { x: rect.width / 2, y: rect.height / 2, k: 1 };
                    viewportRef.current = centered;
                    setViewport(centered);
                }
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const {
        fitCanvasContent,
        fitCanvasSelection,
        focusCanvasImageNode,
        focusCanvasMediaNodeInView,
        focusCanvasNode,
        getCanvasCenter,
        handleCanvasDoubleClick,
        handleViewportChange,
        handleViewportPreviewChange,
        nodeVisibilityViewport,
        previewViewport,
        resetViewport,
        screenToCanvas,
        setZoomScale,
        zoomCanvasIn,
        zoomCanvasOut,
        zoomToActualSize,
    } = useCanvasViewportController({
        containerRef,
        size,
        viewport,
        viewportRef,
        nodesRef,
        selectedNodeIdsRef,
        setViewport,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setToolbarNodeId,
    });

    useCanvasBlenderBridge({ projectId, projectLoaded, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, selectedNodeIdsRef, focusSelection: fitCanvasSelection });

    useEffect(() => {
        if (!projectLoaded || didFocusQueryNodesRef.current) return;
        const raw = searchParams.get("focusNodeIds") || searchParams.get("focusNodeId");
        if (!raw) return;
        const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
        if (!requested.length) return;
        const available = requested.filter((id) => nodesRef.current.some((node) => node.id === id));
        // Wait for restored nodes to become available instead of consuming the
        // request while the initial hydration pass is still in flight.
        if (!available.length) return;
        didFocusQueryNodesRef.current = true;
        const selection = new Set(available);
        selectedNodeIdsRef.current = selection;
        setSelectedNodeIds(selection);
        window.requestAnimationFrame(() => {
            if (available.length === 1) focusCanvasNode(available[0]);
            else fitCanvasSelection();
        });
    }, [fitCanvasSelection, focusCanvasNode, nodes, projectLoaded, searchParams, setSelectedNodeIds]);

    useEffect(() => {
        const project = linkedProjectQuery.data?.project;
        const preset = resolveProjectCanvasStyle(project?.stylePresetId, project?.styleProfileJson);
        if (!projectLoaded || !preset) return;
        const profile = resolveStyleProfile(project?.stylePresetId, project?.styleProfileJson, preset.profile || createStyleProfileSnapshot(preset));
        if (!profile) return;
        const current = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        const nextMetadata = {
            content: profile.prompt,
            prompt: profile.prompt,
            status: NODE_STATUS_SUCCESS,
            workflowKind: "styleboard" as const,
            workflowTitle: "项目画风",
            workflowDescription: profile.description,
            stylePresetId: profile.presetId,
            styleProfileJson: serializeStyleProfile(profile),
            fontSize: 14,
            locked: true,
        };
        if (current) {
            if (current.metadata?.stylePresetId === profile.presetId && current.metadata?.content === profile.prompt && current.metadata?.styleProfileJson === nextMetadata.styleProfileJson && current.metadata?.locked) return;
            setNodes((nodes) => nodes.map((node) => (node.id === current.id ? { ...node, title: `项目画风 · ${profile.title}`, metadata: { ...node.metadata, ...nextMetadata } } : node)));
            return;
        }
        const node = createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), nextMetadata);
        node.title = `项目画风 · ${profile.title}`;
        node.width = 420;
        node.height = 240;
        setNodes((nodes) => [...nodes, node]);
    }, [getCanvasCenter, linkedProjectQuery.data?.project, projectLoaded, setNodes]);

    const {
        assetPickerOpen,
        closeUploadModal,
        closeAssetPicker,
        createVideoNodeFromBlob,
        createReferenceVideoNode,
        createImageAssetNode,
        fileDropActive,
        handleAssetInsert,
        handleDrop,
        handleFileDragEnter,
        handleFileDragLeave,
        handleFileDragOver,
        handleImageInputChange,
        handleProjectAssetsInsert,
        handleProjectChapterInsert,
        handleUploadFiles,
        handleUploadRequest,
        imageInputRef,
        openAssetsAtPosition,
        pasteAssistantImage,
        pasteSystemClipboard,
        startUploadStatus,
        uploadModalOpen,
        uploadTimelineMedia,
        uploadStatus,
    } = useCanvasUpload({
        canvasId: projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        screenToCanvas,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
    });

    // 时间线弹窗内新增素材的回填通道：素材库/上传创建节点后由弹窗通过 ref 加入草稿。
    const timelineAddNodeRef = useRef<((node: CanvasNodeData) => void) | null>(null);
    // 时间线作用域直连媒体入轨通道：素材库/项目资产/本地上传不落画布，仅加入时间线草稿。
    const timelineMediaAddRef = useRef<((media: TimelineDirectMedia) => void) | null>(null);
    // 素材库与项目资产弹窗的插入作用域：时间线弹窗内打开时为 timeline，其余为 canvas。
    const [assetInsertScope, setAssetInsertScope] = useState<"canvas" | "timeline">("canvas");
    const [projectAssetScope, setProjectAssetScope] = useState<"canvas" | "timeline">("canvas");

    // InsertAssetPayload → 直连媒体：仅音视频支持直接入轨；图片/文本/角色返回 null（避免在画布重复出现）。
    const payloadToTimelineMedia = (payload: InsertAssetPayload): TimelineDirectMedia | null => {
        const randomSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (payload.kind === "video") {
            return {
                id: payload.assetId || `asset-${randomSuffix}`,
                kind: "video",
                title: payload.title,
                storageKey: payload.storageKey,
                url: payload.url,
                width: payload.width,
                height: payload.height,
                durationMs: payload.durationMs,
                bytes: payload.bytes,
                mimeType: payload.mimeType,
            };
        }
        if (payload.kind === "audio") {
            return { id: payload.assetId || `asset-${randomSuffix}`, kind: "audio", title: payload.title, storageKey: payload.storageKey, url: payload.url, durationMs: payload.durationMs, bytes: payload.bytes, mimeType: payload.mimeType };
        }
        return null;
    };

    const handleTimelineAssetInsert = useCallback(
        async (payload: InsertAssetPayload) => {
            if (assetInsertScope === "timeline") {
                const media = payloadToTimelineMedia(payload);
                if (media) {
                    timelineMediaAddRef.current?.(media);
                    closeAssetPicker();
                } else {
                    message.info("图片/文本素材暂不支持直接入轨，请先在画布中添加节点");
                }
                return;
            }
            const node = await handleAssetInsert(payload, { openDialog: false });
            if (node) timelineAddNodeRef.current?.(node);
        },
        [assetInsertScope, closeAssetPicker, handleAssetInsert],
    );

    // 项目资产库引入到时间线：复用现有引入逻辑，把创建出的节点回填到弹窗草稿。
    const handleTimelineProjectAssetsInsert = useCallback(
        async (payloads: InsertAssetPayload[]) => {
            if (projectAssetScope === "timeline") {
                let inserted = 0;
                for (const payload of payloads) {
                    const media = payloadToTimelineMedia(payload);
                    if (media) {
                        timelineMediaAddRef.current?.(media);
                        inserted += 1;
                    }
                }
                if (inserted < payloads.length) message.info("图片/文本/角色素材暂不支持直接入轨，仅音视频素材已加入时间线");
                return;
            }
            const created = await handleProjectAssetsInsert(payloads, projectAssetInsertPosition);
            created.forEach((node) => timelineAddNodeRef.current?.(node));
        },
        [handleProjectAssetsInsert, message, projectAssetInsertPosition, projectAssetScope],
    );

    const openProjectAssets = useCallback(
        (initialCategory = "all", position?: Position, scope: "canvas" | "timeline" = "canvas") => {
            setProjectAssetScope(scope);
            setProjectAssetInitialCategory(initialCategory);
            setProjectAssetInsertPosition(position);
            setProjectAssetOpen(true);
            // 资产与项目实时同步：打开弹窗前刷新关联短剧项目资产，避免缓存导致资产列表空白/过期。
            if (linkedProjectId) void refetchLinkedProject();
        },
        [linkedProjectId, refetchLinkedProject],
    );

    // 素材库打开入口：画布作用域（工具栏/空态/侧栏）与时间线作用域（时间线弹窗）分别标记插入目标。
    const openCanvasAssetLibrary = useCallback(
        (position?: Position) => {
            setAssetInsertScope("canvas");
            openAssetsAtPosition(position);
        },
        [openAssetsAtPosition],
    );
    const openTimelineAssetLibrary = useCallback(() => {
        setAssetInsertScope("timeline");
        openAssetsAtPosition();
    }, [openAssetsAtPosition]);
    const closeProjectAssets = useCallback(() => {
        setProjectAssetOpen(false);
        setProjectAssetInsertPosition(undefined);
    }, []);

    const {
        angleNodeId,
        emotionNodeId,
        annotationNodeId,
        createImageReversePromptNodes,
        generatePortraitTextureNode,
        cropImageNode,
        cropNodeId,
        closeSegmentDialog,
        extractAudioFromVideo,
        extractVideoLastFrame,
        extractingVideoFrameNodeId,
        generateAngleNode,
        generateEmotionNode,
        handleSegmentConfirm,
        maskEditImageNode,
        maskEditNodeId,
        mergeSelectedVideos,
        mergeVideosByIds,
        mergeVideoProgress,
        removeVideoSubtitles,
        saveAnnotatedImageNode,
        segmentDialogMode,
        segmentDialogNodeId,
        segmentRunningMode,
        setSegmentDialogNodeId,
        setAngleNodeId,
        setEmotionNodeId,
        setAnnotationNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setSplitNodeId,
        setUpscaleNodeId,
        splitImageNode,
        splitNodeId,
        trimVideoAndRegenerate,
        upscaleImageNode,
        upscaleNodeId,
    } = useCanvasMediaTools({
        projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setContextMenu,
        setHoveredNodeId,
        setToolbarNodeId,
        setRunningNodeId,
        startUploadStatus,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
        onGenerateVideoNode: (nodeId, mode, prompt) => generateNodeRef.current?.(nodeId, mode, prompt),
    });

    const handleNodesDeleted = useCallback(
        (removedIds: Set<string>, nextNodes: CanvasNodeData[], removedNodes: CanvasNodeData[]) => {
            const clearDeletedId = (current: string | null) => (current && removedIds.has(current) ? null : current);
            setHoveredNodeId(clearDeletedId);
            setToolbarNodeId(clearDeletedId);
            setDialogNodeId(clearDeletedId);
            setTextEditorNodeId(clearDeletedId);
            setCharacterReferenceNodeId(clearDeletedId);
            setDrawingNodeId(clearDeletedId);
            setInfoNodeId(clearDeletedId);
            setSubtitleNodeId(clearDeletedId);
            setSegmentDialogNodeId(clearDeletedId);
            setCropNodeId(clearDeletedId);
            setMaskEditNodeId(clearDeletedId);
            setAnnotationNodeId(clearDeletedId);
            setSplitNodeId(clearDeletedId);
            setUpscaleNodeId(clearDeletedId);
            setAngleNodeId(clearDeletedId);
            setEmotionNodeId(clearDeletedId);
            setSuperResolveNodeId(clearDeletedId);
            setPreviewNodeId(clearDeletedId);
            setRunningNodeId(clearDeletedId);
            setScriptEditorNodeId(clearDeletedId);
            setPrevisNodeId(clearDeletedId);
            setVersionCompareRootId(clearDeletedId);
            setScriptScrollTopById((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !removedIds.has(id))));
            setContextMenu((current) => (current?.type === "node" && removedIds.has(current.nodeId) ? null : current));
            const removedDrawingIds = removedNodes.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
            if (removedDrawingIds.length) {
                void Promise.all(removedDrawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("绘图节点已删除，但本地绘图缓存清理失败"));
            }
            cleanupCanvasFiles({ projectId, nodes: nextNodes, chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, message, projectId, setAngleNodeId, setAnnotationNodeId, setCropNodeId, setEmotionNodeId, setMaskEditNodeId, setSegmentDialogNodeId, setSplitNodeId, setUpscaleNodeId, setRunningNodeId],
    );

    const {
        alignSelectedNodes,
        arrangeAllNodes,
        arrangeSelectedNodes,
        copyNodesToClipboard,
        copySelectedNodes,
        createNode,
        createReferenceGroup,
        createStoryboardGroup,
        deleteConnection,
        disconnectReference,
        deleteNodes,
        duplicateNode,
        hasCopiedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        releaseCopiedNodesPastePriority,
        setPrimaryVersion,
        shouldPreferCopiedNodes,
        toggleNodeLocked,
    } = useCanvasNodeOperations({
        projectId,
        defaultDrawingEngine,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        onNodesDeleted: handleNodesDeleted,
    });

    const { cancelPendingConnectionCreate, closeConnectionCreateMenu, connectionTargetAnchorRatio, connectionTargetNodeId, connectingParams, createConnectedNode, handleConnectStart, mouseWorld, pendingConnectionCreate, setConnecting } =
        useCanvasConnectionController({
            projectId,
            defaultDrawingEngine,
            nodesRef,
            connectionsRef,
            viewportRef,
            scriptScrollTopById,
            screenToCanvas,
            setNodes,
            setConnections,
            setSelectedNodeIds,
            setSelectedConnectionId,
            setContextMenu,
            setDialogNodeId,
            setDrawingNodeId,
        });

    const handleCanvasSelectionStart = useCallback(() => {
        setContextMenu(null);
        setDialogNodeId(null);
    }, []);

    const handleNodeInteractionStart = useCallback((selectionModifier: boolean) => {
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        if (selectionModifier) setDialogNodeId(null);
    }, []);

    const handleSelectedNodeClick = useCallback((node: CanvasNodeData) => {
        if (node.type === CanvasNodeType.Drawing) {
            setDialogNodeId(null);
            setDrawingNodeId(node.id);
        } else if (node.type === CanvasNodeType.Script) {
            setDialogNodeId(null);
        } else if (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Frame) {
            setDialogNodeId((current) => (current === node.id ? current : null));
        } else {
            setDialogNodeId(node.id);
        }
    }, []);

    const handleCanvasDeselect = useCallback(() => {
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, []);

    const { alignmentGuides, cancelSelectionBox, deselectCanvas, dragPreview, frameDropTargetId, handleCanvasMouseDown, handleNodeMouseDown, isNodeDragging, nodeDraggingRef, selectionBoundsElementRef, selectionBox } = useCanvasSelectionController({
        containerRef,
        nodesRef,
        viewportRef,
        selectedNodeIdsRef,
        historyPausedRef,
        screenToCanvas,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        cancelPendingConnectionCreate,
        onCanvasSelectionStart: handleCanvasSelectionStart,
        onNodeInteractionStart: handleNodeInteractionStart,
        onNodeClick: handleSelectedNodeClick,
        onDeselect: handleCanvasDeselect,
        canvasTool,
    });

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const {
        collapsingBatchIds,
        downloadingNodeIds,
        downloadNodeImage,
        handleConfigNodeChange,
        handleFontSizeChange,
        handleNodeContentChange,
        handleNodePromptChange,
        handleNodeResize,
        handleNodeTitleChange,
        openingBatchIds,
        saveNodeAsset,
        setBatchPrimary,
        toggleBatchExpanded,
        toggleFrameCollapsed,
        toggleNodeFreeResize,
    } = useCanvasNodeEditor({
        canvasId: projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setToolbarNodeId,
        setHoveredNodeId,
    });

    const {
        activeNodeId,
        activeScriptNode,
        activeStylePresetId,
        angleNode,
        emotionNode,
        annotationNode,
        batchChildCountById,
        batchMotionById,
        canvasImageNodes,
        configInputsById,
        connectionLayerBounds,
        contextMenuNode,
        cropNode,
        displayConnections,
        frameChildrenById,
        imageAssets,
        infoNode,
        maskEditNode,
        mentionReferencesByNodeId,
        nodeById,
        previewNode,
        reduceMediaEffects,
        relatedHighlight,
        resourceReferenceByNodeId,
        selectedNodeBounds,
        selectedVideoNodes,
        skillMentionReferences,
        splitNode,
        superResolveNode,
        toolbarNode,
        upscaleNode,
        versionCompareNodes,
        visibleNodes,
    } = useCanvasRenderModel({
        nodes,
        connections,
        assets,
        viewport,
        nodeVisibilityViewport,
        viewportSize: size,
        mediaPerformanceMode,
        selectedNodeIds,
        hoveredNodeId,
        dragPreview,
        collapsingBatchIds,
        addedSkills,
        directorScenes: currentProject?.directorScenes,
        infoNodeId,
        cropNodeId,
        maskEditNodeId,
        annotationNodeId,
        splitNodeId,
        upscaleNodeId,
        superResolveNodeId,
        angleNodeId,
        emotionNodeId,
        previewNodeId,
        contextMenu,
        versionCompareRootId,
        directorNodeId: null,
        scriptEditorNodeId,
        dialogNodeId,
    });
    const scriptEditorReferences = useMemo(() => {
        const outputNodeIds = new Set((activeScriptNode?.metadata?.storyboard?.rows || []).flatMap((row) => [row.imageNodeId, row.videoNodeId].filter((id): id is string => Boolean(id))));
        return Array.from(resourceReferenceByNodeId.values()).filter((reference) => reference.nodeId !== activeScriptNode?.id && !outputNodeIds.has(reference.nodeId));
    }, [activeScriptNode, resourceReferenceByNodeId]);
    const dialogNode = dialogNodeId ? nodeById.get(dialogNodeId) || null : null;
    const subtitleNode = subtitleNodeId ? nodeById.get(subtitleNodeId) || null : null;
    const timelineNode = timelineNodeId ? nodeById.get(timelineNodeId) || null : null;
    const subtitleRemovalNode = subtitleRemovalNodeId ? nodeById.get(subtitleRemovalNodeId) || null : null;
    const segmentNode = segmentDialogNodeId ? nodeById.get(segmentDialogNodeId) || null : null;
    const textEditorNode = textEditorNodeId ? nodeById.get(textEditorNodeId) || null : null;
    const characterReferenceNode = characterReferenceNodeId ? nodeById.get(characterReferenceNodeId) || null : null;
    const drawingNode = drawingNodeId ? nodeById.get(drawingNodeId) || null : null;
    const pendingConnectionSourceNode = pendingConnectionCreate?.connection.handleType === "source" ? nodeById.get(pendingConnectionCreate.connection.nodeId) : null;
    const canCreateDrawingFromConnection = pendingConnectionSourceNode?.type === CanvasNodeType.Image && Boolean(pendingConnectionSourceNode.metadata?.content);

    const { createViralVideo, viralVideoOpenNodeId, viralVideoWorkspaceNodeId, openViralVideo, retryViralVideo, arrangeViralVideoAssets, replaceViralVideoAsset, uploadViralVideoAsset, updateViralVideoPlan } = useCanvasViralVideo({ projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds });
    const { create: createVideoAnalysis, configure: configureVideoAnalysis, start: startVideoAnalysis, replaceFile: replaceVideoAnalysisFile, resetUnsubmitted: resetVideoAnalysisSubmission } = useCanvasVideoAnalysis({ projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds });
    const openVideoAnalysisResult = useCallback((id: string) => {
        const result = nodesRef.current.find((node) => node.id === id);
        if (!result) return;
        setSelectedNodeIds(new Set([id]));
        setToolbarNodeId(null);
        setDialogNodeId(null);
        if (result.type === CanvasNodeType.Script) setScriptEditorNodeId(id);
        else setTextEditorNodeId(id);
    }, [nodesRef]);
    const viralVideoOpenNode = nodes.find((node) => node.id === viralVideoWorkspaceNodeId && node.metadata?.viralVideo);
    const screenplay = useCanvasScreenplay({ projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds });
    const openScreenplay = screenplay.open;

    const openConnectionViralVideo = useCallback(() => {
        const source = pendingConnectionSourceNode;
        cancelPendingConnectionCreate();
        if (source?.type !== CanvasNodeType.Video || (!source.metadata?.content && !source.metadata?.storageKey)) {
            setViralVideoImportOpen(true);
            return;
        }
        const existing = nodesRef.current.find((node) => node.metadata?.viralVideo?.sourceNodeId === source.id);
        if (existing) {
            openViralVideo(existing.id);
            return;
        }
        modal.confirm({
            title: "复刻当前视频",
            content: <div className="space-y-3"><p>使用「{source.title || "当前视频"}」反推整片提示词、分镜与替换资产。</p><p className="text-sm text-foreground/65">固定模型：{VIRAL_VIDEO_ANALYSIS_MODEL_LABEL} · 每次反推 {VIRAL_VIDEO_ANALYSIS_CREDITS} 积分</p><GenerationCostIndicator estimate={estimateViralVideoGeneration(config, "text", [])} /></div>,
            okText: "确认开始分析",
            cancelText: "取消",
            onOk: () => {
                const current = nodesRef.current.find((node) => node.id === source.id);
                if (!current || (!current.metadata?.content && !current.metadata?.storageKey)) {
                    message.error("参考视频已不可用，请重新选择");
                    return Promise.reject(new Error("参考视频已不可用"));
                }
                createViralVideo(current);
            },
        });
    }, [cancelPendingConnectionCreate, config, createViralVideo, message, modal, nodesRef, openViralVideo, pendingConnectionSourceNode]);

    const openTextNodeEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        if (node.metadata?.screenplay) { openScreenplay(node.id); return; }
        if (node.metadata?.videoAnalysis) {
            if (node.metadata.videoAnalysis.documentNodeId) openVideoAnalysisResult(node.metadata.videoAnalysis.documentNodeId);
            return;
        }
        if (node.metadata?.viralVideo) {
            openViralVideo(node.id);
            return;
        }
        if (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId) {
            setCharacterReferenceNodeId(node.id);
            return;
        }
        setTextEditorNodeId(node.id);
    }, [openViralVideo, openScreenplay, openVideoAnalysisResult]);

    const openDrawingNode = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Drawing) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setDrawingNodeId(node.id);
    }, []);
    const { agentSnapshot, agentUndoCount, applyAgentOps, canUndoAgentOps, dismissLastAgentChange, lastAgentChange, undoAgentOps, viewLastAgentChange } = useCanvasAgentOperations({
        projectId,
        domainProjectId: currentProject?.projectId,
        projectTitle: currentProject?.title || "未命名画布",
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
        focusSelection: fitCanvasSelection,
    });

    const { selectCanvasStyle, styleApplying } = useCanvasStyleWorkflow({
        domainProjectId: currentProject?.projectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setStylePickerOpen,
    });

    const { applyPrevisOutput, createPrevisShot, openPrevisWorkbench, savePrevisScene } = useCanvasPrevis({
        projectId,
        domainProjectId: currentProject?.projectId,
        previsNodeId,
        previsScenes: currentProject?.previsScenes || [],
        nodesRef,
        connectionsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setPrevisNodeId,
        updateProject,
    });
    const activePrevisNode = nodes.find((node) => node.id === previsNodeId);
    const activePrevisScene = currentProject?.previsScenes?.find((scene) => scene.id === activePrevisNode?.metadata?.previsSceneId) || null;
    const legacyPrevisScenes = useMemo(
        () => new Map((currentProject?.directorScenes || []).map((scene) => [scene.id, directorSceneToPrevisScene(scene)] as const)),
        [currentProject?.directorScenes],
    );
    const openCanvasPrevis = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node) return;
        const legacyScene = node.metadata?.directorSceneId
            ? currentProject?.directorScenes?.find((scene) => scene.id === node.metadata?.directorSceneId)
            : undefined;
        if (!node.metadata?.previsSceneId && legacyScene) {
            const migratedScene = directorSceneToPrevisScene(legacyScene);
            const currentScenes = currentProject?.previsScenes || [];
            const nextScenes = currentScenes.some((scene) => scene.id === migratedScene.id)
                ? currentScenes.map((scene) => scene.id === migratedScene.id ? migratedScene : scene)
                : [...currentScenes, migratedScene];
            const nextNodes = nodesRef.current.map((item) => item.id === nodeId
                ? {
                      ...item,
                      metadata: {
                          ...item.metadata,
                          previsSceneId: migratedScene.id,
                          previsShotId: item.metadata?.directorShotId,
                          previsPreviewNodeId: item.metadata?.previsPreviewNodeId || item.metadata?.directorPreviewNodeId,
                          previsDepthNodeId: item.metadata?.previsDepthNodeId || item.metadata?.directorDepthNodeId,
                          previsNormalNodeId: item.metadata?.previsNormalNodeId || item.metadata?.directorNormalNodeId,
                          previsClayVideoNodeId: item.metadata?.previsClayVideoNodeId || item.metadata?.directorClayVideoNodeId,
                      },
                  }
                : item);
            nodesRef.current = nextNodes;
            setNodes(nextNodes);
            updateProject(projectId, { nodes: nextNodes, previsScenes: nextScenes });
        }
        openPrevisWorkbench(nodeId);
    }, [currentProject?.directorScenes, currentProject?.previsScenes, nodesRef, openPrevisWorkbench, projectId, setNodes, updateProject]);
    const requestPrevisShot = useCallback((position?: Position) => setPrevisTemplateRequest({ position }), []);

    const {
        activateStep: activateShortDramaStep,
        createPipeline: createShortDramaPipeline,
        guideCollapsed: shortDramaGuideCollapsed,
        openStoryInput,
        progress: shortDramaProgress,
        setGuideCollapsed: setShortDramaGuideCollapsed,
        skipGuide: skipShortDramaGuide,
    } = useCanvasShortDrama({
        nodes,
        connections,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setStylePickerOpen,
        fitCanvasSelection,
        focusCanvasNode,
        openTextEditor: openTextNodeEditor,
    });

    const shortDramaGuide = shortDramaEnabled && !currentProject?.projectId && shortDramaProgress.active ? { progress: shortDramaProgress, collapsed: shortDramaGuideCollapsed, onToggle: () => setShortDramaGuideCollapsed((value) => !value) } : undefined;

    const clearCanvas = useCallback(() => {
        const drawingIds = nodesRef.current.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("画布已清空，但部分本地绘图缓存清理失败"));
        }
        setNodes([]);
        setConnections([]);
        setTextEditorNodeId(null);
        setDrawingNodeId(null);
        setInfoNodeId(null);
        setSubtitleNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAnnotationNodeId(null);
        setAngleNodeId(null);
        setEmotionNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        clearCanvasFiles();
    }, [clearCanvasFiles, deselectCanvas, message, nodesRef, projectId, setEmotionNodeId]);

    const arrangeCanvas = useCallback(() => {
        if (arrangeAllNodes()) window.requestAnimationFrame(() => fitCanvasContent());
    }, [arrangeAllNodes, fitCanvasContent]);

    const openCanvasShortcuts = useCallback(() => {
        setShortcutRequestNonce((value) => value + 1);
    }, []);

    useCanvasKeyboard({
        nodesRef,
        selectedNodeIdsRef,
        selectedConnectionId,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setShortcutRequestNonce,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setAnnotationNodeId,
        saveCanvasProject,
        zoomToActualSize,
        fitCanvasContent,
        fitCanvasSelection,
        undoCanvas,
        redoCanvas,
        cancelSelectionBox,
        copySelectedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        shouldPreferCopiedNodes,
        pasteSystemClipboard,
        deleteNodes,
        deleteConnection,
        cancelPendingConnectionCreate,
        deselectCanvas,
        zoomCanvasIn,
        zoomCanvasOut,
        focusMode,
        exitFocusMode,
        toggleFocusMode,
        setCanvasTool,
        arrangeCanvas,
    });

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null, options?: { flush?: boolean }) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
        updateProject(projectId, { chatSessions: sessions, activeChatId: activeId });
        if (options?.flush) return flushCanvasStorePersistence();
    }, [projectId, updateProject]);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameCurrentProject(nextTitle);
        setTitleEditing(false);
    }, [renameCurrentProject, titleDraft]);

    const pasteAtPosition = useCallback(
        (position: Position) => {
            if (shouldPreferCopiedNodes() && pasteCopiedNodes(position)) return;
            void (async () => {
                try {
                    // 标记写入成功时仍优先系统图片，兼容截图和从外部应用复制的媒体。
                    const handled = await pasteSystemClipboard(position);
                    if (!handled) pasteCopiedNodes(position);
                } catch {
                    if (!pasteCopiedNodes(position)) message.warning("无法读取剪贴板内容");
                }
            })();
        },
        [message, pasteCopiedNodes, pasteSystemClipboard, shouldPreferCopiedNodes],
    );

    const copyNodeContentToClipboard = useCallback(
        async (node: CanvasNodeData | null) => {
            releaseCopiedNodesPastePriority();
            const content = node?.metadata?.content;
            if (!node || !content) {
                message.warning("没有可复制的内容");
                return;
            }

            try {
                if (node.type === CanvasNodeType.Image && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
                    const response = await fetch(content);
                    const blob = await response.blob();
                    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
                    message.success("图片已复制");
                    return;
                }

                if (!navigator.clipboard?.writeText) {
                    message.warning("当前浏览器不支持写入剪贴板");
                    return;
                }
                await navigator.clipboard.writeText(content);
                message.success(node.type === CanvasNodeType.Text ? "文本已复制" : "内容链接已复制");
            } catch {
                message.error("复制失败，请检查浏览器剪贴板权限");
            }
        },
        [message, releaseCopiedNodesPastePriority],
    );

    const copyNodeMediaUrlToClipboard = useCallback(
        async (node: CanvasNodeData | null) => {
            releaseCopiedNodesPastePriority();
            try {
                const storageKey = node?.metadata?.storageKey;
                const content = node?.metadata?.content?.trim();
                const resourceId = resourceIdFromStorageKey(storageKey);
                const mediaPath = content && !content.startsWith("data:") && !content.startsWith("blob:") ? content : resourceId ? resourceFileUrl(resourceId) : "";
                const mediaURL = mediaPath ? new URL(mediaPath, window.location.href).toString() : "";
                if (!mediaURL) throw new Error("当前媒体只有本地内容，没有可复制的地址");
                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(mediaURL);
                else if (!(await copyToClipboard(mediaURL))) throw new Error("当前浏览器不支持写入剪贴板");
                message.success(node?.type === CanvasNodeType.Video ? "视频地址已复制" : "图片地址已复制");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "媒体地址复制失败");
            }
        },
        [message, releaseCopiedNodesPastePriority],
    );

    const handleCanvasContextMenu = useCallback(
        (event: ReactMouseEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-node-id],[data-connection-id]")) return;

            event.preventDefault();
            event.stopPropagation();
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown")) {
                setContextMenu(null);
                return;
            }

            closeConnectionCreateMenu();
            setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, position: screenToCanvas(event.clientX, event.clientY) });
        },
        [closeConnectionCreateMenu, screenToCanvas],
    );

    const handleNodeContextMenu = useCallback(
        (event: ReactMouseEvent, id: string) => {
            event.preventDefault();
            event.stopPropagation();
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            closeConnectionCreateMenu();
            setToolbarNodeId(null);
            setDialogNodeId(null);
            setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
        },
        [closeConnectionCreateMenu],
    );

    const handleGenerateNode = useCanvasGenerationExecutor({
        projectId,
        domainProjectId: currentProject?.projectId,
        addedSkills,
        nodesRef,
        connectionsRef,
        setNodes: setAgentNodes,
        setConnections: setAgentConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
    });
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const { cancelSubmittedBatchItem, enqueueGenerationBatch, retryFailedBatchItems, stopRemainingBatchItems } = useCanvasGenerationBatches({
        projectId,
        projectLoaded,
        nodes,
        nodesRef,
        setNodes,
        handleGenerateNode,
    });

    const { addScriptRow, assignScriptResources, autoLinkScriptResources, createAndGenerateScriptVideos, createScriptActionBoards, createScriptImageNodes, createScriptVideoNodes, generateScriptImages, generateScriptRows, generateScriptVideos, removeScriptRow, replaceScriptRows, updateScriptRow } =
        useCanvasStoryboard({
            projectId,
            nodesRef,
            connectionsRef,
            setNodes,
            setConnections,
            setSelectedNodeIds,
            enqueueGenerationBatch,
        });

    const handleViralVideoAgentAction = useCallback(async (request: ViralVideoAgentRequest) => {
        const target = nodesRef.current.find((node) => node.id === request.nodeId);
        if (!target) throw new Error("目标节点不存在，请先读取画布选区");
        if (request.action === "analyze") {
            if (target.type !== CanvasNodeType.Video) throw new Error("请选择已导入的视频节点");
            const id = createViralVideo(target);
            return { analysisNodeId: id, status: "已打开复刻流程；分析状态以分析节点为准" };
        }
        const owner = target.metadata?.viralVideo ? target : target.metadata?.viralVideoAnalysisNodeId ? nodesRef.current.find((node) => node.id === target.metadata!.viralVideoAnalysisNodeId) : nodesRef.current.find((node) => node.metadata?.viralVideo?.sourceNodeId === target.id);
        const workflow = owner?.metadata?.viralVideo;
        if (!owner || !workflow) throw new Error("该节点尚未建立复刻流程，请先分析源视频");
        const script = nodesRef.current.find((node) => node.id === workflow.storyboardNodeId);
        const rows = script?.metadata?.storyboard?.rows || [];
        if (request.action === "read") { const selected = request.rowIds?.length ? rows.filter((row) => request.rowIds!.includes(row.id)) : rows; return { analysisNodeId: owner.id, ...workflow, rows: selected.slice(0, 24), rowCount: rows.length, sampled: selected.length > 24 }; }
        if (request.action === "open") { openViralVideo(owner.id); return { opened: true, analysisNodeId: owner.id }; }
        if (request.action === "replace_asset") {
            if (!request.assetId) throw new Error("缺少资产标识，请先读取复刻方案");
            replaceViralVideoAsset(owner.id, request.assetId, request.replacementNodeId);
            return { updated: true, analysisNodeId: owner.id };
        }
        if (workflow.stage !== "ready" || !script || !rows.length) throw new Error("请先完成分析并保留分镜表节点");
        const ids = request.rowIds?.length ? request.rowIds : rows.map((row) => row.id);
        if (ids.some((id) => !rows.some((row) => row.id === id))) throw new Error("存在无效的分镜标识，请重新读取方案");
        const selectedRows = rows.filter((row) => ids.includes(row.id));
        if (request.action === "preview") await generateScriptImages(script.id, ids);
        else if (request.action === "generate") {
            if (selectedRows.some((row) => !nodesRef.current.find((node) => node.id === row.imageNodeId)?.metadata?.content)) throw new Error("请先生成并确认所选镜头的分镜预览");
            await generateScriptVideos(script.id, ids);
        } else if (request.action === "compose") {
            const videoIds = rows.map((row) => row.videoNodeId).filter((id): id is string => Boolean(id && nodesRef.current.find((node) => node.id === id)?.metadata?.content));
            if (videoIds.length !== rows.length) throw new Error("全部镜头视频完成后才能合成");
            await mergeVideosByIds(videoIds);
        } else throw new Error("不支持的复刻动作");
        return { analysisNodeId: owner.id, status: "操作已处理，请读取节点和任务状态确认实际提交结果" };
    }, [createViralVideo, generateScriptImages, generateScriptVideos, mergeVideosByIds, nodesRef, openViralVideo, replaceViralVideoAsset]);

    const handleRetryNode = useCanvasGenerationRetry({
        projectId,
        domainProjectId: currentProject?.projectId,
        addedSkills,
        nodesRef,
        connectionsRef,
        setNodes,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
    });

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Image);
            const imageNode = createCanvasNode(
                CanvasNodeType.Image,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: `@[node:${sourceNode.id}]`,
                    composerContent: `@[node:${sourceNode.id}]`,
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    quality: effectiveConfig.quality,
                    transparentBackground: effectiveConfig.transparentBackground,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            imageNode.title = "图片生成";
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: imageNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, richText: undefined, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(imageNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([imageNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(imageNode.id);
        },
        [effectiveConfig, message],
    );

    const renderCanvasNodePanel = useCallback(
        (panelNode: CanvasNodeData) => {
            if (panelNode.metadata?.screenplay || panelNode.metadata?.videoAnalysis) return null;
            if (panelNode.type === CanvasNodeType.Script || panelNode.type === CanvasNodeType.Drawing) return null;
            return panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    skillReferences={skillMentionReferences}
                    generationMode={panelNode.metadata?.generationMode}
                    metadata={panelNode.metadata}
                    workspaceMode={workspaceMode}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onRemoveReference={(nodeId) => disconnectReference(panelNode.id, nodeId)}
                    onMetadataChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    isRunning={runningNodeId === panelNode.id}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_RESOURCE_REFERENCES}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={(reference) => disconnectReference(panelNode.id, reference.nodeId)}
                    workspaceMode={workspaceMode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            );
        },
        [configInputsById, confirmStopGeneration, disconnectReference, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, mentionReferencesByNodeId, runningNodeId, skillMentionReferences, workspaceMode],
    );

    const renderCanvasNodeContent = useCallback(
        (contentNode: CanvasNodeData) => {
            if (contentNode.metadata?.videoAnalysis) return <CanvasVideoAnalysisNode
                node={contentNode}
                nodes={nodes}
                onConfigure={(changes) => configureVideoAnalysis(contentNode.id, changes)}
                onReplaceFile={(file) => replaceVideoAnalysisFile(contentNode.id, file)}
                onStart={() => startVideoAnalysis(contentNode.id)}
                onResetUnsubmitted={() => resetVideoAnalysisSubmission(contentNode.id)}
                onOpenResult={openVideoAnalysisResult}
            />;
            if (contentNode.metadata?.screenplay) return <CanvasScreenplayNode node={contentNode} onOpen={() => openScreenplay(contentNode.id)} />;
            if (contentNode.metadata?.viralVideo) {
                return <CanvasViralVideoAnalysisNode node={contentNode} onOpen={() => openViralVideo(contentNode.id)} />;
            }
            if (contentNode.metadata?.workflowKind === "character" && contentNode.metadata.characterAssetId) {
                return <CanvasCharacterReferenceNodeContent node={contentNode} />;
            }
            if (contentNode.metadata?.workflowKind === "styleboard" && !contentNode.metadata.content) {
                return <CanvasStylePlaceholderNodeContent onChoose={() => setStylePickerOpen(true)} />;
            }
            if (contentNode.metadata?.workflowKind === "story_input") {
                return <CanvasStoryInputNodeContent node={contentNode} onEdit={() => openStoryInput(contentNode.id)} />;
            }
            if (contentNode.type === CanvasNodeType.Script) {
                const pipeline = deriveStoryboardPipelineProgress(contentNode, nodesRef.current, connectionsRef.current);
                return (
                    <CanvasScriptNodeContent
                        node={contentNode}
                        batch={visibleGenerationBatch(contentNode)}
                        pipeline={pipeline}
                        scale={viewport.k}
                        mentionReferences={mentionReferencesByNodeId.get(contentNode.id) || EMPTY_RESOURCE_REFERENCES}
                        onOpen={() => setScriptEditorNodeId(contentNode.id)}
                        onCreateImageNodes={() => createScriptImageNodes(contentNode.id)}
                        onCreateVideoNodes={() => createScriptVideoNodes(contentNode.id)}
                        onGenerateImages={(rowIds) => void generateScriptImages(contentNode.id, rowIds)}
                        onGenerateVideos={(rowIds) => (contentNode.metadata?.storyboardVideoInputMode === "keyframe" ? void generateScriptVideos(contentNode.id, rowIds) : void createAndGenerateScriptVideos(contentNode.id, rowIds))}
                        onAutoLinkReferences={(rowIds) => autoLinkScriptResources(contentNode.id, rowIds)}
                        onVideoInputModeChange={(storyboardVideoInputMode) => handleConfigNodeChange(contentNode.id, { storyboardVideoInputMode })}
                        onMergeVideos={() => void mergeVideosByIds(pipeline.successfulVideoNodeIds)}
                        onCreateActionBoards={() => void createScriptActionBoards(contentNode.id)}
                        onRetryBatch={(batchId) => retryFailedBatchItems(contentNode.id, batchId)}
                        onRetryBatchItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                        onStopBatch={(batchId) => stopRemainingBatchItems(contentNode.id, batchId)}
                        onCancelBatchItem={(batchId, itemId) => cancelSubmittedBatchItem(contentNode.id, batchId, itemId)}
                        onAddRow={() => addScriptRow(contentNode.id)}
                        onRemoveRow={(rowId) => removeScriptRow(contentNode.id, rowId)}
                        onUpdateRow={(rowId, patch) => updateScriptRow(contentNode.id, rowId, patch)}
                        onPromptChange={(composerContent) => handleConfigNodeChange(contentNode.id, { composerContent })}
                        onGenerateScript={(prompt) => void generateScriptRows(contentNode.id, prompt)}
                        onModelChange={(model) => handleConfigNodeChange(contentNode.id, { model })}
                        onShotDurationChange={(duration: StoryboardShotDuration) => handleConfigNodeChange(contentNode.id, { storyboardShotDuration: duration })}
                        onShotCountChange={(count: StoryboardShotCount) => handleConfigNodeChange(contentNode.id, { storyboardShotCount: count })}
                        workspaceMode={workspaceMode}
                        onComposerHeightChange={(height) => {
                            if (contentNode.metadata?.storyboardComposerHeight === height) return;
                            handleConfigNodeChange(contentNode.id, { storyboardComposerHeight: height });
                            const minHeight = storyboardMinNodeHeight(height);
                            if (contentNode.height < minHeight) handleNodeResize(contentNode.id, contentNode.width, minHeight);
                        }}
                        onConnectStart={(event, rowId, handleType) => handleConnectStart(event, contentNode.id, handleType, rowId === "context" ? "storyboard:context" : `row:${rowId}`)}
                        onScrollTopChange={(scrollTop) => setScriptScrollTopById((current) => (current[contentNode.id] === scrollTop ? current : { ...current, [contentNode.id]: scrollTop }))}
                    />
                );
            }
            if (contentNode.metadata?.previsSceneId || contentNode.metadata?.directorSceneId) {
                const sceneId = contentNode.metadata?.previsSceneId || contentNode.metadata?.directorSceneId;
                return (
                    <CanvasPrevisNodePanel
                        node={contentNode}
                        scene={currentProject?.previsScenes?.find((scene) => scene.id === sceneId) || legacyPrevisScenes.get(sceneId || "") || null}
                        readNodeContent={(nodeId) => {
                            const previewNode = nodeId ? nodesRef.current.find((item) => item.id === nodeId) : undefined;
                            return previewNode ? { content: previewNode.metadata?.content, storageKey: previewNode.metadata?.storageKey } : undefined;
                        }}
                        professional={workspaceMode === "professional"}
                        onOpen={() => openCanvasPrevis(contentNode.id)}
                    />
                );
            }
            return (
                <CanvasConfigNodePanel
                    node={contentNode}
                    isRunning={runningNodeId === contentNode.id}
                    inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                    onConfigChange={handleConfigNodeChange}
                    onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                    onStop={confirmStopGeneration}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    }}
                    workspaceMode={workspaceMode}
                />
            );
        },
        [
            addScriptRow,
            autoLinkScriptResources,
            cancelSubmittedBatchItem,
            configInputsById,
            confirmStopGeneration,
            createAndGenerateScriptVideos,
            createScriptActionBoards,
            createScriptImageNodes,
            createScriptVideoNodes,
            currentProject?.previsScenes,
            configureVideoAnalysis,
            replaceVideoAnalysisFile,
            startVideoAnalysis,
            resetVideoAnalysisSubmission,
            openVideoAnalysisResult,
            nodes,
            generateScriptImages,
            generateScriptRows,
            generateScriptVideos,
            handleConfigNodeChange,
            handleConnectStart,
            handleGenerateNode,
            handleNodeResize,
            mentionReferencesByNodeId,
            mergeVideosByIds,
            openCanvasPrevis,
            openStoryInput,
            openViralVideo,
            openScreenplay,
            removeScriptRow,
            retryFailedBatchItems,
            runningNodeId,
            stopRemainingBatchItems,
            updateScriptRow,
            viewport.k,
            workspaceMode,
        ],
    );

    const handleCanvasNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current) return;
            setHoveredNodeId(nodeId);
            keepNodeToolbar(nodeId);
        },
        [keepNodeToolbar],
    );
    const handleCanvasNodeHoverEnd = useCallback(
        (nodeId: string) => {
            setHoveredNodeId((current) => (current === nodeId ? null : current));
            hideNodeToolbar();
        },
        [hideNodeToolbar],
    );
    const retryCanvasNode = useCallback(
        (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Script) {
                const prompt = (node.metadata?.composerContent || node.metadata?.prompt || "").trim();
                if (!prompt) {
                    message.warning("分镜脚本缺少剧情内容，无法重试");
                    return;
                }
                void generateScriptRows(node.id, prompt);
                return;
            }
            void handleRetryNode(node);
        },
        [generateScriptRows, handleRetryNode, message],
    );
    const openCanvasNodeTaskDetails = useCallback(
        (node: CanvasNodeData) => {
            void openNodeTaskDetails(node);
        },
        [openNodeTaskDetails],
    );
    const openCanvasNodeVersions = useCallback((node: CanvasNodeData) => setVersionCompareRootId(node.metadata?.versionOfNodeId || node.id), []);
    const viewCanvasNodeImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    const markOriginalMediaNode = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) || !node.metadata?.content) return;
        setOriginalMediaNodeIds((current) => current.size === 1 && current.has(node.id) ? current : new Set([node.id]));
    }, [nodesRef]);
    const focusCanvasMediaNode = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) return;
        markOriginalMediaNode(node.id);
        focusCanvasMediaNodeInView(node.id);
    }, [focusCanvasMediaNodeInView, markOriginalMediaNode]);
    const editCanvasPrevis = useCallback((node: CanvasNodeData) => openCanvasPrevis(node.id), [openCanvasPrevis]);
    const locateProjectStyleNode = useCallback(() => {
        const styleNode = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        if (!styleNode) {
            message.info("项目画风节点正在同步，请稍后再试");
            return;
        }
        focusCanvasNode(styleNode.id);
    }, [focusCanvasNode, message, nodesRef]);
    const isUnlinkedEmptyCanvas = nodes.length === 0 && !(shortDramaEnabled && currentProject?.projectId);
    const createAudioGenerationNode = useCallback(() => {
        createNode(CanvasNodeType.Audio);
        const [nodeId] = selectedNodeIdsRef.current;
        if (nodeId) setDialogNodeId(nodeId);
    }, [createNode, selectedNodeIdsRef, setDialogNodeId]);
    const handleEmptyCanvasDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (isUnlinkedEmptyCanvas) {
            createNode(CanvasNodeType.Text, screenToCanvas(event.clientX, event.clientY));
            const [nodeId] = selectedNodeIdsRef.current;
            if (nodeId) setDialogNodeId(nodeId);
            return;
        }
        handleCanvasDoubleClick(event);
    }, [createNode, handleCanvasDoubleClick, isUnlinkedEmptyCanvas, screenToCanvas, selectedNodeIdsRef, setDialogNodeId]);
    const emptyCanvasState = nodes.length ? null : shortDramaEnabled && currentProject?.projectId ? (
        <CanvasLinkedProjectEmptyState
            projectName={linkedProjectQuery.data?.project.name || currentProject.title}
            hasChapter={Boolean(linkedProjectQuery.data?.units.length)}
            onAddFirstChapter={() => {
                const first = linkedProjectQuery.data?.units.slice().sort((left, right) => left.position - right.position)[0];
                if (first) void handleProjectChapterInsert({ id: first.id, projectId: currentProject.projectId!, title: first.title, position: first.position });
            }}
            onOpenAssets={() => openProjectAssets()}
            onAddText={() => createNode(CanvasNodeType.Text)}
        />
    ) : (
        <CanvasStartEmptyState
            onAddImage={() => createNode(CanvasNodeType.Image, undefined, { generationMode: "image", generationType: "generation" })}
            onAddVideo={() => createNode(CanvasNodeType.Video, undefined, { generationMode: "video", videoEditOperation: "text_to_video" })}
            onAddAudio={createAudioGenerationNode}
            onAddScript={() => createNode(CanvasNodeType.Script)}
            onSmartEdit={createShortDramaPipeline}
        />
    );
    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <>
            <a
                href="#canvas-main"
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-toast)] focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
            >
                跳转到画布主内容
            </a>
            <main id="canvas-main" tabIndex={-1} className="flex h-full min-h-0 overflow-hidden outline-none" style={{ background: theme.canvas.background, color: theme.node.text }}>
                {!focusMode && shortDramaEnabled && currentProject?.projectId ? (
                    <CanvasProjectSidebar projectId={currentProject.projectId} detail={linkedProjectQuery.data} onAddChapter={handleProjectChapterInsert} onLocateStyle={locateProjectStyleNode} onOpenAssets={() => openProjectAssets()} />
                ) : null}
                <section className="relative min-w-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                    <CanvasTopBar
                        hidden={focusMode}
                        title={currentProject?.title || "未命名画布"}
                        teamId={currentProject?.teamId}
                        workspaceMode={workspaceMode}
                        onWorkspaceModeChange={setWorkspaceMode}
                        titleDraft={titleDraft}
                        isTitleEditing={titleEditing}
                        onTitleDraftChange={setTitleDraft}
                        onStartTitleEditing={startTitleEditing}
                        onFinishTitleEditing={finishTitleEditing}
                        onCancelTitleEditing={() => setTitleEditing(false)}
                        canUndo={historyState.canUndo}
                        canRedo={historyState.canRedo}
                        onCreateProject={createAndOpenProject}
                        onDeleteProject={deleteCurrentProject}
                        onImportImage={() => handleUploadRequest()}
                        onUndo={undoCanvas}
                        onRedo={redoCanvas}
                        onShare={() => currentProject?.teamId ? message.info("团队作品通过团队邀请和项目成员权限共享，请在团队空间管理") : setShareModalOpen(true)}
                        agentOpen={assistantOpen}
                        compactAgentStatus={codexCompactAgent ? { connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity } : undefined}
                        onToggleAgent={() => (assistantOpen ? closeAgent() : openAgent())}
                        shortcutRequestNonce={shortcutRequestNonce}
                        mediaPerformanceMode={mediaPerformanceMode}
                        onMediaPerformanceModeChange={setMediaPerformanceMode}
                        onOpenSearch={() => setNodeSearchOpen(true)}
                        projectContext={
                            shortDramaEnabled && currentProject?.projectId
                                ? {
                                      ...canvasContext,
                                      projectId: currentProject.projectId,
                                      projectName: linkedProjectQuery.data?.project.name || currentProject.title,
                                  }
                                : undefined
                        }
                        onEnterFocusMode={enterFocusMode}
                        shortDramaGuide={shortDramaGuide}
                    />

                    <CanvasNodeSearchModal
                        open={nodeSearchOpen}
                        nodes={nodes}
                        onClose={() => setNodeSearchOpen(false)}
                        onFocus={(nodeId) => {
                            const target = nodeById.get(nodeId);
                            const parent = target?.parentId ? nodeById.get(target.parentId) : null;
                            if (parent?.metadata?.frame?.collapsed) toggleFrameCollapsed(parent.id);
                            const batchRoot = target?.metadata?.batchRootId ? nodeById.get(target.metadata.batchRootId) : null;
                            if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);
                            const selection = new Set([nodeId]);
                            selectedNodeIdsRef.current = selection;
                            setSelectedNodeIds(selection);
                            setSelectedConnectionId(null);
                            focusCanvasNode(nodeId);
                        }}
                    />

                    {!focusMode && shortDramaGuide ? (
                        <CanvasShortDramaGuide progress={shortDramaGuide.progress} collapsed={shortDramaGuide.collapsed} onToggle={shortDramaGuide.onToggle} onSkip={skipShortDramaGuide} onStepClick={activateShortDramaStep} />
                    ) : null}

                    <CanvasShareModal projectId={projectId} open={shareModalOpen} onClose={() => setShareModalOpen(false)} beforeCreate={saveCanvasProject} />

                    <CanvasStylePickerModal open={stylePickerOpen} value={activeStylePresetId} applying={styleApplying} onClose={() => setStylePickerOpen(false)} onSelect={selectCanvasStyle} />

                    <div className="relative flex min-h-0 min-w-0 flex-1">
                        <div className="relative min-w-0 flex-1 overflow-hidden">
                            <InfiniteCanvas
                                containerRef={containerRef}
                                viewport={viewport}
                                backgroundMode={isUnlinkedEmptyCanvas ? "dots" : "blank"}
                                graphicsLayer={
                                    <CanvasLeaferGraphicsLayer
                                        containerRef={containerRef}
                                        viewport={viewport}
                                        theme={theme}
                                        displayConnections={displayConnections}
                                        selectedConnectionId={selectedConnectionId}
                                        relatedConnectionIds={relatedHighlight.connectionIds}
                                        scriptScrollTopById={scriptScrollTopById}
                                        connectingParams={connectingParams}
                                        mouseWorld={mouseWorld}
                                        connectionTargetNodeId={connectionTargetNodeId}
                                        connectionTargetAnchorRatio={connectionTargetAnchorRatio}
                                        nodeById={nodeById}
                                        selectionBox={selectionBox}
                                        selectedNodeBounds={selectedNodeBounds}
                                        alignmentGuides={alignmentGuides}
                                    />
                                }
                                onViewportChange={handleViewportChange}
                                onViewportPreviewChange={handleViewportPreviewChange}
                                onZoomTargetNode={markOriginalMediaNode}
                                onCanvasMouseDown={handleCanvasMouseDown}
                                boxSelectEnabled={canvasTool === "box-select"}
                                panOverNodes={canvasTool === "move"}
                                onCanvasDoubleClick={handleEmptyCanvasDoubleClick}
                                onCanvasDeselect={deselectCanvas}
                                onContextMenu={handleCanvasContextMenu}
                                onDrop={handleDrop}
                                onFileDragEnter={handleFileDragEnter}
                                onFileDragLeave={handleFileDragLeave}
                                onFileDragOver={handleFileDragOver}
                            >
                                <CanvasProjectWorldLayers
                                    projectId={projectId}
                                    viewportScale={viewport.k}
                                    connectionLayerBounds={connectionLayerBounds}
                                    displayConnections={displayConnections}
                                    selectedConnectionId={selectedConnectionId}
                                    relatedConnectionIds={relatedHighlight.connectionIds}
                                    scriptScrollTopById={scriptScrollTopById}
                                    connectingParams={connectingParams}
                                    mouseWorld={mouseWorld}
                                    connectionTargetNodeId={connectionTargetNodeId}
                                    nodeById={nodeById}
                                    visibleNodes={visibleNodes}
                                    frameChildrenById={frameChildrenById}
                                    dragPreview={dragPreview}
                                    selectedNodeIds={selectedNodeIds}
                                    frameDropTargetId={frameDropTargetId}
                                    relatedNodeIds={relatedHighlight.nodeIds}
                                    activeNodeId={activeNodeId}
                                    hoveredNodeId={hoveredNodeId}
                                    selectionBox={selectionBox}
                                    batchChildCountById={batchChildCountById}
                                    collapsingBatchIds={collapsingBatchIds}
                                    openingBatchIds={openingBatchIds}
                                    batchMotionById={batchMotionById}
                                    showImageInfo={showImageInfo}
                                    reduceMediaEffects={reduceMediaEffects}
                                    originalMediaNodeIds={originalMediaNodeIds}
                                    resourceReferenceByNodeId={resourceReferenceByNodeId}
                                    mentionReferencesByNodeId={mentionReferencesByNodeId}
                                    mediaEffectsDisabledNodeId={emotionNodeId}
                                    selectedNodeBounds={selectedNodeBounds}
                                    isNodeDragging={isNodeDragging}
                                    selectionBoundsElementRef={selectionBoundsElementRef}
                                    renderCanvasNodeContent={renderCanvasNodeContent}
                                    onConnectionSelect={(connectionId) => {
                                        setSelectedConnectionId(connectionId);
                                        setSelectedNodeIds(new Set());
                                        setContextMenu(null);
                                    }}
                                    onConnectionDelete={deleteConnection}
                                    onConnectionContextMenu={(event, connectionId) => {
                                        setSelectedConnectionId(connectionId);
                                        setSelectedNodeIds(new Set());
                                        closeConnectionCreateMenu();
                                        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
                                    }}
                                    onNodeMouseDown={handleNodeMouseDown}
                                    onNodeHoverStart={handleCanvasNodeHoverStart}
                                    onNodeHoverEnd={handleCanvasNodeHoverEnd}
                                    onConnectStart={handleConnectStart}
                                    onNodeResize={handleNodeResize}
                                    onToggleFrame={toggleFrameCollapsed}
                                    onNodeTitleChange={(id, title) => {
                                        const workflow = nodesRef.current.find((node) => node.id === id)?.metadata?.screenplay;
                                        if (!workflow) { handleNodeTitleChange(id, title); return; }
                                        try { screenplay.save(id, { ...workflow.document, title }, workflow.document.revision, "修改剧本名称"); }
                                        catch (error) { message.error(error instanceof Error ? error.message : "剧本名称保存失败"); }
                                    }}
                                    onNodeContextMenu={handleNodeContextMenu}
                                    onNodeContentChange={handleNodeContentChange}
                                    onToggleBatch={toggleBatchExpanded}
                                    onSetBatchPrimary={setBatchPrimary}
                                    onRetry={retryCanvasNode}
                                    onCancelTask={cancelNodeTask}
                                    onOpenTaskDetails={openCanvasNodeTaskDetails}
                                    onOpenVersions={openCanvasNodeVersions}
                                    onFocusMedia={focusCanvasMediaNode}
                                    onReplaceMedia={(node) => handleUploadRequest(node.id)}
                                    onOpenTextEditor={openTextNodeEditor}
                                    onOpenDirector={editCanvasPrevis}
                                    onOpenDrawing={openDrawingNode}
                                />
                            </InfiniteCanvas>

                            {focusMode ? (
                                <CanvasFocusModeBar
                                    dockRevealed={focusDockRevealed}
                                    agentOpen={assistantOpen}
                                    zoomPercent={viewport.k}
                                    onToggleDock={() => setFocusDockRevealed((value) => !value)}
                                    onToggleAgent={() => (assistantOpen ? closeAgent() : openAgent())}
                                    onExit={exitFocusMode}
                                    onZoomIn={zoomCanvasIn}
                                    onZoomOut={zoomCanvasOut}
                                    onFit={resetViewport}
                                />
                            ) : null}

                            <CanvasFileDropOverlay active={fileDropActive} theme={theme} />

                            {emptyCanvasState}

                            {!focusMode || focusDockRevealed ? (
                                <CanvasToolbar
                                    selectedCount={selectedNodeIds.size}
                                    workspaceMode={workspaceMode}
                                    canvasTool={canvasTool}
                                    onToolChange={setCanvasTool}
                                    isProjectLinked={Boolean(shortDramaEnabled && currentProject?.projectId)}
                                    canUndo={historyState.canUndo}
                                    canRedo={historyState.canRedo}
                                    onAddImage={() => createNode(CanvasNodeType.Image)}
                                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                                    onAddText={() => createNode(CanvasNodeType.Text)}
                                    onChooseStyle={() => setStylePickerOpen(true)}
                                    onAddScript={() => createNode(CanvasNodeType.Script)}
                                    onAddFrame={() => createNode(CanvasNodeType.Frame)}
                                    onAddDrawing={() => createNode(CanvasNodeType.Drawing)}
                                    onOpenDirector={() => requestPrevisShot()}
                                    onOpenViralVideo={() => setViralVideoImportOpen(true)}
                                    onOpenScreenplay={() => { try { screenplay.create(getCanvasCenter()); } catch (error) { message.error(error instanceof Error ? error.message : "剧本创建失败"); } }}
                                    onUndo={undoCanvas}
                                    onRedo={redoCanvas}
                                    onUpload={() => handleUploadRequest()}
                                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                                    onClear={() => setClearConfirmOpen(true)}
                                    onArrangeAll={arrangeCanvas}
                                    onDeselect={deselectCanvas}
                                    onOpenMyAssets={() => {
                                        openCanvasAssetLibrary();
                                    }}
                                    onOpenProjectCharacters={() => openProjectAssets("character")}
                                    agentOpen={assistantOpen}
                                    onOpenAgent={() => openAgent()}
                                    onOpenShortcuts={openCanvasShortcuts}
                                />
                            ) : null}
                        </div>

                        {assistantMounted && !projectId.startsWith("tc_") ? (
                            <AssistantPanelColumn width={assistantWidth} closing={assistantClosing} floating={!assistantExpanded} topInset="0px" onWidthChange={setAssistantWidth}>
                                {(resizing) => (
                                    <CanvasAgentFloatingWindow size={assistantFloatingSize} expanded={assistantExpanded}>
                                        <CanvasAssistantPanel
                                            nodes={nodes}
                                            selectedNodeIds={selectedNodeIds}
                                            snapshot={agentSnapshot}
                                            projectId={projectId}
                                            sessions={chatSessions}
                                            activeSessionId={activeChatId}
                                            onSelectNodeIds={setSelectedNodeIds}
                                            onSessionsChange={handleAssistantSessionsChange}
                                            onApplyOps={applyAgentOps}
                                            onViralVideoAction={handleViralVideoAgentAction}
                                            onScreenplayAction={screenplay.agentAction}
                                            canUndoOps={canUndoAgentOps}
                                            undoOpsCount={agentUndoCount}
                                            onUndoOps={undoAgentOps}
                                            onPasteImage={pasteAssistantImage}
                                            agentMode={agentMode}
                                            onAgentModeChange={setAgentMode}
                                            autoConnectLocal={codexAutoConnect}
                                            closing={assistantClosing}
                                            onCollapse={closeAgent}
                                            onExpand={assistantExpanded ? collapseAgentToFloating : expandAgent}
                                            cinematicEntry={cinematicAgentEntry}
                                            onCinematicEntryConsumed={() => setCinematicAgentEntry(false)}
                                            resizing={resizing}
                                            floatingSize={assistantFloatingSize}
                                            onFloatingSizeChange={setAssistantFloatingSize}
                                            floating={!assistantExpanded}
                                        />
                                    </CanvasAgentFloatingWindow>
                                )}
                            </AssistantPanelColumn>
                        ) : null}
                    </div>

                    {angleNode?.metadata?.content ? (
                        <CanvasNodePanelOverlay node={angleNode} viewport={viewport} containerRef={containerRef} panelWidth={580} panelHeight={350}>
                            <CanvasNodeAnglePanel
                                dataUrl={angleNode.metadata.content}
                                onClose={() => setAngleNodeId(null)}
                                onConfirm={(params) => {
                                    void generateAngleNode(angleNode, params);
                                }}
                            />
                        </CanvasNodePanelOverlay>
                    ) : null}

                    {emotionNode?.metadata?.content ? (
                        <CanvasEmotionWorkspace
                            node={emotionNode}
                            viewport={viewport}
                            containerRef={containerRef}
                            onClose={() => setEmotionNodeId(null)}
                            onConfirm={(payload: CanvasImageEmotionPayload) => {
                                void generateEmotionNode(emotionNode, payload);
                            }}
                        />
                    ) : null}

                    {dialogNode && dialogNode.type !== CanvasNodeType.Script && dialogNode.type !== CanvasNodeType.Drawing && !selectionBox ? (
                        <CanvasNodePanelOverlay node={dialogNode} viewport={viewport} containerRef={containerRef} panelWidth={672} panelHeight={336} placement="below">
                            {renderCanvasNodePanel(dialogNode)}
                        </CanvasNodePanelOverlay>
                    ) : null}

                    {pendingConnectionCreate ? (
                        <CanvasConnectionCreateMenu
                            pending={pendingConnectionCreate}
                            viewport={viewport}
                            viewportSize={size}
                            containerRef={containerRef}
                            canCreateDrawing={canCreateDrawingFromConnection}
                            onCreate={(type) => void createConnectedNode(type, pendingConnectionCreate)}
                            onOpenViralVideo={openConnectionViralVideo}
                            onOpenScreenplay={() => { const position = pendingConnectionCreate?.position; const sourceId = pendingConnectionSourceNode?.id; cancelPendingConnectionCreate(); try { screenplay.create(position, sourceId); } catch (error) { message.error(error instanceof Error ? error.message : "剧本创建失败"); } }}
                            onClose={cancelPendingConnectionCreate}
                        />
                    ) : null}

                    {selectedNodeBounds && !selectionBox && !isNodeDragging ? (
                        <CanvasProjectSelectionToolbar
                            anchorRef={selectionBoundsElementRef}
                            containerRef={containerRef}
                            count={selectedNodeBounds.count}
                            selectedVideoCount={selectedVideoNodes.length}
                            mergingVideos={Boolean(mergeVideoProgress)}
                            onAlign={alignSelectedNodes}
                            onArrange={arrangeSelectedNodes}
                            onCreateStoryboard={createStoryboardGroup}
                            onCreateReferenceGroup={createReferenceGroup}
                            onMergeVideos={() => void mergeSelectedVideos()}
                        />
                    ) : null}

                    {uploadStatus ? <CanvasUploadStatusToast status={uploadStatus} theme={theme} /> : null}
                    {mergeVideoProgress ? <CanvasMergeStatusToast progress={mergeVideoProgress} theme={theme} /> : null}
                    {lastAgentChange ? (
                        <CanvasAgentChangeToast
                            change={lastAgentChange}
                            theme={theme}
                            onView={viewLastAgentChange}
                            onUndo={() => {
                                undoAgentOps();
                            }}
                            onClose={dismissLastAgentChange}
                        />
                    ) : null}

                    <CanvasNodeToolbar
                        node={isNodeDragging || nodeImageSettingsOpen || emotionNodeId ? null : toolbarNode}
                        workspaceMode={workspaceMode}
                        viewport={viewport}
                        containerRef={containerRef}
                        onKeep={keepNodeToolbar}
                        onLeave={hideNodeToolbar}
                        onInfo={(node) => (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId ? openTextNodeEditor(node) : setInfoNodeId(node.id))}
                        onEditText={openTextNodeEditor}
                        onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                        onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                        onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                        onGenerateImage={generateImageFromTextNode}
                        onUpload={(node) => handleUploadRequest(node.id)}
                        onDownload={downloadNodeImage}
                        downloading={!!toolbarNode && downloadingNodeIds.has(toolbarNode.id)}
                        onSaveAsset={(node) => void saveNodeAsset(node)}
                        onAnnotate={(node) => setAnnotationNodeId(node.id)}
                        onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                        onEmotion={(node) => {
                            setDialogNodeId(null);
                            setEmotionNodeId((current) => (current === node.id ? null : node.id));
                        }}
                        onPortraitTexture={generatePortraitTextureNode}
                        onCrop={(node) => setCropNodeId(node.id)}
                        onSplit={(node) => setSplitNodeId(node.id)}
                        onUpscale={(node) => setUpscaleNodeId(node.id)}
                        onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                        onAngle={(node) => {
                            setDialogNodeId(null);
                            setAngleNodeId((current) => (current === node.id ? null : node.id));
                        }}
                        onViewImage={(node) => setPreviewNodeId(node.id)}
                        onExtractVideoLastFrame={(node) => void extractVideoLastFrame(node)}
                        onAnalyzeVideoFrames={(node) => { createVideoAnalysis(node); setToolbarNodeId(null); }}
                        onExtractAudioFromVideo={(node) => void extractAudioFromVideo(node)}
                        onRemoveVideoSubtitles={(node) => setSubtitleRemovalNodeId(node.id)}
                        onTrimVideoRegenerate={(node) => void trimVideoAndRegenerate(node)}
                        onSubtitles={(node) => setSubtitleNodeId(node.id)}
                        onTimeline={(node) => setTimelineNodeId(node.id)}
                        extractingVideoFrame={toolbarNode?.id === extractingVideoFrameNodeId}
                        extractingAudio={segmentRunningMode === "audio"}
                        trimmingVideo={segmentRunningMode === "video"}
                        onReversePrompt={createImageReversePromptNodes}
                        onRetry={(node) => void handleRetryNode(node)}
                        onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                        onToggleLocked={(node) => toggleNodeLocked(node.id)}
                        onDelete={(node) => deleteNodes(new Set([node.id]))}
                    />

                    {isMiniMapOpen && !focusMode ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} canvasContainerRef={containerRef} onViewportPreviewChange={previewViewport} onViewportChange={handleViewportChange} /> : null}

                    {!focusMode ? (
                        <div
                            data-canvas-no-zoom
                            className="absolute bottom-[calc(var(--canvas-inset-y)+var(--space-16))] left-4 z-[var(--z-panel)] flex items-end gap-2 lg:bottom-[var(--canvas-inset-y)]"
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onWheel={(event) => event.stopPropagation()}
                        >
                            <CanvasAssetTray
                                assetImages={imageAssets}
                                canvasImages={canvasImageNodes}
                                showLibrary={!currentProject?.projectId}
                                activeNodeId={selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null}
                                onInsertAssetImage={(asset) => void createImageAssetNode(asset)}
                                onFocusCanvasImage={focusCanvasImageNode}
                            />
                            <CanvasZoomControls
                                scale={viewport.k}
                                containerRef={containerRef}
                                onScaleChange={setZoomScale}
                                onReset={resetViewport}
                                isMiniMapOpen={isMiniMapOpen}
                                onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                                onArrange={arrangeCanvas}
                            />
                        </div>
                    ) : null}

                    <CanvasProjectContextMenu
                        menu={contextMenu}
                        node={contextMenuNode}
                        workspaceMode={workspaceMode}
                        isProjectLinked={Boolean(currentProject?.projectId)}
                        canUndo={historyState.canUndo}
                        canRedo={historyState.canRedo}
                        canPaste={hasCopiedNodes || Boolean(navigator.clipboard)}
                        screenToCanvas={screenToCanvas}
                        onClose={() => setContextMenu(null)}
                        onAddNode={(type, position) => createNode(type, position)}
                        onChooseStyle={() => setStylePickerOpen(true)}
                        onOpenDirector={requestPrevisShot}
                        onOpenViralVideo={() => setViralVideoImportOpen(true)}
                        onOpenScreenplay={(position) => screenplay.create(position)}
                        onUpload={(nodeId, position) => handleUploadRequest(nodeId, position)}
                        onOpenAssets={openCanvasAssetLibrary}
                        onOpenProjectCharacters={(position) => openProjectAssets("character", position)}
                        onUndo={undoCanvas}
                        onRedo={redoCanvas}
                        onPaste={pasteAtPosition}
                        onCopyNode={(nodeId) => copyNodesToClipboard(new Set([nodeId]))}
                        onDuplicate={duplicateNode}
                        onDeleteNode={(nodeId) => deleteNodes(new Set([nodeId]))}
                        onDeleteConnection={deleteConnection}
                        onSaveAsset={(node) => {
                            void saveNodeAsset(node);
                        }}
                        onViewMedia={(node) => setPreviewNodeId(node.id)}
                        onEditText={openTextNodeEditor}
                        onOpenDrawing={openDrawingNode}
                        onGenerateImage={generateImageFromTextNode}
                        onCopyContent={(node) => {
                            void copyNodeContentToClipboard(node);
                        }}
                        onCopyMediaUrl={(node) => {
                            void copyNodeMediaUrlToClipboard(node);
                        }}
                        onSetAssetCategory={(nodeId, assetCategory) => handleConfigNodeChange(nodeId, { assetCategory })}
                        onToggleFrame={(node) => toggleFrameCollapsed(node.id)}
                    />

                    <CanvasUploadModal open={uploadModalOpen} onClose={closeUploadModal} onUpload={handleUploadFiles} />

                    <input ref={imageInputRef} type="file" accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                    <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} onMetadataChange={handleConfigNodeChange} />

                    <CanvasViralVideoImportDialog
                        open={viralVideoImportOpen}
                        onClose={() => setViralVideoImportOpen(false)}
                        onCreateReferenceVideo={async (video, title, sourceUrl, platform) => {
                            const source = await createReferenceVideoNode(video, title, sourceUrl, platform);
                            createViralVideo(source);
                        }}
                    />

                    {screenplay.workspaceNode ? <CanvasScreenplayWorkspace
                        key={screenplay.workspaceNode.id}
                        node={screenplay.workspaceNode}
                        nodes={nodes}
                        open={screenplay.visibleId === screenplay.workspaceNode.id}
                        onMinimize={() => screenplay.open(null)}
                        onSave={(doc, revision, label) => screenplay.save(screenplay.workspaceNode!.id, doc, revision, label)}
                        onGenerate={(request) => screenplay.generate(screenplay.workspaceNode!.id, request)}
                        onApprove={(revision) => screenplay.approve(screenplay.workspaceNode!.id, revision)}
                        onExtract={() => screenplay.extractAssets(screenplay.workspaceNode!.id)}
                        onRecover={() => screenplay.recover(screenplay.workspaceNode!.id)}
                        onCancelTask={() => screenplay.cancel(screenplay.workspaceNode!.id)}
                        onResolveResult={(copy, resetUnconfirmed) => screenplay.resolveResult(screenplay.workspaceNode!.id, copy, resetUnconfirmed)}
                        onOpenStoryboard={(id) => { screenplay.open(null); setScriptEditorNodeId(id); }}
                    /> : null}

                    {viralVideoOpenNode ? <CanvasViralVideoWorkspace
                        key={viralVideoOpenNode.id}
                        node={viralVideoOpenNode}
                        nodes={nodes}
                        open={viralVideoOpenNodeId === viralVideoOpenNode.id}
                        onMinimize={() => openViralVideo(null)}
                        onRetry={() => retryViralVideo(viralVideoOpenNode.id)}
                        onArrangeAssets={() => arrangeViralVideoAssets(viralVideoOpenNode.id)}
                        onReplaceAsset={(assetId, nodeId) => replaceViralVideoAsset(viralVideoOpenNode.id, assetId, nodeId)}
                        onUploadAsset={(assetId, file) => uploadViralVideoAsset(viralVideoOpenNode.id, assetId, file)}
                        onUpdatePlan={(rows, workflow) => updateViralVideoPlan(viralVideoOpenNode.id, rows, workflow)}
                        onPreview={async (rowIds) => { await generateScriptImages(viralVideoOpenNode.metadata!.viralVideo!.storyboardNodeId!, rowIds); }}
                        onGenerateVideos={async (rowIds) => { await generateScriptVideos(viralVideoOpenNode.metadata!.viralVideo!.storyboardNodeId!, rowIds); }}
                        onCompose={(nodeIds) => { openViralVideo(null); void mergeVideosByIds(nodeIds); }}
                        onOpenStoryboard={() => { setScriptEditorNodeId(viralVideoOpenNode.metadata!.viralVideo!.storyboardNodeId!); openViralVideo(null); }}
                    /> : null}

                    <CanvasVideoSubtitleRemovalDialog
                        node={subtitleRemovalNode}
                        open={Boolean(subtitleRemovalNode)}
                        processing={segmentRunningMode === "subtitle"}
                        onClose={() => {
                            if (segmentRunningMode !== "subtitle") setSubtitleRemovalNodeId(null);
                        }}
                        onConfirm={(params) => {
                            if (!subtitleRemovalNode) return;
                            void removeVideoSubtitles(subtitleRemovalNode, params).then((succeeded) => {
                                if (succeeded) setSubtitleRemovalNodeId(null);
                            });
                        }}
                    />

                    {subtitleNode ? (
                        <CanvasSubtitleDialog
                            node={subtitleNode}
                            open={Boolean(subtitleNode)}
                            projectId={projectId}
                            config={effectiveConfig}
                            onClose={() => setSubtitleNodeId(null)}
                            onSave={(nodeId, patch) => {
                                handleConfigNodeChange(nodeId, patch);
                                const currentTimeline = currentProject?.timeline;
                                if (currentTimeline) {
                                    const next = syncNodeSubtitlesToTimeline(currentTimeline, nodeId, patch.subtitleEntries || []);
                                    if (next !== currentTimeline) updateProject(projectId, { timeline: next });
                                }
                            }}
                        />
                    ) : null}

                    {segmentNode && segmentDialogMode ? (
                        <CanvasVideoSegmentDialog
                            node={segmentNode}
                            nodes={nodes}
                            connections={connections}
                            open={Boolean(segmentNode && segmentDialogMode)}
                            mode={segmentDialogMode}
                            config={effectiveConfig}
                            timeline={currentProject?.timeline || null}
                            onClose={closeSegmentDialog}
                            onConfirm={(params) => void handleSegmentConfirm(segmentNode, params)}
                        />
                    ) : null}

                    {timelineNode ? (
                        <CanvasTimelineDialog
                            node={timelineNode}
                            open={Boolean(timelineNode)}
                            nodes={nodes}
                            timeline={currentProject?.timeline || null}
                            onClose={() => setTimelineNodeId(null)}
                            onOpenSubtitleDialog={(subNodeId) => {
                                setTimelineNodeId(null);
                                setSubtitleNodeId(subNodeId);
                            }}
                            onSave={(next) => updateProject(projectId, { timeline: next })}
                            onSaveSubtitles={(subNodeId, entries) =>
                                handleConfigNodeChange(subNodeId, {
                                    subtitleEntries: entries,
                                    ...(entries.length ? {} : { subtitleHighlights: [] }),
                                    subtitleUpdatedAt: new Date().toISOString(),
                                })
                            }
                            onOpenAssetLibrary={openTimelineAssetLibrary}
                            onOpenProjectAssets={() => openProjectAssets("all", undefined, "timeline")}
                            onUploadLocalFiles={uploadTimelineMedia}
                            addNodeToTimelineRef={timelineAddNodeRef}
                            addMediaToTimelineRef={timelineMediaAddRef}
                            onCreateAssembledNode={createVideoNodeFromBlob}
                        />
                    ) : null}

                    <CanvasCharacterReferenceModal node={characterReferenceNode} open={Boolean(characterReferenceNode)} onClose={() => setCharacterReferenceNodeId(null)} />

                    <CanvasTextEditorModal
                        node={textEditorNode}
                        open={Boolean(textEditorNode)}
                        onClose={() => setTextEditorNodeId(null)}
                        onSave={(nodeId, title, content, richText) => {
                            setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, title, metadata: { ...node.metadata, content, richText } } : node)));
                        }}
                    />

                    {drawingNode ? (
                        <Suspense
                            fallback={
                                <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                                    <WorkspaceState icon="loading" title="正在加载绘图编辑器" description="正在准备绘图画布。" />
                                </div>
                            }
                        >
                            <CanvasDrawingEditorModal
                                node={drawingNode}
                                projectId={projectId}
                                open={Boolean(drawingNode)}
                                onClose={() => setDrawingNodeId(null)}
                                onSaved={(nodeId, summary) => {
                                    setNodes((current) =>
                                        current.map((node) =>
                                            node.id === nodeId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          drawingEngine: summary.engine,
                                                          drawingRevision: summary.revision,
                                                          drawingUpdatedAt: summary.updatedAt,
                                                          drawingShapeCount: summary.shapeCount,
                                                          drawingPageCount: summary.pageCount,
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                    message.success("绘图已保存");
                                }}
                            />
                        </Suspense>
                    ) : null}

                    <CanvasScriptEditor
                        node={activeScriptNode}
                        open={Boolean(activeScriptNode)}
                        references={scriptEditorReferences}
                        onClose={() => setScriptEditorNodeId(null)}
                        onUpdateRows={(rows) => activeScriptNode && replaceScriptRows(activeScriptNode.id, rows)}
                        onVisibleColumnsChange={(visibleColumns: StoryboardColumn[]) => {
                            if (!activeScriptNode || !visibleColumns.length) return;
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === activeScriptNode.id
                                        ? { ...node, metadata: { ...node.metadata, storyboard: { rows: node.metadata?.storyboard?.rows || [], visibleColumns, referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [] } } }
                                        : node,
                                ),
                            );
                        }}
                        onGenerateImages={(rowIds) => activeScriptNode && void generateScriptImages(activeScriptNode.id, rowIds)}
                        onAutoLinkReferences={(rowIds) => activeScriptNode && autoLinkScriptResources(activeScriptNode.id, rowIds)}
                        onAssignReferences={(rowIds, referenceNodeIds) => activeScriptNode && assignScriptResources(activeScriptNode.id, rowIds, referenceNodeIds)}
                        onGenerateVideos={(rowIds) => {
                            if (!activeScriptNode) return;
                            if (activeScriptNode.metadata?.storyboardVideoInputMode === "keyframe") void generateScriptVideos(activeScriptNode.id, rowIds);
                            else void createAndGenerateScriptVideos(activeScriptNode.id, rowIds);
                        }}
                        onVideoInputModeChange={(storyboardVideoInputMode) => activeScriptNode && handleConfigNodeChange(activeScriptNode.id, { storyboardVideoInputMode })}
                    />

                    {previsTemplateRequest ? (
                        <CanvasPrevisTemplateModal
                            open
                            onClose={() => setPrevisTemplateRequest(null)}
                            onSelect={(templateId) => {
                                createPrevisShot(templateId, previsTemplateRequest.position);
                                setPrevisTemplateRequest(null);
                            }}
                        />
                    ) : null}

                    {previsNodeId && activePrevisScene ? (
                        <Suspense
                            fallback={
                                <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                                    <WorkspaceState icon="loading" title="正在加载 3D 预演台" description="准备场景、镜头与空间控制。" />
                                </div>
                            }
                        >
                            <CanvasPrevisWorkbench
                                open
                                canvasId={projectId}
                                scene={activePrevisScene}
                                imageNodes={nodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey))}
                                onboardingScope={`canvas:${projectId}`}
                                onClose={() => setPrevisNodeId(null)}
                                onChange={savePrevisScene}
                                onApply={applyPrevisOutput}
                                onDeleteImageNode={(nodeId) => deleteNodes(new Set([nodeId]))}
                                onFlush={() => flushCanvasStorePersistence()}
                            />
                        </Suspense>
                    ) : null}

                    <CanvasVersionCompareModal
                        open={Boolean(versionCompareRootId)}
                        versions={versionCompareNodes}
                        onClose={() => setVersionCompareRootId(null)}
                        onSetPrimary={setPrimaryVersion}
                        onFocus={(nodeId) => {
                            setVersionCompareRootId(null);
                            focusCanvasNode(nodeId);
                        }}
                    />

                    <CanvasProjectMediaDialogs
                        cropNode={cropNode}
                        annotationNode={annotationNode}
                        maskEditNode={maskEditNode}
                        splitNode={splitNode}
                        upscaleNode={upscaleNode}
                        onCloseCrop={() => setCropNodeId(null)}
                        onCloseAnnotation={() => setAnnotationNodeId(null)}
                        onCloseMaskEdit={() => setMaskEditNodeId(null)}
                        onCloseSplit={() => setSplitNodeId(null)}
                        onCloseUpscale={() => setUpscaleNodeId(null)}
                        onCrop={(node, crop) => void cropImageNode(node, crop)}
                        onAnnotate={(node, dataUrl) => void saveAnnotatedImageNode(node, dataUrl)}
                        onMaskEdit={(node, payload) => void maskEditImageNode(node, payload)}
                        onSplit={(node, params) => void splitImageNode(node, params)}
                        onUpscale={(node, params) => void upscaleImageNode(node, params)}
                    />

                    <CanvasProjectStatusDialogs
                        theme={theme}
                        task={taskDetail}
                        taskLogs={taskDetailLogs}
                        taskLoading={taskDetailLoading}
                        onCloseTask={() => setTaskDetail(null)}
                        superResolveNode={superResolveNode}
                        superResolveSubmitting={videoSuperResolution.submitting}
                        onCloseSuperResolve={() => { if (!videoSuperResolution.submitting) setSuperResolveNodeId(null); }}
                        onConfirmSuperResolve={async (selection) => {
                            if (superResolveNode && await videoSuperResolution.submit(superResolveNode, selection)) setSuperResolveNodeId(null);
                        }}
                        previewNode={previewNode}
                        onClosePreview={() => setPreviewNodeId(null)}
                        clearConfirmOpen={clearConfirmOpen}
                        onCancelClear={() => setClearConfirmOpen(false)}
                        onConfirmClear={clearCanvas}
                    />

                    {assetPickerOpen && assetInsertScope === "canvas" ? <CanvasLibraryPanel teamId={currentProject?.teamId} templateSource={{ title: currentProject?.title || "团队模板", nodes, connections }} onClose={closeAssetPicker} onInsert={(payload) => handleAssetInsert(payload, { openDialog: false })} onTemplate={(payload) => {
                        const view = viewportRef.current;
                        const rect = containerRef.current?.getBoundingClientRect();
                        const fragment = instantiateLibraryTemplate(payload, { x: ((rect?.width || size.width) / 2 - view.x) / view.k, y: ((rect?.height || size.height) / 2 - view.y) / view.k });
                        setNodes((current) => [...current, ...fragment.nodes]);
                        setConnections((current) => [...current, ...fragment.connections]);
                        setSelectedNodeIds(new Set(fragment.nodes.map((node) => node.id)));
                        closeAssetPicker();
                    }} /> : <AssetPickerModal open={assetPickerOpen} onInsert={handleTimelineAssetInsert} onClose={closeAssetPicker} />}
                    <CanvasProjectAssetModal open={projectAssetOpen} detail={linkedProjectQuery.data} initialCategory={projectAssetInitialCategory} onClose={closeProjectAssets} onInsert={handleTimelineProjectAssetsInsert} />
                    {codexCompactAgent && !assistantMounted && !projectId.startsWith("tc_") ? (
                        <CanvasLocalAgentPanel headless snapshot={agentSnapshot} canUndoOps={canUndoAgentOps} undoOpsCount={agentUndoCount} onApplyOps={applyAgentOps} onUndoOps={undoAgentOps} autoConnect={codexAutoConnect} />
                    ) : null}
                </section>
            </main>
        </>
    );
}
