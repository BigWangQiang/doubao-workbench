import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { CANVAS_OVERLAY_SELECTOR, isCanvasOverlayTarget } from "@/lib/canvas/canvas-interaction-boundary";
import { applyCanvasLiveViewport, subscribeCanvasViewportPreview } from "@/lib/canvas/canvas-live-viewport";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

export const CanvasPanningContext = React.createContext(false);

function pauseCanvasVideos(container: HTMLElement) {
    container.querySelectorAll<HTMLVideoElement>("video").forEach((video) => video.pause());
}

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onViewportPreviewChange?: (viewport: ViewportTransform) => void;
    /** 在媒体节点上使用 Ctrl/Meta + 滚轮缩放时，通知页面优先加载该节点原始资源。 */
    onZoomTargetNode?: (nodeId: string) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    boxSelectEnabled?: boolean;
    panOverNodes?: boolean;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    onFileDragEnter?: (event: React.DragEvent<HTMLDivElement>) => void;
    onFileDragLeave?: (event: React.DragEvent<HTMLDivElement>) => void;
    onFileDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
    graphicsLayer?: React.ReactNode;
};

const CANVAS_WHEEL_IGNORE_SELECTOR = `[data-canvas-no-zoom],[data-canvas-wheel-scroll],${CANVAS_OVERLAY_SELECTOR}`;
const WHEEL_ZOOM_DELTA = 72;

type TouchPoint = { x: number; y: number };

type PinchState = {
    active: boolean;
    pointerIds: [number, number];
    initialDistance: number;
    worldX: number;
    worldY: number;
    initialScale: number;
};

export function InfiniteCanvas({ containerRef, viewport, backgroundMode = "blank", onViewportChange, onViewportPreviewChange, onZoomTargetNode, onCanvasMouseDown, boxSelectEnabled = false, panOverNodes = false, onCanvasDoubleClick, onCanvasDeselect, onContextMenu, onDrop, onFileDragEnter, onFileDragLeave, onFileDragOver, graphicsLayer, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
    });
    const viewportRef = useRef(viewport);
    const scaleRef = useRef(viewport.k);
    const containerRectRef = useRef<DOMRect | null>(null);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastPreviewNotifyRef = useRef(0);
    const interactingRef = useRef(false);
    const touchPointsRef = useRef(new Map<number, TouchPoint>());
    const pinchStateRef = useRef<PinchState>({ active: false, pointerIds: [-1, -1], initialDistance: 1, worldX: 0, worldY: 0, initialScale: viewport.k });
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useLayoutEffect(() => {
        if (interactingRef.current) return;
        viewportRef.current = viewport;
        scaleRef.current = viewport.k;
        applyCanvasLiveViewport(containerRef.current, viewport);
    }, [containerRef, viewport]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        return subscribeCanvasViewportPreview(container, (next) => {
            viewportRef.current = next;
            scaleRef.current = next.k;
        });
    }, [containerRef]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            delete containerRef.current?.dataset.canvasViewportInteracting;
        },
        [containerRef],
    );

    const syncViewport = useCallback(() => onViewportChange(viewportRef.current), [onViewportChange]);

    const scheduleViewportChange = useCallback(
        (next: ViewportTransform, commitAfterIdle = false) => {
            viewportRef.current = next;
            scaleRef.current = next.k;
            onViewportPreviewChange?.(next);
            const container = containerRef.current;
            if (container) container.dataset.canvasViewportInteracting = "true";
            nextViewportRef.current = next;
            // 每个滚轮事件都延后提交，不能被同一帧已有的 RAF 提前跳过。
            if (commitAfterIdle) {
                if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
                syncTimerRef.current = setTimeout(() => {
                    interactingRef.current = false;
                    delete containerRef.current?.dataset.canvasViewportInteracting;
                    syncViewport();
                    syncTimerRef.current = null;
                }, 120);
            }
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame((now) => {
                frameRef.current = null;
                const pending = nextViewportRef.current;
                if (!pending) return;
                const notify = now - lastPreviewNotifyRef.current >= 32;
                applyCanvasLiveViewport(containerRef.current, pending, notify);
                if (notify) lastPreviewNotifyRef.current = now;
            });
        },
        [containerRef, onViewportPreviewChange, syncViewport],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(`input,textarea,select,[contenteditable="true"],${CANVAS_WHEEL_IGNORE_SELECTOR}`)) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") setIsSpacePressed(false);
        };
        const handleBlur = () => setIsSpacePressed(false);

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    const handleWheel = useCallback(
        (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            const deltaX = wheelDeltaToPixels(event.deltaX, event.deltaMode);
            const deltaY = wheelDeltaToPixels(event.deltaY, event.deltaMode);
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            const wantsZoom = event.ctrlKey || event.metaKey;
            const ignoredTarget = target?.closest(CANVAS_WHEEL_IGNORE_SELECTOR);
            const isVideoSurfaceZoom = wantsZoom && Boolean(target?.closest(".canvas-video-player")) && !target?.closest(".vds-controls,.vds-menu-items");
            if (ignoredTarget && !isVideoSurfaceZoom) {
                // 工具栏、弹窗和节点内部滚动区不应把滚轮手势变成画布缩放。
                // Ctrl/Meta 也在这些区域被拦截，避免浏览器页面缩放或浮层误缩放。
                if (wantsZoom || event.shiftKey || absX > absY) event.preventDefault();
                return;
            }

            event.preventDefault();
            interactingRef.current = true;
            const current = viewportRef.current;
            if (!wantsZoom) {
                // 统一规则：普通鼠标滚轮和触控板双指滚动都只平移画布。
                // Ctrl/Meta 是唯一的滚轮缩放入口，不再猜测设备类型或 delta 大小。
                const panX = event.shiftKey ? (absX > 0 ? deltaX : deltaY) : deltaX;
                const panY = event.shiftKey && absX === 0 ? 0 : deltaY;
                scheduleViewportChange({ x: current.x - panX, y: current.y - panY, k: current.k }, true);
                return;
            }

            const rect = containerRectRef.current || containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const mouseX = event.clientX - rect.left;
            const mouseY = event.clientY - rect.top;
            const factor = Math.pow(1.1, -deltaY / WHEEL_ZOOM_DELTA);
            const newScale = clampScale(current.k * factor);
            const worldX = (mouseX - current.x) / current.k;
            const worldY = (mouseY - current.y) / current.k;
            // 只在实际放大且指针落在节点上时切换原图；缩小或在空白区缩放
            // 不会触发额外的大文件下载。
            if (newScale > current.k) {
                const zoomTargetNodeId = target?.closest("[data-node-id]")?.getAttribute("data-node-id");
                if (zoomTargetNodeId) onZoomTargetNode?.(zoomTargetNodeId);
            }

            scheduleViewportChange({
                x: mouseX - worldX * newScale,
                y: mouseY - worldY * newScale,
                k: newScale,
            }, true);
        },
        [containerRef, onZoomTargetNode, scheduleViewportChange],
    );

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (isCanvasOverlayTarget(target, event.currentTarget)) return;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const isNodeClickInHandMode = panOverNodes && !isBackgroundClick && event.pointerType !== "touch" && event.button === 0;
        const isTouch = event.pointerType === "touch";

        const hasSelectionModifier = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;
        if (event.button === 0 && !isSpacePressed && !isTouch && isBackgroundClick && (hasSelectionModifier || boxSelectEnabled)) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
            return;
        }

        if (isTouch) {
            touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (touchPointsRef.current.size >= 2) {
                const [[firstId, first], [secondId, second]] = Array.from(touchPointsRef.current.entries());
                event.preventDefault();
                event.currentTarget.setPointerCapture(firstId);
                event.currentTarget.setPointerCapture(secondId);
                const rect = containerRectRef.current || event.currentTarget.getBoundingClientRect();
                const current = viewportRef.current;
                const centerX = (first.x + second.x) / 2 - rect.left;
                const centerY = (first.y + second.y) / 2 - rect.top;
                pinchStateRef.current = {
                    active: true,
                    pointerIds: [firstId, secondId],
                    initialDistance: Math.max(Math.hypot(second.x - first.x, second.y - first.y), 1),
                    worldX: (centerX - current.x) / current.k,
                    worldY: (centerY - current.y) / current.k,
                    initialScale: current.k,
                };
                panState.current.isPanning = false;
                interactingRef.current = true;
                return;
            }

            if (!isBackgroundClick) return;
            pauseCanvasVideos(event.currentTarget);
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            if (!event.isPrimary) return;
            const current = viewportRef.current;
            interactingRef.current = true;
            panState.current = {
                isPanning: true,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                initialX: current.x,
                initialY: current.y,
                hasMoved: false,
            };
            setIsPanning(true);
            return;
        }

        if ((isBackgroundClick || panOverNodes || isSpacePressed || event.button === 1) && (event.button === 1 || event.button === 0)) {
            const current = viewportRef.current;
            pauseCanvasVideos(event.currentTarget);
            // 抓手模式下节点仍然负责保留 click/double-click 语义（双击聚焦、打开原图）。
            // 这里不能在第一次按下时 preventDefault 或抢走 pointer capture，
            // 否则 Chromium 会把双击序列取消，节点只能平移而无法触发聚焦。
            if (!isNodeClickInHandMode) {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
            }
            interactingRef.current = true;
            panState.current = {
                isPanning: true,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                initialX: current.x,
                initialY: current.y,
                hasMoved: false,
            };
            setIsPanning(true);
        }

    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
                touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                const pinch = pinchStateRef.current;
                if (pinch.active) {
                    const first = touchPointsRef.current.get(pinch.pointerIds[0]);
                    const second = touchPointsRef.current.get(pinch.pointerIds[1]);
                    const rect = containerRectRef.current || containerRef.current?.getBoundingClientRect();
                    if (!first || !second || !rect) return;
                    event.preventDefault();
                    const centerX = (first.x + second.x) / 2 - rect.left;
                    const centerY = (first.y + second.y) / 2 - rect.top;
                    const distance = Math.max(Math.hypot(second.x - first.x, second.y - first.y), 1);
                    const scale = clampScale(pinch.initialScale * (distance / pinch.initialDistance));
                    if (scale > viewportRef.current.k) {
                        const target = document.elementFromPoint(centerX + rect.left, centerY + rect.top);
                        const zoomTargetNodeId = target instanceof Element ? target.closest("[data-node-id]")?.getAttribute("data-node-id") : null;
                        if (zoomTargetNodeId) onZoomTargetNode?.(zoomTargetNodeId);
                    }
                    scheduleViewportChange({
                        x: centerX - pinch.worldX * scale,
                        y: centerY - pinch.worldY * scale,
                        k: scale,
                    });
                    return;
                }
            }

            if (!panState.current.isPanning || panState.current.pointerId !== event.pointerId) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            scheduleViewportChange({
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            });
        };

        const handlePointerEnd = (event: PointerEvent) => {
            if (event.pointerType === "touch" && pinchStateRef.current.active && pinchStateRef.current.pointerIds.includes(event.pointerId)) {
                pinchStateRef.current.active = false;
                touchPointsRef.current.clear();
                panState.current.isPanning = false;
                panState.current.pointerId = -1;
                interactingRef.current = false;
                if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
                delete containerRef.current?.dataset.canvasViewportInteracting;
                syncViewport();
                setIsPanning(false);
                return;
            }

            if (event.pointerType === "touch") touchPointsRef.current.delete(event.pointerId);
            if (!panState.current.isPanning || panState.current.pointerId !== event.pointerId) return;

            if (event.type === "pointerup" && !panState.current.hasMoved) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            panState.current.pointerId = -1;
            interactingRef.current = false;
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            delete containerRef.current?.dataset.canvasViewportInteracting;
            syncViewport();
            setIsPanning(false);
        };

        const handleBlur = () => {
            if (!panState.current.isPanning && !pinchStateRef.current.active) return;
            panState.current.isPanning = false;
            panState.current.pointerId = -1;
            pinchStateRef.current.active = false;
            touchPointsRef.current.clear();
            interactingRef.current = false;
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            delete containerRef.current?.dataset.canvasViewportInteracting;
            syncViewport();
            setIsPanning(false);
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerEnd);
        window.addEventListener("pointercancel", handlePointerEnd);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerEnd);
            window.removeEventListener("pointercancel", handlePointerEnd);
            window.removeEventListener("blur", handleBlur);
        };
    }, [containerRef, onCanvasDeselect, onZoomTargetNode, scheduleViewportChange, syncViewport]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const updateRect = () => {
            containerRectRef.current = container.getBoundingClientRect();
        };
        updateRect();
        const observer = new ResizeObserver(updateRect);
        observer.observe(container);
        window.addEventListener("resize", updateRect);
        container.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updateRect);
            container.removeEventListener("wheel", handleWheel, { capture: true });
        };
    }, [containerRef, handleWheel]);

    return (
        <CanvasPanningContext.Provider value={isPanning}>
        <div
            ref={containerRef}
            data-canvas-cursor={isPanning ? "grabbing" : boxSelectEnabled && !isSpacePressed ? "default" : "grab"}
            className="canvas-interaction-surface relative h-full w-full select-none overflow-hidden touch-none"
            style={{
                background: theme.canvas.background,
                overscrollBehavior: "none",
                "--canvas-committed-scale": viewport.k,
            } as React.CSSProperties}
            onPointerDown={handlePointerDown}
            onPointerDownCapture={(event) => {
                if (event.pointerType === "touch" || (!panOverNodes && !isSpacePressed && event.button !== 1)) return;
                handlePointerDown(event);
                // 抓手先于节点拖拽取得指针，preventDefault 同时阻止兼容 mousedown。
                if (event.defaultPrevented) event.stopPropagation();
            }}
            onDoubleClick={(event) => {
                const target = event.target instanceof Element ? event.target : null;
                if (!target?.closest("[data-node-id],[data-connection-id],[data-canvas-no-zoom]")) onCanvasDoubleClick?.(event);
            }}
            onContextMenu={onContextMenu}
            onDragEnter={onFileDragEnter}
            onDragLeave={onFileDragLeave}
            onDragOver={(event) => {
                event.preventDefault();
                onFileDragOver?.(event);
            }}
            onDrop={onDrop}
        >
            <CanvasGrid mode={backgroundMode} viewport={viewport} />
            {graphicsLayer}
            <div
                data-canvas-world-layer
                className="canvas-world-layer absolute origin-top-left"
                style={{ transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(1)` }}
            >
                <div data-canvas-world-raster-layer className="canvas-world-raster-layer absolute origin-top-left">
                    {children}
                </div>
            </div>
        </div>
        </CanvasPanningContext.Provider>
    );
}

function CanvasGrid({ mode, viewport }: { mode: CanvasBackgroundMode; viewport: ViewportTransform }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const backgroundImage = mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} var(--canvas-dot-size), transparent calc(var(--canvas-dot-size) + 0.2px))` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;
    if (mode === "blank") return null;

    return (
        <div
            data-canvas-grid-layer
            className="pointer-events-none absolute"
            style={{
                inset: "calc(-1 * var(--canvas-grid-size))",
                backgroundImage,
                backgroundSize: "var(--canvas-grid-size) var(--canvas-grid-size)",
                transform: `translate3d(${viewport.x % (48 * viewport.k)}px, ${viewport.y % (48 * viewport.k)}px, 0)`,
                "--canvas-grid-size": `${48 * viewport.k}px`,
                "--canvas-dot-size": viewport.k < 0.12 ? "0.8px" : "1.15px",
                opacity: mode === "dots" ? 0.52 : 0.36,
                willChange: "transform",
            } as React.CSSProperties}
        />
    );
}

function wheelDeltaToPixels(delta: number, deltaMode: number) {
    if (deltaMode === 1) return delta * 16;
    if (deltaMode === 2) return delta * 720;
    return delta;
}

function clampScale(scale: number) {
    return Math.min(Math.max(scale, 0.05), 2);
}
