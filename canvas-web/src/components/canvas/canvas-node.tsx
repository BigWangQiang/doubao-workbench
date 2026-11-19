import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, BookOpenCheck, CheckCircle2, ChevronRight, Clapperboard, Clock3, FileText, Image as ImageIcon, LoaderCircle, Lock, Maximize2, Move3d, Music2, Pencil, Play, Plus, RefreshCw, Replace, Settings2, Square, Star, Type } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useGenerationTaskProgress } from "@/hooks/use-generation-task-progress";
import { useImageReveal } from "@/hooks/use-image-reveal";
import { isCanvasOverlayTarget } from "@/lib/canvas/canvas-interaction-boundary";
import { CometCard } from "@/components/ui/aceternity/comet-card";
import { PersistentResourceImage } from "@/components/persistent-resource-image";
import { resourceStorageLabel, resourceStorageLocation, resourceStorageTitle } from "@/lib/canvas/resource-storage-status";
import { canvasRichTextHTML } from "@/lib/canvas/canvas-rich-text";
import { formatBytes } from "@/lib/image-utils";
import { CONTENT_MODERATION_ERROR_CODE, generationErrorMessage, isContentModerationError } from "@/lib/generation-error";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { getResourcePlaybackStatus, playbackVariantUrl, resourceFileUrl, resourceIdFromStorageKey, resourceThumbnailUrl } from "@/services/api/resources";
import { cacheResourceObjectUrl, getCachedResourceObjectUrl, getLoadedResourceObjectUrl } from "@/services/resource-blob-cache";
import { forgetCanvasUploadedImageUrl, getCanvasUploadedImageUrl } from "@/services/canvas-media-upload";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { storyboardMinNodeHeight } from "./canvas-script-node";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { canvasVideoReferenceDisplayLabel, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { loadCanvasDrawingPreview } from "@/lib/canvas/canvas-drawing-storage";
import { ensureMediaNodeMinimumSize, MEDIA_NODE_MIN_SIZE } from "@/lib/canvas/canvas-node-size";
import { VideoPlayer } from "@/components/video-player";
import { createDefaultSubtitleStyle } from "@/types/timeline";
import { CanvasSubtitleOverlay } from "./canvas-subtitle-overlay";
import { CanvasVideoPreviewImage } from "./canvas-video-preview-image";
import { CanvasUploadPreview } from "./canvas-upload-preview";
import { CanvasPanningContext } from "./infinite-canvas";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasNodeProps = {
    data: CanvasNodeData;
    dragOffset?: Position;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    showImageInfo: boolean;
    reduceMediaEffects?: boolean;
    forceOriginalMedia?: boolean;
    readOnly?: boolean;
    resourceLabel?: CanvasResourceReference;
    mentionReferences?: CanvasResourceReference[];
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    drawingProjectId?: string;
    batchCount?: number;
    batchExpanded?: boolean;
    batchClosing?: boolean;
    batchOpening?: boolean;
    batchRecovering?: boolean;
    batchPrimary?: boolean;
    batchMotion?: { x: number; y: number; index: number };
    onMouseDown: (event: React.PointerEvent<HTMLDivElement>, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.PointerEvent, nodeId: string, handleType: "source" | "target", handleId?: string, anchorRatio?: number) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onTitleChange?: (nodeId: string, title: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (node: CanvasNodeData) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onCancelTask?: (node: CanvasNodeData) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onOpenVersions?: (node: CanvasNodeData) => void;
    /** 只读/共享画布仍可提供预览入口；媒体双击使用 onFocusMedia。 */
    onViewImage?: (node: CanvasNodeData) => void;
    onFocusMedia?: (node: CanvasNodeData) => void;
    onReplaceMedia?: (node: CanvasNodeData) => void;
    onOpenTextEditor?: (node: CanvasNodeData) => void;
    onOpenDirector?: (node: CanvasNodeData) => void;
    onOpenDrawing?: (node: CanvasNodeData) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    onReplaceMedia?: (node: CanvasNodeData) => void;
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    drawingProjectId?: string;
    onContentChange: (nodeId: string, content: string) => void;
    onResize?: CanvasNodeProps["onResize"];
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onCancelTask?: (node: CanvasNodeData) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onOpenDrawing?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    reduceMediaEffects?: boolean;
    forceOriginalMedia?: boolean;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    dragOffset,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    showImageInfo,
    reduceMediaEffects = false,
    readOnly = false,
    resourceLabel,
    mentionReferences = [],
    renderNodeContent,
    drawingProjectId,
    batchCount = 0,
    batchExpanded = false,
    batchClosing = false,
    batchOpening = false,
    batchRecovering = false,
    batchPrimary = false,
    batchMotion,
    forceOriginalMedia = false,
    onMouseDown,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResize,
    onTitleChange,
    onContentChange,
    onToggleBatch,
    onSetBatchPrimary,
    onRetry,
    onCancelTask,
    onOpenTaskDetails,
    onOpenVersions,
    onFocusMedia,
    onReplaceMedia,
    onOpenTextEditor,
    onOpenDirector,
    onOpenDrawing,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title);
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const hasMediaContent = hasImageContent || hasVideoContent || hasAudioContent;
    const isEmptyMediaNode = (data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Video) && !data.metadata?.content;
    const isGeneratingNode = data.type !== CanvasNodeType.Frame && data.metadata?.status === "loading";
    const isBatchRoot = data.type === CanvasNodeType.Image && Boolean(data.metadata?.isBatchRoot) && batchCount > 1;
    const isBatchChild = data.type === CanvasNodeType.Image && Boolean(data.metadata?.batchRootId);
    const showStatusTrack = Boolean(resourceLabel || data.metadata?.locked || isBatchRoot || (isBatchChild && !readOnly) || (hasMediaContent && !readOnly));
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const flushMediaContent = hasImageContent || hasVideoContent;
    const mediaBorderColor = isActive ? theme.accent.primary : isRelated && !isBatchChild ? theme.accent.primary : "transparent";
    // 图片分类用于素材检索，不叠在画面上遮挡人物与构图。
    const assetTags = data.type === CanvasNodeType.Image ? [] : data.metadata?.assetTags?.filter((tag) => tag.trim()) || [];
    const scriptMinHeight = data.type === CanvasNodeType.Script ? storyboardMinNodeHeight(data.metadata?.storyboardComposerHeight) : null;
    const nodeHoverLocked = reduceMediaEffects || Boolean(dragOffset) || isEditingContent || isEditingTitle || isGeneratingNode || scale < 0.32 || batchClosing || batchOpening;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!isEditingTitle) setTitleDraft(data.title);
    }, [data.title, isEditingTitle]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const isMediaNode = data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Video;
            const minWidth = data.type === CanvasNodeType.Script ? 800 : isMediaNode ? MEDIA_NODE_MIN_SIZE.width : 220;
            const minHeight = scriptMinHeight || (isMediaNode ? MEDIA_NODE_MIN_SIZE.height : 160);
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, data.type, onResize, scale, scriptMinHeight],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
    }, [handleResizeMove]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video,
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    const commitTitle = () => {
        const next = titleDraft.trim();
        setIsEditingTitle(false);
        if (!next) {
            setTitleDraft(data.title);
            return;
        }
        if (next !== data.title) onTitleChange?.(data.id, next);
    };

    const handleNodeDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (isBatchRoot) {
            event.stopPropagation();
            onToggleBatch?.(data.id);
            return;
        }
        if (data.metadata?.directorSceneId || data.metadata?.previsSceneId) {
            event.stopPropagation();
            onOpenDirector?.(data);
            return;
        }
        if ((data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Video) && hasMediaContent) {
            event.stopPropagation();
            onFocusMedia?.(data);
            return;
        }
        if (data.type === CanvasNodeType.Drawing) {
            event.stopPropagation();
            onOpenDrawing?.(data);
            return;
        }
        if (!readOnly && data.type === CanvasNodeType.Text && (data.metadata?.screenplay || data.metadata?.viralVideo || data.metadata?.videoAnalysis || (data.metadata?.workflowKind === "character" && data.metadata.characterAssetId))) {
            event.stopPropagation();
            onOpenTextEditor?.(data);
            return;
        }
        if (readOnly || data.type !== CanvasNodeType.Text) return;
        event.stopPropagation();
        setIsEditingContent(true);
    }, [data, hasMediaContent, isBatchRoot, onFocusMedia, onOpenDirector, onOpenDrawing, onOpenTextEditor, onToggleBatch, readOnly]);

    return (
        <div
            data-node-id={data.id}
            className={`node-element absolute flex select-none flex-col ${dragOffset ? "cursor-grabbing" : data.type === CanvasNodeType.Drawing ? "cursor-pointer" : "cursor-default"} ${isSelected ? "z-[var(--z-node-active)]" : "z-[var(--z-node)]"}`}
            style={{
                // 拖动偏移由 selection controller 通过 CSS translate 实时写入；
                // React 这里只维护提交后的基础位置，避免与 DOM 位移叠加。
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                contain: "layout style",
                willChange: dragOffset ? "transform, translate" : undefined,
            }}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                const target = event.target instanceof Element ? event.target : null;
                if (isCanvasOverlayTarget(target, event.currentTarget)) return;
                // 视频画面本身仍属于节点拖动区域；只有播放器控制条、菜单和表单控件
                // 保留 data-canvas-no-zoom 的独立交互，避免按住画面时无法拖动节点。
                const isVideoSurface = Boolean(target?.closest(".canvas-video-player")) && !target?.closest(".vds-controls,.vds-menu-items");
                if (target?.closest("button,input,textarea,select,[data-canvas-no-zoom]") && !isVideoSurface) return;
                onMouseDown(event, data.id);
            }}
            onDoubleClick={handleNodeDoubleClick}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <NodeExternalHeader
                node={data}
                scale={scale}
                active={hovered || isSelected || isFocusRelated}
                editable={!readOnly && !data.metadata?.locked && Boolean(onTitleChange)}
                editing={isEditingTitle}
                draft={titleDraft}
                theme={theme}
                onDraftChange={setTitleDraft}
                onEdit={() => setIsEditingTitle(true)}
                onCommit={commitTitle}
                onCancel={() => { setTitleDraft(data.title); setIsEditingTitle(false); }}
            />
            {/* 画布节点不启用指针跟随 3D 位移，hover 反馈统一走 CSS 静态抬升，避免鼠标移动形成反馈震荡 */}
            <CometCard
                containerClassName="overflow-visible"
                className={`canvas-node-shell relative h-full w-full overflow-visible rounded-[var(--node-radius)] ${data.metadata?.directorSceneId ? "canvas-director-shell" : ""} ${flushMediaContent || isEmptyMediaNode ? "border-0" : "border"} ${isGeneratingNode ? "canvas-node-shell-generating" : ""}`}
                disabled
                data-canvas-node-hover-locked={nodeHoverLocked ? "true" : "false"}
                data-selected={isSelected ? "true" : "false"}
                data-state={data.metadata?.status || (isActive ? "active" : isRelated ? "related" : "idle")}
                style={{
                    background: flushMediaContent ? "transparent" : isEmptyMediaNode ? "var(--card-surface-hover)" : theme.node.fill,
                    borderColor: flushMediaContent || isEmptyMediaNode ? undefined : isActive ? theme.accent.primary : isRelated ? theme.accent.primary : hovered ? "color-mix(in oklch, var(--workspace-border) 80%, var(--workspace-fg) 12%)" : theme.node.stroke,
                    boxShadow: isFocusRelated
                        ? `0 0 0 1px ${theme.accent.primary}66, 0 0 0 6px ${theme.accent.primary}1a, 0 28px 80px ${theme.spatial.shadow}` // active：最强强调（外发光环6px + inner glow）
                        : isConnectionTarget
                            ? `0 0 0 1px ${theme.accent.primary}66, 0 0 0 4px ${theme.accent.primary}1a, 0 24px 72px ${theme.spatial.shadow}` // selected-primary：4px软色环 + resize handle
                            : isSelected || (isRelated && !isBatchChild)
                                ? `0 0 0 2px ${theme.accent.primary}40, 0 22px 60px ${theme.spatial.shadow}` // selected：2px边框环
                                : undefined, // idle：无额外阴影
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot || data.type === CanvasNodeType.Script ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: flushMediaContent ? "transparent" : isEmptyMediaNode ? "var(--card-surface-hover)" : theme.node.fill,
                            "--batch-from-x": `${batchMotion?.x || 0}px`,
                            "--batch-from-y": `${batchMotion?.y || 0}px`,
                            "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
                            animation: data.metadata?.batchRootId ? (batchClosing ? `canvas-batch-child-out var(--motion-dur-base-calc) var(--motion-ease-in-out) both` : `canvas-batch-child-in var(--motion-dur-slow-calc) var(--motion-ease-out) both`) : undefined,
                            animationDelay: data.metadata?.batchRootId ? `${batchClosing ? 0 : 45 + (batchMotion?.index || 0) * 24}ms` : undefined,
                        } as React.CSSProperties
                    }
                >
                    {/* 节点状态徽章（对应 #97 决策2：左上角 loading/success/error，近距离确认信号）*/}
                    {data.metadata?.status && data.metadata.status !== "idle" && data.type !== CanvasNodeType.Frame ? (
                        <NodeStatusBadge status={data.metadata.status} />
                    ) : null}
                    <NodeContent
                        onReplaceMedia={readOnly ? undefined : onReplaceMedia}
                        node={data}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        batchOpening={batchOpening}
                        batchRecovering={batchRecovering}
                        renderNodeContent={renderNodeContent}
                        drawingProjectId={drawingProjectId}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onResize={readOnly ? undefined : onResize}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onCancelTask={onCancelTask}
                        onOpenTaskDetails={onOpenTaskDetails}
                        onOpenDrawing={onOpenDrawing}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        reduceMediaEffects={reduceMediaEffects}
                        forceOriginalMedia={forceOriginalMedia}
                    />
                </div>

                {flushMediaContent ? (
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-0 z-[var(--node-z-content)] rounded-[inherit]"
                        style={{ boxShadow: `inset 0 0 0 1px ${mediaBorderColor}` }}
                    />
                ) : null}

                {(hasImageContent || hasVideoContent) && !readOnly ? (
                    <div
                        className={`absolute bottom-[10%] left-1/2 z-[var(--node-z-overlay)] -translate-x-1/2 motion-safe:transition motion-safe:duration-200 ${isSelected ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="inline-flex h-9 items-center gap-2 rounded-full border px-4 text-xs font-semibold shadow-lg backdrop-blur-xl transition hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:hover:translate-y-0"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.accent.primary }}
                            onClick={(event) => { event.stopPropagation(); onReplaceMedia?.(data); }}
                            aria-label="替换媒体"
                        >
                            <Replace className="size-3.5" />
                            替换
                        </button>
                    </div>
                ) : null}

                {data.type === CanvasNodeType.Text && !data.metadata?.screenplay && !data.metadata?.viralVideo && !data.metadata?.videoAnalysis && data.metadata?.workflowKind !== "character" && !readOnly ? (
                    <div
                        className={`absolute bottom-[10%] left-1/2 z-[var(--node-z-overlay)] -translate-x-1/2 motion-safe:transition motion-safe:duration-200 ${isSelected ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="inline-flex h-9 items-center gap-2 rounded-full border px-4 text-xs font-semibold shadow-lg backdrop-blur-xl transition hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:hover:translate-y-0"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.accent.primary }}
                            onClick={(event) => { event.stopPropagation(); onOpenTextEditor?.(data); }}
                            aria-label="放大编辑文本"
                        >
                            <Maximize2 className="size-3.5" />
                            放大编辑
                        </button>
                    </div>
                ) : null}

                {data.metadata?.versionLabel ? (
                    <button
                        type="button"
                        className="absolute left-3 top-3 z-[var(--node-z-overlay)] grid size-7 place-items-center rounded-[var(--r-full)] border p-0.5 text-[var(--node-badge-fs)] font-semibold leading-none backdrop-blur-md transition-[transform,background,border-color,box-shadow] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:hover:translate-y-0"
                        style={{
                            background: data.metadata.versionPrimary ? theme.accent.primarySoft : theme.toolbar.panel,
                            borderColor: data.metadata.versionPrimary ? theme.accent.primary : theme.toolbar.border,
                            color: data.metadata.versionPrimary ? theme.accent.primary : theme.node.text,
                            boxShadow: data.metadata.versionPrimary ? "0 0 0 2px " + theme.accent.primarySoft : "var(--shadow-sm)",
                            outlineColor: theme.accent.primary,
                        }}
                        title={data.metadata.versionLabel + (data.metadata.versionPrimary ? " · 主版本" : "") + "，点击查看版本对比"}
                        aria-label={data.metadata.versionLabel + (data.metadata.versionPrimary ? "，主版本" : "") + "，查看版本对比"}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => { event.stopPropagation(); onOpenVersions?.(data); }}
                    >
                        {data.metadata.versionLabel}
                    </button>
                ) : null}
                {showStatusTrack ? (
                    <div className={`absolute right-3 top-3 z-[var(--node-z-overlay)] flex min-w-0 items-center justify-end gap-1 ${data.metadata?.versionLabel ? "max-w-[calc(100%-104px)]" : "max-w-[calc(100%-24px)]"}`}>
                        {resourceLabel && data.type !== CanvasNodeType.Image ? <ResourceLabelBadge reference={resourceLabel} theme={theme} /> : null}
                        {hasMediaContent && !readOnly ? <ResourceStorageBadge storageKey={data.metadata?.storageKey} active={isActive} theme={theme} /> : null}
                        {isBatchRoot ? <BatchToggleBadge count={batchCount} expanded={batchExpanded} theme={theme} onToggle={() => onToggleBatch?.(data.id)} /> : null}
                        {isBatchChild && !readOnly ? <BatchPrimaryBadge visible={batchPrimary || hovered || isSelected} selected={batchPrimary} theme={theme} onSelect={() => onSetBatchPrimary?.(data)} /> : null}
                        {data.metadata?.locked ? <NodeLockBadge theme={theme} /> : null}
                    </div>
                ) : null}
                {assetTags.length || (showImageInfo && hasImageContent) ? (
                    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-[var(--node-z-overlay)] flex items-end justify-between gap-2">
                        {assetTags.length ? <AssetTagBadges tags={assetTags} theme={theme} /> : null}
                        {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}
                    </div>
                ) : null}

                {!hasImageContent && !hasVideoContent && !hasAudioContent && !data.metadata?.screenplay && !data.metadata?.viralVideo && !data.metadata?.videoAnalysis && data.type !== CanvasNodeType.Drawing ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} /> : null}

                {!readOnly && !data.metadata?.locked ? <>
                    <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
                    <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
                    <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
                    <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
                </> : null}
            </CometCard>

            {!readOnly && data.type !== CanvasNodeType.Script ? <ConnectionSideRail side="left" scale={scale} visible={hovered} theme={theme} onPointerDown={(event, anchorRatio) => onConnectStart(event, data.id, "target", undefined, anchorRatio)} /> : null}
            {!readOnly && data.type !== CanvasNodeType.Script && data.type !== CanvasNodeType.Config ? <ConnectionSideRail side="right" scale={scale} visible={hovered} theme={theme} onPointerDown={(event, anchorRatio) => onConnectStart(event, data.id, "source", undefined, anchorRatio)} /> : null}

        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    if (props.node.metadata?.mediaUploadId) return <CanvasUploadPreview node={props.node} theme={props.theme} onResize={props.onResize} onReplace={props.onReplaceMedia} />;
    const hasCustomContent = props.node.type === CanvasNodeType.Config
        || Boolean(props.node.metadata?.screenplay)
        || Boolean(props.node.metadata?.viralVideo)
        || Boolean(props.node.metadata?.videoAnalysis)
        || props.node.type === CanvasNodeType.Script
        || Boolean(props.node.metadata?.directorSceneId)
        || Boolean(props.node.metadata?.previsSceneId)
        || (props.node.metadata?.workflowKind === "character" && Boolean(props.node.metadata.characterAssetId))
        || (props.node.metadata?.workflowKind === "story_input" && !props.isEditingContent)
        || (props.node.metadata?.workflowKind === "styleboard" && !props.node.metadata.content);
    if (hasCustomContent && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading") return <LoadingContent node={props.node} theme={props.theme} onCancelTask={props.onCancelTask} onOpenTaskDetails={props.onOpenTaskDetails} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;

    const Renderer = nodeContentRenderers[props.node.type];
    return Renderer ? <Renderer {...props} /> : <UnknownNodeContent theme={props.theme} />;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Script]: UnknownNodeContent,
    [CanvasNodeType.Skill]: SkillContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Drawing]: DrawingContent,
    [CanvasNodeType.Frame]: UnknownNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function DrawingContent({ node, theme, drawingProjectId }: NodeContentRendererProps) {
    const shapeCount = node.metadata?.drawingShapeCount || 0;
    const pageCount = node.metadata?.drawingPageCount || 1;
    const [previewUrl, setPreviewUrl] = useState(node.metadata?.drawingPreviewUrl || "");

    useEffect(() => {
        const drawingId = node.metadata?.drawingId;
        const fallbackPreview = node.metadata?.drawingPreviewUrl || "";
        setPreviewUrl(fallbackPreview);
        if (!drawingProjectId || !drawingId) return;
        let active = true;
        let objectUrl = "";
        void loadCanvasDrawingPreview(drawingProjectId, drawingId).then((preview) => {
            if (!active) return;
            if (!preview) {
                setPreviewUrl(fallbackPreview);
                return;
            }
            objectUrl = URL.createObjectURL(preview);
            setPreviewUrl(objectUrl);
        }).catch((error) => console.warn("读取绘图节点预览失败", error));
        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [drawingProjectId, node.metadata?.drawingId, node.metadata?.drawingPreviewUrl, node.metadata?.drawingRevision]);

    return (
        <div className="relative h-full w-full overflow-hidden" style={{ background: theme.node.panel, color: theme.node.text }}>
            {previewUrl ? (
                <img src={previewUrl} alt="绘图预览" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
            ) : (
                <div className="absolute inset-0 grid place-items-center" style={{ backgroundImage: `radial-gradient(circle, ${theme.node.stroke} 1px, transparent 1px)`, backgroundSize: "18px 18px" }}>
                    <span className="grid size-12 place-items-center rounded-xl border" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.muted }}>
                        <Pencil className="size-5" />
                    </span>
                </div>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 px-4 pb-3 pt-12" style={{ background: `linear-gradient(to top, ${theme.node.fill}, ${theme.node.fill}e6 55%, transparent)` }}>
                <div className="min-w-0">
                    <div className="truncate text-xs font-semibold" title={node.title || "绘图"}>{node.title || "绘图"}</div>
                    <div className="mt-0.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{shapeCount} 个图形 · {pageCount} 个页面</div>
                </div>
                <Pencil className="size-3.5 shrink-0" style={{ color: theme.accent.primary }} />
            </div>
        </div>
    );
}

function LoadingContent({ node, theme, onCancelTask, onOpenTaskDetails }: Pick<NodeContentRendererProps, "node" | "theme" | "onCancelTask" | "onOpenTaskDetails">) {
    const taskId = node.metadata?.taskId;
    const statusLabel = taskStatusLabel(node.metadata?.taskStatus);
    const mediaMode = node.metadata?.generationMode === "video" || node.type === CanvasNodeType.Video ? "video" : node.metadata?.generationMode === "image" || node.type === CanvasNodeType.Image ? "image" : null;
    const display = useGenerationTaskProgress({
        type: mediaMode ? `canvas_${mediaMode}` : undefined,
        status: node.metadata?.taskStatus || "running",
        progress: node.metadata?.taskProgress,
        stage: node.metadata?.taskStage,
        createdAt: node.metadata?.taskCreatedAt,
        startedAt: node.metadata?.taskStartedAt,
    });
    const progress = display.percent ?? null;
    const elapsed = formatTaskElapsed(node.metadata?.taskCreatedAt, display.now);
    return (
        <div aria-busy="true" className={`relative flex h-full w-full flex-col items-center justify-center gap-2.5 overflow-hidden px-5 text-center ${mediaMode ? "canvas-generation-loading-media" : ""}`} style={{ color: theme.node.activeStroke }}>
            {mediaMode ? <><div className="generation-pending-flow" aria-hidden="true" /><div className="generation-pending-sheen" aria-hidden="true" /><div className="canvas-generation-loading-label">{progress !== null ? `${display.label} · ` : ""}{mediaMode === "video" ? "视频处理中" : "图片造梦中"}</div></> : <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />}
            <span className="text-[var(--fs-tiny)] font-semibold">{display.stage || (taskId ? "任务处理中" : "正在创建任务")}</span>
            {taskId ? (
                <div className="flex w-full max-w-[210px] flex-col items-center gap-1.5">
                    <div className="max-w-full truncate text-[var(--fs-label)] font-medium" style={{ color: theme.node.text }}>
                        {mediaMode === "video" && node.metadata?.taskStatus === "running" ? "任务进度" : statusLabel}
                        {progress !== null ? ` · ${display.label}` : ""}
                    </div>
                    <div role="progressbar" aria-label={display.stage || "任务处理中"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined} aria-valuetext={display.label} className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                        {progress !== null ? <div className="h-full rounded-full transition-[width] motion-reduce:transition-none" style={{ width: `${progress}%`, background: theme.node.activeStroke }} /> : <div className="h-full w-1/3 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: theme.node.activeStroke }} />}
                    </div>
                    <div className="max-w-full truncate text-[var(--fs-tiny)] tabular-nums" style={{ color: theme.node.muted }}>
                        <Clock3 className="mr-1 inline size-3" />{elapsed} · {shortTaskId(taskId)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                        <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[var(--fs-tiny)] font-medium transition hover:brightness-110" style={{ background: theme.toolbar.itemHover, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpenTaskDetails?.(node); }}><FileText className="size-3" />详情</button>
                        <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[var(--fs-tiny)] font-medium transition hover:brightness-110" style={{ background: `${theme.accent.danger}16`, color: theme.accent.danger }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCancelTask?.(node); }}><Square className="size-2.5 fill-current" />取消</button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function formatTaskElapsed(createdAt: string | undefined, now: number) {
    if (!createdAt) return "刚刚";
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) return "刚刚";
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}分${seconds % 60}秒` : `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

function taskStatusLabel(status?: string) {
    if (status === "queued") return "排队中";
    if (status === "running") return "生成中";
    if (status === "succeeded") return "任务已完成";
    if (status === "failed") return "任务失败";
    if (status === "cancelled") return "任务已取消";
    return status ? "未知任务状态" : "等待任务状态";
}

function shortTaskId(id: string) {
    if (id.length <= 20) return id;
    return `${id.slice(0, 14)}...${id.slice(-4)}`;
}

function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    const moderationFailure = node.metadata?.generationErrorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(node.metadata?.errorDetails);
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="text-xs leading-5" style={{ color: theme.accent.danger }}>{generationErrorMessage(node.metadata?.errorDetails)}</div>
            {moderationFailure ? (
                <div className="rounded-md border px-3 py-2 text-[var(--fs-label)] leading-4" style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.muted }}>
                    修改节点提示词后，可重新点击生成。
                </div>
            ) : (
                <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onRetry?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <RefreshCw className="size-3.5" />
                    重试
                </button>
            )}
        </div>
    );
}

function UnknownNodeContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>
            未知节点
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStopEditing }: NodeContentRendererProps) {
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    const richTextHTML = useMemo(() => canvasRichTextHTML(node.metadata?.richText), [node.metadata?.richText]);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden pt-10">
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-4 pt-0 pb-4 m-0 font-mono outline-none select-text appearance-none"
                    style={textStyle}
                    value={node.metadata?.content || ""}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : richTextHTML ? (
                <div
                    className="thin-scrollbar block h-full w-full overflow-y-auto break-words bg-transparent px-4 pb-4 font-mono [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:opacity-70 [&_code]:rounded [&_code]:bg-black/6 [&_code]:px-1 dark:[&_code]:bg-white/8 [&_h1]:my-2 [&_h1]:text-[1.55em] [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-[1.3em] [&_h2]:font-semibold [&_h3]:my-1.5 [&_h3]:text-[1.12em] [&_h3]:font-semibold [&_hr]:my-3 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/90 [&_pre]:p-2 [&_pre]:text-white [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                    style={textStyle}
                    onWheel={(event) => event.stopPropagation()}
                    dangerouslySetInnerHTML={{ __html: richTextHTML }}
                />
            ) : (
                <div
                    className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pt-0 pb-4 font-mono"
                    style={textStyle}
                    onWheel={(event) => event.stopPropagation()}
                >
                    {node.metadata?.content || <span style={{ color: theme.node.placeholder }}>双击编辑文字</span>}
                </div>
            )}
        </div>
    );
}

function SkillContent({ node, theme }: NodeContentRendererProps) {
    const skill = node.metadata?.skillSnapshot;
    const tags = skill?.tags?.slice(0, 4) || [];
    const template = skill?.template || node.metadata?.content || "";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden p-4" style={{ color: theme.node.text }}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: `${theme.node.activeStroke}18`, color: theme.node.activeStroke }}>
                            <BookOpenCheck className="size-4" />
                        </span>
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold" title={skill?.name || node.title || "技能"}>{skill?.name || node.title || "技能"}</div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>
                                <span>{skillCategoryLabel(skill?.category)}</span>
                                <span>·</span>
                                <span>{skillOutputModeLabel(skill?.outputMode)}</span>
                                {skill?.version ? (
                                    <>
                                        <span>·</span>
                                        <span>v{skill.version}</span>
                                    </>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {skill?.description ? <div className="mt-3 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{skill.description}</div> : null}

            <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}>
                <div className="mb-1 font-semibold opacity-55">模板</div>
                <div className="line-clamp-4 whitespace-pre-wrap break-words">{template || "未配置技能模板"}</div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.length ? tags.map((tag) => (
                    <span key={tag} className="rounded-md border px-1.5 py-0.5 text-[var(--fs-tiny)]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        {tag}
                    </span>
                )) : <span className="text-[var(--fs-label)]" style={{ color: theme.node.muted }}>连接到图片、视频、音频或文本节点后生效</span>}
            </div>
        </div>
    );
}

function skillCategoryLabel(category?: string) {
    if (category === "writing") return "剧情";
    if (category === "storyboard") return "分镜";
    if (category === "image") return "生图";
    if (category === "video") return "视频";
    return "通用";
}

function skillOutputModeLabel(mode?: string) {
    if (mode === "json") return "JSON";
    if (mode === "image_prompt") return "生图提示词";
    if (mode === "workflow") return "工作流";
    return "文本";
}

function ResourceLabelBadge({ reference, theme }: { reference: CanvasResourceReference; theme: CanvasTheme }) {
    const displayLabel = reference.kind === "video" ? canvasVideoReferenceDisplayLabel(reference) : reference.label;
    return (
        <span className="pointer-events-none min-w-0 max-w-28 truncate rounded-md px-1.5 py-1 text-[var(--fs-tiny)] font-medium leading-none text-white shadow-sm" style={{ background: reference.active ? theme.accent.primary : "rgba(0,0,0,.35)", opacity: reference.active ? 1 : 0.75 }} title={reference.title || displayLabel}>
            {displayLabel}
        </span>
    );
}

function ResourceStorageBadge({ storageKey, active, theme }: { storageKey?: string; active: boolean; theme: CanvasTheme }) {
    const location = resourceStorageLocation(storageKey);
    const background = active ? (location === "local" ? "rgba(245,158,11,.9)" : theme.accent.primary) : "rgba(0,0,0,.35)";
    return (
        <span className="pointer-events-auto shrink-0 rounded-md px-1.5 py-1 text-[var(--fs-tiny)] font-medium leading-none text-white shadow-sm" style={{ background, opacity: active ? 1 : 0.75 }} title={resourceStorageTitle(storageKey)}>
            {resourceStorageLabel(storageKey)}
        </span>
    );
}

function NodeLockBadge({ theme }: { theme: CanvasTheme }) {
    return <span className="pointer-events-none grid size-7 shrink-0 place-items-center rounded-md border backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.muted }} title="节点已锁定"><Lock className="size-3.5" /></span>;
}

function BatchToggleBadge({ count, expanded, theme, onToggle }: { count: number; expanded: boolean; theme: CanvasTheme; onToggle: () => void }) {
    return (
        <button type="button" className="canvas-node-tool-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[var(--fs-tiny)] font-semibold backdrop-blur-md" style={{ background: `${theme.toolbar.panel}d9`, borderColor: `${theme.toolbar.border}cc`, color: theme.node.text }} aria-label={expanded ? "图片组已展开" : "图片组已收起"} onClick={(event) => { event.stopPropagation(); onToggle(); }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <span className="leading-none" style={{ color: theme.accent.primary }}>{count}</span>
            <ChevronRight className={`size-3 opacity-55 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
    );
}

function BatchPrimaryBadge({ visible, selected, theme, onSelect }: { visible: boolean; selected: boolean; theme: CanvasTheme; onSelect: () => void }) {
    return (
        <button type="button" className={`canvas-node-tool-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[var(--fs-tiny)] font-medium backdrop-blur-md transition-opacity ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`} style={{ background: theme.toolbar.panel, borderColor: selected ? theme.accent.primary : theme.toolbar.border, color: selected ? theme.accent.primary : theme.node.text }} aria-label={selected ? "当前主图" : "设置为主图"} aria-pressed={selected} onClick={(event) => { event.stopPropagation(); onSelect(); }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Star className={`size-3 ${selected ? "fill-current" : ""}`} style={{ color: theme.accent.primary }} />
            {selected ? "当前主图" : "主图"}
        </button>
    );
}

function AssetTagBadges({ tags, theme }: { tags: string[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-1">
            {tags.map((tag, index) => (
                <span
                    key={`${tag}-${index}`}
                    className="max-w-full truncate rounded-md border px-1.5 py-1 text-[var(--fs-tiny)] font-medium leading-none backdrop-blur-sm"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                >
                    {tag.trim()}
                </span>
            ))}
        </div>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && props.isBatchRoot) {
        const content =
            props.node.metadata?.status === "loading" ? (
                <LoadingContent node={props.node} theme={props.theme} />
            ) : props.node.metadata?.status === "error" ? (
                <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />
            ) : (
                <EmptyImageContent {...props} isBatchRoot={false} />
            );
        return (
            <BatchFrame batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} theme={props.theme} onToggleBatch={props.onToggleBatch}>
                {content}
            </BatchFrame>
        );
    }
    if (!props.node.metadata?.content) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            theme={props.theme}
            isBatchRoot={props.isBatchRoot}
            batchCount={props.batchCount}
            batchExpanded={props.batchExpanded}
            batchOpening={props.batchOpening}
            batchRecovering={props.batchRecovering}
            onToggleBatch={props.onToggleBatch}
            forceOriginalMedia={props.forceOriginalMedia}
        />
    );
}

function EmptyImageContent({ theme, isBatchRoot, batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: NodeContentRendererProps) {
    const content = (
        <div className="grid h-full w-full place-items-center" style={{ color: theme.node.placeholder }}>
            <ImageIcon aria-hidden="true" className="size-10 opacity-30" strokeWidth={1.5} />
        </div>
    );
    if (isBatchRoot)
        return (
            <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} theme={theme} onToggleBatch={onToggleBatch}>
                {content}
            </BatchFrame>
        );
    return content;
}

function VideoNodeContent({ node, theme, onResize, forceOriginalMedia = false }: NodeContentRendererProps) {
    const videoNodeRef = useRef<HTMLDivElement>(null);
    const playerBoxRef = useRef<HTMLDivElement>(null);
    const isVisible = useViewportIntersection(videoNodeRef);
    const nearViewport = useViewportIntersection(videoNodeRef, "320px");
    const isCanvasPanning = React.useContext(CanvasPanningContext);
    const [isPointerHovering, setIsPointerHovering] = useState(false);
    const [touchPlaybackRequested, setTouchPlaybackRequested] = useState(false);
    const lastPointerType = useRef("");
    const [hasFrame, setHasFrame] = useState(false);
    // 可见节点自动预加载少量播放器元数据，但保持暂停；悬停或触屏只负责
    // 启动播放。离开视口/画布平移时 shouldLoad 变为 false，会卸载播放器，
    // 释放 HLS/MSE 和网络连接，封面节点本身仍然保留。
    const playbackRequested = (isPointerHovering || touchPlaybackRequested) && !isCanvasPanning && nearViewport;
    const preloadRequested = isVisible && !isCanvasPanning;
    const preloadSlot = useCanvasVideoPreloadSlot(node.id, preloadRequested, playbackRequested);
    const shouldLoad = forceOriginalMedia ? nearViewport && !isCanvasPanning : preloadRequested && preloadSlot;
    const { url: loadedUrl, fallbackToOriginal } = useNodeResourceUrl(node, shouldLoad, true, false, 640, !forceOriginalMedia, playbackRequested && !forceOriginalMedia);
    const url = shouldLoad ? loadedUrl : "";
    const subtitleEntries = node.metadata?.subtitleEntries || [];
    const subtitleStyle = node.metadata?.subtitleStyle || createDefaultSubtitleStyle();
    const [currentTimeMs, setCurrentTimeMs] = useState(0);
    const [videoSize, setVideoSize] = useState<{ width: number; height: number; content: string } | null>(null);
    const content = node.metadata?.content || "";
    const mediaSize = videoSize?.content === content ? videoSize : null;
    const captureVideoSize = useCallback(() => {
        const video = playerBoxRef.current?.querySelector("video");
        if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        setVideoSize((current) => current?.content === content && current.width === width && current.height === height ? current : { width, height, content });
    }, [content]);
    const previewInteractions = {
        onPointerEnter: (event: React.PointerEvent<HTMLDivElement>) => {
            lastPointerType.current = event.pointerType;
            if (event.pointerType === "mouse" || event.pointerType === "pen") setIsPointerHovering(true);
        },
        onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => {
            if (event.pointerType === "mouse" || event.pointerType === "pen") setIsPointerHovering(false);
        },
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
            lastPointerType.current = event.pointerType;
        },
        onClick: () => {
            if (lastPointerType.current === "touch") setTouchPlaybackRequested(true);
        },
    };

    // 视频元素由 vidstack 内部创建，直接监听原生事件取分辨率；只有存在字幕时才跟踪播放时间，避免无字幕节点频繁重渲染。
    useEffect(() => {
        const box = playerBoxRef.current;
        const video = box?.querySelector("video");
        if (!video) return;
        const handleLoadedMetadata = captureVideoSize;
        video.addEventListener("loadedmetadata", handleLoadedMetadata);
        handleLoadedMetadata();
        if (!subtitleEntries.length) {
            return () => video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        }
        const handleTimeUpdate = () => setCurrentTimeMs(Math.round(video.currentTime * 1000));
        video.addEventListener("timeupdate", handleTimeUpdate);
        return () => {
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        };
    }, [captureVideoSize, subtitleEntries.length, url]);

    useEffect(() => {
        if (!mediaSize || !onResize || node.metadata?.locked || node.metadata?.freeResize) return;
        // 元数据可能在任务结果回传后才可读，此时同步外框，而不只缩放内部播放器。
        const aligned = ensureMediaNodeMinimumSize({ ...node, metadata: { ...node.metadata, naturalWidth: mediaSize.width, naturalHeight: mediaSize.height } });
        if (aligned.width !== node.width || aligned.height !== node.height) onResize(node.id, aligned.width, aligned.height, aligned.position);
    }, [mediaSize, node, onResize]);

    useEffect(() => {
        if (isVisible && !isCanvasPanning && playbackRequested) return;
        const video = playerBoxRef.current?.querySelector("video");
        video?.pause();
    }, [isCanvasPanning, isVisible, playbackRequested, url]);

    useEffect(() => {
        if (isVisible && !isCanvasPanning) return;
        setIsPointerHovering(false);
        setTouchPlaybackRequested(false);
    }, [isCanvasPanning, isVisible]);

    useEffect(() => {
        setHasFrame(false);
    }, [url]);

    if (!node.metadata?.content)
        return (
            <div ref={videoNodeRef} className="grid h-full w-full place-items-center" style={{ color: theme.node.placeholder }}>
                <Play aria-hidden="true" className="size-10 fill-current opacity-30" strokeWidth={1.5} />
            </div>
        );
    // 视频画面按实际分辨率等比适配节点盒子，字幕叠加层与画面同框，不在黑边上错位。
    const sourceRatio = (mediaSize?.width || node.metadata?.naturalWidth || node.width) / Math.max(1, mediaSize?.height || node.metadata?.naturalHeight || node.height);
    const fitHeight = Math.min(node.height, node.width / Math.max(0.01, sourceRatio));
    const fitWidth = Math.round(fitHeight * sourceRatio);
    const activeEntry = subtitleEntries.find((entry) => currentTimeMs >= entry.startMs && currentTimeMs < entry.endMs);
    const activeHighlight = activeEntry ? (node.metadata?.subtitleHighlights || []).find((item) => item.entryIndex === activeEntry.index) : undefined;

    return (
        <div ref={videoNodeRef} {...previewInteractions} className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--node-radius)]" style={{ background: theme.node.fill }}>
            <div ref={playerBoxRef} className="absolute inset-0 flex items-center justify-center">
                {url ? (
                    <div className="relative" style={{ width: fitWidth, height: Math.round(fitHeight) }}>
                        <VideoPlayer
                            src={url}
                            mimeType={/\.m3u8(?:$|[?#])/i.test(url) ? "application/x-mpegurl" : node.metadata?.mimeType}
                            title={node.title || "视频"}
                            preload="metadata"
                            autoPlay={playbackRequested}
                            onLoadedData={() => { setHasFrame(true); captureVideoSize(); }}
                            brandColor={theme.accent.primary}
                            className="h-full w-full rounded-[var(--node-radius)] bg-black"
                            dataCanvasNoZoom
                            compactControls
                            onError={() => {
                                setHasFrame(false);
                                if (/\.m3u8(?:$|[?#])/i.test(url)) fallbackToOriginal();
                            }}
                        />
                        {activeEntry && activeEntry.text.trim() ? <CanvasSubtitleOverlay text={activeEntry.text} highlight={activeHighlight} style={subtitleStyle} /> : null}
                    </div>
                ) : null}
            </div>
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[var(--node-radius)]" style={{ opacity: !url || !hasFrame ? 1 : 0, visibility: !url || !hasFrame ? "visible" : "hidden", background: theme.node.fill }}>
                <CanvasVideoPreviewImage
                    node={node}
                    alt=""
                    eager={nearViewport || Boolean(url)}
                    className="block size-full object-contain"
                    fallback={<VideoPosterPlaceholder theme={theme} />}
                    loadingFallback={<VideoPosterPlaceholder theme={theme} loading />}
                />
            </div>
        </div>
    );
}

function VideoPosterPlaceholder({ theme, loading = false }: { theme: CanvasTheme; loading?: boolean }) {
    return (
        <div className="grid size-full place-items-center" style={{ color: theme.node.muted }} aria-label={loading ? "视频封面加载中" : "视频封面不可用"}>
            <span className="grid size-10 place-items-center rounded-full border" style={{ borderColor: `${theme.node.muted}55`, background: `${theme.node.muted}14` }}>
                {loading ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> : <Play aria-hidden="true" className="size-5 fill-current" />}
            </span>
        </div>
    );
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const playWhenReadyRef = useRef(false);
    const { url, loading, load } = useNodeResourceUrl(node, false);
    useEffect(() => {
        if (!url || !playWhenReadyRef.current) return;
        playWhenReadyRef.current = false;
        void audioRef.current?.play().catch(() => undefined);
    }, [url]);
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">空音频节点</span>
            </div>
        );
    if (!url) {
        return <DeferredMediaLoad icon={loading ? <LoaderCircle className="size-5 animate-spin" /> : <Play className="size-5 fill-current" />} label={loading ? "正在加载音频" : "加载音频"} disabled={loading} onClick={() => { playWhenReadyRef.current = true; void load(); }} />;
    }
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="min-w-0 truncate" title={node.title || "音频"}>{node.title || "音频"}</span>
            </div>
            <audio ref={audioRef} src={url} controls preload="metadata" className="w-full" data-canvas-no-zoom />
        </div>
    );
}

// 画布虚拟化会卸载屏外图片节点；只复用确认加载成功的资源地址。
const loadedCanvasImageUrls = new Map<string, string>();

function ImageContent({
    node,
    theme,
    isBatchRoot,
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    forceOriginalMedia = false,
}: {
    node: CanvasNodeData;
    theme: CanvasTheme;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    forceOriginalMedia?: boolean;
}) {
    const imageContainerRef = useRef<HTMLDivElement>(null);
    const nearViewport = useViewportIntersection(imageContainerRef, "320px");
    // Images keep the existing cached-blob path; direct OSS range playback is
    // only needed for videos.
    const thumbnailWidth = Math.min(1920, Math.max(320, Math.ceil(Math.max(node.width, node.height) * (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1))));
    const { url, loading, rememberLoadedResourceUrl, forgetLoadedResourceUrl } = useNodeResourceUrl(node, nearViewport, forceOriginalMedia, !forceOriginalMedia, thumbnailWidth);
    const [failedUrl, setFailedUrl] = useState("");
    const [retryNonce, setRetryNonce] = useState(0);
    useEffect(() => {
        setFailedUrl("");
    }, [url]);
    const imageSrc = url && failedUrl === url ? `${url}${url.includes("?") ? "&" : "?"}retry=${retryNonce}` : url;
    const { imageRef, revealPhase } = useImageReveal({
        identity: node.metadata?.storageKey || node.metadata?.content || node.id,
        src: imageSrc,
        enabled: Boolean(imageSrc && failedUrl !== url),
    });

    return (
        <BatchFrame batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} theme={theme} onToggleBatch={onToggleBatch}>
            <div ref={imageContainerRef} className="h-full w-full overflow-hidden rounded-[var(--node-radius)]">
                {imageSrc && failedUrl !== url ? (
                    <img
                        ref={imageRef}
                        data-image-reveal={revealPhase}
                        src={imageSrc}
                        alt={node.title}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                        onLoad={() => rememberLoadedResourceUrl(url)}
                        onError={() => { forgetLoadedResourceUrl(url); setFailedUrl(url); }}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                    />
                ) : loading && node.metadata?.storageKey ? (
                    <PersistentResourceImage src={node.metadata?.content || ""} storageKey={node.metadata.storageKey} thumbnail reveal alt={node.title} draggable={false} className={`pointer-events-none block size-full ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`} />
                ) : <div className="flex size-full flex-col items-center justify-center gap-2 px-3 text-center" style={{ color: theme.node.muted }}>
                    {loading ? <LoaderCircle className="size-5 animate-spin" /> : failedUrl === url && url ? <>
                        <AlertCircle className="size-5 text-red-400" />
                        <span className="text-[11px] leading-4">图片加载失败</span>
                        <button type="button" data-canvas-no-zoom className="inline-flex min-h-8 items-center gap-1 rounded border border-current/20 px-2 text-[11px] transition hover:bg-foreground/10" onClick={(event) => { event.stopPropagation(); setRetryNonce((value) => value + 1); setFailedUrl(""); }}>
                            <RefreshCw className="size-3" />重试加载
                        </button>
                    </> : <ImageIcon className="size-5 opacity-45" />}
                </div>}
            </div>
        </BatchFrame>
    );
}

function DeferredMediaLoad({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
    return (
        <button type="button" data-canvas-no-zoom className="flex size-full flex-col items-center justify-center gap-2 rounded-[var(--r-2xl)] bg-black text-white/75 transition hover:text-white disabled:cursor-wait" disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick(); }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <span className="grid size-10 place-items-center rounded-full bg-white/10">{icon}</span>
            <span className="text-xs font-medium">{label}</span>
        </button>
    );
}

function useNodeResourceUrl(node: CanvasNodeData, eager: boolean, preferDirect = false, preferThumbnail = false, thumbnailWidth = 640, preferPlayback = false, allowPlaybackOriginalFallback = false) {
    const userId = useUserStore((state) => state.user?.id || "guest");
    const storageKey = node.metadata?.storageKey || "";
    const fallback = node.metadata?.content || "";
    const resourceId = resourceIdFromStorageKey(storageKey);
    const isRemoteResource = Boolean(resourceId);
    const thumbnailUrl = preferThumbnail && resourceId ? resourceThumbnailUrl(resourceId, thumbnailWidth) : "";
    // Let video nodes use the signed OSS redirect so native byte-range
    // requests bypass the authenticated application proxy. Other media keeps
    // the stable proxy URL for normal browser caching.
    const directUrl = preferDirect && resourceId ? resourceFileUrl(resourceId, { direct: true }) : "";
    const playbackUrl = preferPlayback && resourceId ? playbackVariantUrl(resourceId) : "";
    const sourceKey = `${userId}:${storageKey || fallback}:${playbackUrl ? "playback" : preferDirect ? "direct" : preferThumbnail ? `thumbnail-${thumbnailWidth}` : "cached"}`;
    const cachedImageUrl = node.type === CanvasNodeType.Image && isRemoteResource && (directUrl || thumbnailUrl) ? loadedCanvasImageUrls.get(sourceKey) || "" : "";
    // 上传后的本地原图已经在会话缓存中，节点和放大视图都优先复用，不再请求缩略图或原图。
    const localImageUrl = node.type === CanvasNodeType.Image && isRemoteResource ? getCanvasUploadedImageUrl(storageKey) : "";
    const initialUrl = localImageUrl || (playbackUrl ? "" : directUrl ? (eager ? directUrl : cachedImageUrl) : thumbnailUrl ? (eager ? thumbnailUrl : cachedImageUrl) : isRemoteResource ? getLoadedResourceObjectUrl(storageKey) : fallback);
    const [resolved, setResolved] = useState({ key: sourceKey, url: initialUrl });
    const url = resolved.key === sourceKey ? resolved.url : initialUrl;
    const setUrl = useCallback((next: string) => setResolved({ key: sourceKey, url: next }), [sourceKey]);
    const rememberLoadedResourceUrl = useCallback((loadedUrl: string) => {
        if (node.type !== CanvasNodeType.Image || !isRemoteResource || !loadedUrl || (loadedUrl !== directUrl && loadedUrl !== thumbnailUrl)) return;
        loadedCanvasImageUrls.set(sourceKey, loadedUrl);
    }, [directUrl, isRemoteResource, node.type, sourceKey, thumbnailUrl]);
    const forgetLoadedResourceUrl = useCallback((failedUrl: string) => {
        if (loadedCanvasImageUrls.get(sourceKey) === failedUrl) loadedCanvasImageUrls.delete(sourceKey);
        if (localImageUrl && failedUrl === localImageUrl) {
            forgetCanvasUploadedImageUrl(storageKey);
            setUrl(directUrl || thumbnailUrl || fallback);
        }
    }, [directUrl, fallback, localImageUrl, setUrl, sourceKey, storageKey, thumbnailUrl]);
    const [loading, setLoading] = useState((Boolean(playbackUrl) || !directUrl) && isRemoteResource && eager);

    useEffect(() => {
        let cancelled = false;
        if (localImageUrl) {
            setUrl(localImageUrl);
            setLoading(false);
            return;
        }
        if (playbackUrl) {
            setUrl(eager ? "" : "");
            setLoading(eager);
            if (!eager || !resourceId) {
                return () => {
                    cancelled = true;
                };
            }
            let retryTimer: number | undefined;
            const resolvePlayback = async () => {
                try {
                    const status = await getResourcePlaybackStatus(resourceId);
                    if (cancelled) return;
                    if (status === "ready") {
                        setUrl(playbackUrl);
                    } else if (status === "failed") {
                        // A passive canvas preview must remain a poster while the
                        // lightweight rendition is unavailable. Only an explicit
                        // hover/touch playback request may fall back to the
                        // original file, preventing a hidden full-video download.
                        setUrl(allowPlaybackOriginalFallback ? directUrl || fallback : "");
                    } else {
                        setUrl("");
                        retryTimer = window.setTimeout(() => void resolvePlayback(), 2000);
                    }
                } catch {
                    if (!cancelled) setUrl(allowPlaybackOriginalFallback ? directUrl || fallback : "");
                } finally {
                    if (!cancelled) setLoading(false);
                }
            };
            void resolvePlayback();
            return () => {
                cancelled = true;
                if (retryTimer !== undefined) window.clearTimeout(retryTimer);
            };
        }
        if (directUrl) {
            // 只在接近视口或用户点击时交给播放器，避免离屏视频抢占图片加载带宽。
            setUrl(eager ? directUrl : cachedImageUrl);
            setLoading(false);
            return () => {
                cancelled = true;
            };
        }
        if (thumbnailUrl) {
            setUrl(eager ? thumbnailUrl : cachedImageUrl);
            setLoading(false);
            return () => {
                cancelled = true;
            };
        }
        if (!isRemoteResource) {
            setUrl(fallback);
            setLoading(false);
            return;
        }
        // 同一资源从缓存检查转为进入视口时保留已显示的 URL，避免图片反复卸载/解码。
        setLoading(eager);
        const resolve = eager ? cacheResourceObjectUrl(storageKey) : getCachedResourceObjectUrl(storageKey);
        void resolve
            .then((cached) => {
                if (!cancelled) setUrl(cached || (eager ? fallback : ""));
            })
            .catch(() => {
                if (!cancelled && eager) setUrl(fallback);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [allowPlaybackOriginalFallback, cachedImageUrl, directUrl, eager, fallback, isRemoteResource, localImageUrl, playbackUrl, resourceId, storageKey, thumbnailUrl, setUrl]);

    const load = useCallback(async () => {
        if (url) return url;
        if (directUrl) { setUrl(directUrl); return directUrl; }
        if (thumbnailUrl) { setUrl(thumbnailUrl); return thumbnailUrl; }
        if (!isRemoteResource) return fallback;
        setLoading(true);
        try {
            const next = (await cacheResourceObjectUrl(storageKey)) || fallback;
            setUrl(next);
            return next;
        } catch {
            setUrl(fallback);
            return fallback;
        } finally {
            setLoading(false);
        }
    }, [directUrl, fallback, isRemoteResource, storageKey, thumbnailUrl, url, setUrl]);

    const fallbackToOriginal = useCallback(() => {
        if (directUrl) setUrl(directUrl);
    }, [directUrl, setUrl]);

    return { url, loading, load, fallbackToOriginal, rememberLoadedResourceUrl, forgetLoadedResourceUrl };
}

function useViewportIntersection(ref: React.RefObject<Element | null>, rootMargin = "0px") {
    const [nearViewport, setNearViewport] = useState(false);

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            const isIntersecting = entries.some((entry) => entry.isIntersecting);
            if (!isIntersecting) element.querySelector<HTMLVideoElement>("video")?.pause();
            setNearViewport(isIntersecting);
        }, { rootMargin });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref, rootMargin]);

    return nearViewport;
}

const canvasVideoPreloadSlots = new Set<string>();
const canvasVideoPreloadRequests = new Map<string, { priority: boolean; order: number }>();
const canvasVideoPreloadListeners = new Set<() => void>();
let canvasVideoPreloadOrder = 0;
const CANVAS_VIDEO_PRELOAD_LIMIT = 4;

function notifyCanvasVideoPreloadListeners() {
    canvasVideoPreloadListeners.forEach((listener) => listener());
}

function reconcileCanvasVideoPreloadSlots() {
    const next = Array.from(canvasVideoPreloadRequests.entries())
        .sort(([, a], [, b]) => Number(b.priority) - Number(a.priority) || a.order - b.order)
        .slice(0, CANVAS_VIDEO_PRELOAD_LIMIT)
        .map(([id]) => id);
    const changed = next.length !== canvasVideoPreloadSlots.size || next.some((id) => !canvasVideoPreloadSlots.has(id));
    canvasVideoPreloadSlots.clear();
    next.forEach((id) => canvasVideoPreloadSlots.add(id));
    if (changed) notifyCanvasVideoPreloadListeners();
}

function useCanvasVideoPreloadSlot(id: string, requested: boolean, priority: boolean) {
    const [granted, setGranted] = useState(false);

    useEffect(() => {
        if (!requested) {
            canvasVideoPreloadRequests.delete(id);
            reconcileCanvasVideoPreloadSlots();
            setGranted(false);
            return;
        }
        canvasVideoPreloadRequests.set(id, { priority, order: ++canvasVideoPreloadOrder });
        const update = () => setGranted(canvasVideoPreloadSlots.has(id));
        canvasVideoPreloadListeners.add(update);
        reconcileCanvasVideoPreloadSlots();
        update();
        return () => {
            canvasVideoPreloadListeners.delete(update);
            canvasVideoPreloadRequests.delete(id);
            reconcileCanvasVideoPreloadSlots();
        };
    }, [id, priority, requested]);

    return granted;
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <span className="ml-auto max-w-full shrink-0 truncate rounded-md bg-black/55 px-2 py-1 text-[var(--fs-label)] font-medium leading-none text-white backdrop-blur-sm">
            {width} x {height}
            {size ? ` · ${size}` : ""}
        </span>
    );
}

function BatchFrame({ batchCount, batchExpanded, batchOpening, batchRecovering, theme, onToggleBatch, children }: { batchCount: number; batchExpanded: boolean; batchOpening: boolean; batchRecovering: boolean; theme: CanvasTheme; onToggleBatch?: () => void; children: ReactNode }) {
    const isBatchRoot = batchCount > 1;
    return (
        <div
            className="group/batch relative h-full w-full overflow-visible"
            onDoubleClick={
                isBatchRoot
                    ? (event) => {
                          event.stopPropagation();
                          onToggleBatch?.();
                      }
                    : undefined
            }
        >
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 5) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_14px_34px_rgba(68,64,60,.16)] transition-all duration-300 group-hover/batch:translate-x-2"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded && !batchOpening ? 0.34 : 1,
                                transform:
                                    batchOpening || batchRecovering ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)` : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-[var(--node-z-handle)] size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

// Liblib 式远景浏览仍保留节点名称，低于 20% 才隐藏以避免标题互相覆盖。
const NODE_EXTERNAL_HEADER_MIN_SCALE = 0.2;

function NodeExternalHeader({ node, scale, active, editable, editing, draft, theme, onDraftChange, onEdit, onCommit, onCancel }: {
    node: CanvasNodeData;
    scale: number;
    active: boolean;
    editable: boolean;
    editing: boolean;
    draft: string;
    theme: CanvasTheme;
    onDraftChange: (value: string) => void;
    onEdit: () => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    // 标题保持屏幕尺寸只适用于近景；远景继续反向缩放会遮住节点和连线。
    if (scale < NODE_EXTERNAL_HEADER_MIN_SCALE && !editing) return null;
    const inverseScale = 1 / Math.max(scale, 0.05);
    const isDirectorNode = Boolean(node.metadata?.directorSceneId || node.metadata?.previsSceneId);
    const Icon = isDirectorNode ? Move3d : nodeTypeIcon(node.type);
    const maxHeaderWidth = Math.min(240, node.width * scale);

    return (
        <div
            className="canvas-node-external-header absolute bottom-full left-0 z-[var(--node-z-overlay)] flex h-7 items-center gap-1.5 overflow-hidden"
            style={{ maxWidth: maxHeaderWidth, color: active ? theme.node.text : theme.node.label, transform: `scale(var(--canvas-live-inverse-scale, ${inverseScale}))`, transformOrigin: "left bottom" }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <Icon aria-hidden="true" className={`size-4 shrink-0 ${node.type === CanvasNodeType.Video && !isDirectorNode ? "fill-current" : ""}`} strokeWidth={1.8} />
            {editing ? (
                <input
                    autoFocus
                    value={draft}
                    className="h-7 min-w-20 max-w-[190px] flex-1 truncate rounded border bg-transparent px-1.5 text-sm font-medium outline-none"
                    style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 10px 28px ${theme.spatial.shadow}, inset 0 1px 0 rgba(255,255,255,.06)` }}
                    onChange={(event) => onDraftChange(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={onCommit}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") onCancel();
                    }}
                    aria-label="节点名称"
                />
            ) : editable ? (
                <button type="button" className="group flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-sm font-medium outline-none transition-opacity hover:opacity-100 focus-visible:ring-1" style={{ opacity: active ? 1 : 0.78, "--tw-ring-color": theme.node.activeStroke } as React.CSSProperties} onClick={onEdit} aria-label={`编辑节点名称：${node.title}`}>
                    <span className="min-w-0 flex-1 truncate" title={node.title}>{node.title}</span>
                    <Pencil aria-hidden="true" className="size-3 shrink-0 opacity-55 transition-opacity group-hover:opacity-100" />
                </button>
            ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={node.title} style={{ opacity: active ? 1 : 0.78 }}>{node.title}</span>
            )}
        </div>
    );
}

function nodeTypeIcon(type: CanvasNodeType) {
    if (type === CanvasNodeType.Image) return ImageIcon;
    if (type === CanvasNodeType.Video) return Play;
    if (type === CanvasNodeType.Audio) return Music2;
    if (type === CanvasNodeType.Drawing) return Pencil;
    if (type === CanvasNodeType.Script) return Clapperboard;
    if (type === CanvasNodeType.Config) return Settings2;
    if (type === CanvasNodeType.Skill) return BookOpenCheck;
    return Type;
}

// 节点状态徽章（对应 #97 决策2：左上角状态指示，loading/success/error）
function NodeStatusBadge({ status }: { status: "loading" | "success" | "error" }) {
    if (status === "loading") {
        return (
            <div
                className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 backdrop-blur-sm"
                style={{ background: "color-mix(in oklch, var(--status-loading) 20%, transparent)", color: "var(--status-loading)" }}
                aria-label="生成中"
            >
                <span className="size-1.5 animate-pulse rounded-full" style={{ background: "var(--status-loading)" }} />
                <span className="text-[var(--fs-micro)] font-medium leading-none">生成中</span>
            </div>
        );
    }
    if (status === "error") {
        return (
            <div
                className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 backdrop-blur-sm"
                style={{ background: "color-mix(in oklch, var(--status-error) 20%, transparent)", color: "var(--status-error)" }}
                aria-label="生成失败"
            >
                <AlertCircle className="size-3" strokeWidth={2} />
                <span className="text-[var(--fs-micro)] font-medium leading-none">失败</span>
            </div>
        );
    }
    // success：短暂闪现后淡出（由 CSS animation 控制，2s 后消失）
    return (
        <div
            className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 backdrop-blur-sm"
            style={{ background: "color-mix(in oklch, var(--status-success) 20%, transparent)", color: "var(--status-success)", animation: "canvas-status-success-fade 2s ease-out forwards" }}
            aria-label="生成完成"
        >
            <CheckCircle2 className="size-3" strokeWidth={2} />
            <span className="text-[var(--fs-micro)] font-medium leading-none">完成</span>
        </div>
    );
}

function ConnectionSideRail({ side, scale, visible, theme, onPointerDown }: { side: "left" | "right"; scale: number; visible: boolean; theme: CanvasTheme; onPointerDown: (event: React.PointerEvent, anchorRatio: number) => void }) {
    const inverseScale = 1 / Math.max(scale, 0.05);

    return (
        <button
            type="button"
            className={`group absolute top-1/2 z-[var(--node-z-overlay)] touch-none -translate-y-1/2 outline-none transition-opacity duration-150 ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            style={{ width: 56 * inverseScale, height: `min(100%, ${72 * inverseScale}px)`, ...(side === "left" ? { right: "100%" } : { left: "100%" }) }}
            onPointerDown={(event) => onPointerDown(event, 0.5)}
            aria-label={`${side === "left" ? "输入" : "输出"}连接点，单击创建节点或拖动连线`}
        >
            <span
                className="absolute grid -translate-y-1/2 place-items-center rounded-full border transition-[background-color,box-shadow] duration-150 group-hover:brightness-125 group-focus-visible:brightness-125"
                style={{
                    top: "50%",
                    width: 18 * inverseScale,
                    height: 18 * inverseScale,
                    ...(side === "left" ? { right: 6 * inverseScale } : { left: 6 * inverseScale }),
                    borderWidth: inverseScale,
                    background: theme.spatial.elevated,
                    borderColor: theme.node.activeStroke,
                    color: theme.node.activeStroke,
                    boxShadow: `0 4px 12px ${theme.spatial.shadow}`,
                }}
            >
                <Plus style={{ width: 10 * inverseScale, height: 10 * inverseScale }} strokeWidth={2} />
            </span>
        </button>
    );
}
