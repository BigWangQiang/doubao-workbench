import { useLayoutEffect, useRef, type RefObject } from "react";
import { Group, Leafer, Path, Rect } from "leafer-ui";

import { activeConnectionPath, canvasConnectionPath } from "@/components/canvas/canvas-connections";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasSelectionPreview } from "@/lib/canvas/canvas-live-viewport";
import { calculateCanvasPreviewTransform, sameCanvasViewport, shouldRebaseCanvasRaster } from "@/lib/canvas/canvas-leafer-viewport";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasDisplayConnection, CanvasNodeData, ConnectionHandle, Position, SelectionBox, ViewportTransform } from "@/types/canvas";

type NodeBounds = { left: number; top: number; width: number; height: number; count: number } | null;

type CanvasLeaferGraphicsLayerProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    theme: CanvasTheme;
    displayConnections: CanvasDisplayConnection[];
    selectedConnectionId: string | null;
    relatedConnectionIds: Set<string>;
    scriptScrollTopById: Record<string, number>;
    connectingParams: ConnectionHandle | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    connectionTargetAnchorRatio?: number;
    nodeById: Map<string, CanvasNodeData>;
    selectionBox: SelectionBox | null;
    selectedNodeBounds: NodeBounds;
    alignmentGuides: { vertical?: number; horizontal?: number };
};

type LeaferScene = {
    leafer: Leafer;
    world: Group;
    host: HTMLDivElement;
};

type UnderlayScene = LeaferScene & {
    connections: Group;
};

type OverlayScene = LeaferScene & {
    selection: Rect;
    selectionBounds: Rect;
    guides: Path;
    draft: Path;
};

export function CanvasLeaferGraphicsLayer(props: CanvasLeaferGraphicsLayerProps) {
    const underlayHostRef = useRef<HTMLDivElement>(null);
    const overlayHostRef = useRef<HTMLDivElement>(null);
    const underlayRef = useRef<UnderlayScene | null>(null);
    const overlayRef = useRef<OverlayScene | null>(null);
    const viewportRef = useRef(props.viewport);
    const rasterViewportRef = useRef(props.viewport);
    const sizeRef = useRef({ width: 1, height: 1 });
    const propsRef = useRef(props);
    propsRef.current = props;

    useLayoutEffect(() => {
        const underlayHost = underlayHostRef.current;
        const overlayHost = overlayHostRef.current;
        // 子组件 layout effect 可能早于父层 ref 对外可见，host 的直接父元素才是此刻最可靠的画布容器。
        const container = (props.containerRef.current || underlayHost?.parentElement) as HTMLDivElement | null;
        if (!underlayHost || !overlayHost || !container) return;

        const underlay = createUnderlayScene(underlayHost);
        const overlay = createOverlayScene(overlayHost);
        underlayRef.current = underlay;
        overlayRef.current = overlay;

        const resize = () => {
            const rect = container.getBoundingClientRect();
            const size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), pixelRatio: canvasPixelRatio() };
            sizeRef.current = size;
            underlay.leafer.resize(size);
            overlay.leafer.resize(size);
            // backing store 尺寸变化后按实时视口重绘，不能继续复用旧尺寸的预览变换。
            syncViewport(viewportRef.current, size.width, size.height, underlay, overlay, propsRef.current);
            rasterViewportRef.current = viewportRef.current;
            forceSceneRender(underlay, overlay);
            resetScenePreview(underlay, overlay);
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        window.addEventListener("resize", resize);
        const unsubscribe = subscribeCanvasGraphicsViewportPreview(container, (next) => {
            viewportRef.current = next;
            const rect = sizeRef.current;
            if (isViewportPreview(container, next, rasterViewportRef.current)) {
                if (shouldRebaseCanvasRaster(next, rasterViewportRef.current, rect)) {
                    syncViewport(next, rect.width, rect.height, underlay, overlay, propsRef.current);
                    rasterViewportRef.current = next;
                    forceSceneRender(underlay, overlay);
                    resetScenePreview(underlay, overlay);
                    return;
                }
                applyScenePreview(next, rasterViewportRef.current, underlay, overlay);
                return;
            }
            if (!sameCanvasViewport(next, rasterViewportRef.current)) {
                syncViewport(next, rect.width, rect.height, underlay, overlay, propsRef.current);
                rasterViewportRef.current = next;
                // 松手或程序定位时也先完成绘制，再清除旧预览，防止短暂回跳。
                forceSceneRender(underlay, overlay);
            }
            resetScenePreview(underlay, overlay);
        });
        const unsubscribeSelection = subscribeCanvasSelectionPreview(container, (selection) => {
            syncSelection(overlay.selection, selection, propsRef.current.theme);
        });
        resize();

        return () => {
            unsubscribe();
            unsubscribeSelection();
            resizeObserver.disconnect();
            window.removeEventListener("resize", resize);
            underlay.leafer.destroy(true);
            overlay.leafer.destroy(true);
            underlayRef.current = null;
            overlayRef.current = null;
        };
    }, [props.containerRef]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        if (!underlay) return;
        rebuildConnections(underlay, props);
    }, [props.displayConnections, props.relatedConnectionIds, props.scriptScrollTopById, props.selectedConnectionId, props.theme]);

    useLayoutEffect(() => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        syncOverlayContent(overlay, props, viewportRef.current.k);
    }, [props.connectingParams, props.connectionTargetAnchorRatio, props.connectionTargetNodeId, props.mouseWorld, props.nodeById, props.scriptScrollTopById, props.selectedNodeBounds, props.selectionBox, props.theme]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!underlay || !overlay || !container) return;
        viewportRef.current = props.viewport;
        const rect = sizeRef.current;
        const hadPreview = hasScenePreview(underlay, overlay);
        if (hadPreview || !sameCanvasViewport(props.viewport, rasterViewportRef.current)) {
            syncViewport(props.viewport, rect.width, rect.height, underlay, overlay, props);
        }
        rasterViewportRef.current = props.viewport;
        // 新视口先同步到真实 DPR backing store，再撤销交互期的合成变换，避免出现跳帧。
        if (hadPreview) forceSceneRender(underlay, overlay);
        resetScenePreview(underlay, overlay);
    }, [props.containerRef, props.viewport]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!underlay || !overlay || !container) return;
        const rect = sizeRef.current;
        syncViewport(rasterViewportRef.current, rect.width, rect.height, underlay, overlay, props);
        if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
            applyScenePreview(viewportRef.current, rasterViewportRef.current, underlay, overlay);
        }
    }, [props.alignmentGuides, props.containerRef, props.theme]);

    return (
        <>
            <div ref={underlayHostRef} data-canvas-leafer-underlay className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden />
            <div ref={overlayHostRef} data-canvas-leafer-overlay className="pointer-events-none absolute inset-0 z-[var(--z-canvas-overlay)] overflow-hidden" aria-hidden />
        </>
    );
}

function createUnderlayScene(host: HTMLDivElement): UnderlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const connections = new Group({ hittable: false });
    world.add(connections);
    leafer.add(world);
    return { leafer, world, host, connections };
}

function createOverlayScene(host: HTMLDivElement): OverlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const selection = new Rect({ visible: false, hittable: false });
    const selectionBounds = new Rect({ visible: false, hittable: false, fill: "transparent" });
    const guides = new Path({ visible: false, hittable: false });
    const draft = new Path({ visible: false, hittable: false });
    world.add(selection);
    world.add(selectionBounds);
    world.add(guides);
    world.add(draft);
    leafer.add(world);
    return { leafer, world, host, selection, selectionBounds, guides, draft };
}

function rebuildConnections(scene: UnderlayScene, props: CanvasLeaferGraphicsLayerProps) {
    scene.connections.removeAll(true);
    props.displayConnections.forEach(({ connection, from, to }) => {
        const path = new Path({
            path: canvasConnectionPath(connection, from, to, props.scriptScrollTopById[from.id] || 0, props.scriptScrollTopById[to.id] || 0).pathD,
            // 基础线始终保持中性灰；选中/关联态只由 SVG 上层的短流动条表达，
            // 不把整条连接染成高亮色，避免多条线交叉时视觉成团。
            stroke: props.theme.connection.stroke,
            strokeWidth: 1,
            strokeScaleFixed: true,
            strokeCap: "round",
            opacity: 0.72,
            hittable: false,
        });
        scene.connections.add(path);
    });
}

function syncOverlayContent(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const selection = props.selectionBox;
    scene.selection.visible = Boolean(selection);
    if (selection) {
        syncSelection(scene.selection, selection, props.theme);
    }

    const bounds = props.selectedNodeBounds;
    scene.selectionBounds.visible = Boolean(bounds && !selection);
    if (bounds && !selection) {
        syncSelectionBounds(scene.selectionBounds, bounds, viewportScale);
        scene.selectionBounds.set({ stroke: props.theme.canvas.selectionStroke, fill: props.theme.canvas.selectionFill });
    }

    const connecting = props.connectingParams;
    scene.draft.visible = Boolean(connecting);
    if (connecting) {
        scene.draft.set({
            path: activeConnectionPath(
                props.nodeById.get(connecting.nodeId),
                connecting,
                props.mouseWorld,
                props.connectionTargetNodeId ? props.nodeById.get(props.connectionTargetNodeId) : undefined,
                props.scriptScrollTopById[connecting.nodeId] || 0,
                props.connectionTargetAnchorRatio,
            ),
            stroke: props.theme.connection.flow,
            strokeCap: "round",
            opacity: 0.72,
        });
    }
}

function syncSelection(rect: Rect, selection: SelectionBox, theme: CanvasTheme) {
    rect.set({
        x: Math.min(selection.startWorldX, selection.currentWorldX),
        y: Math.min(selection.startWorldY, selection.currentWorldY),
        width: Math.abs(selection.currentWorldX - selection.startWorldX),
        height: Math.abs(selection.currentWorldY - selection.startWorldY),
        fill: theme.canvas.selectionFill,
        stroke: theme.canvas.selectionStroke,
    });
}

function syncViewport(viewport: ViewportTransform, width: number, height: number, underlay: UnderlayScene, overlay: OverlayScene, props: CanvasLeaferGraphicsLayerProps) {
    const scale = Math.max(viewport.k, 0.05);
    for (const scene of [underlay, overlay]) scene.world.set({ x: viewport.x, y: viewport.y, scaleX: scale, scaleY: scale });

    overlay.selection.strokeWidth = 1 / scale;
    overlay.selection.cornerRadius = 8 / scale;
    overlay.selection.dashPattern = [2 / scale, 3 / scale];
    if (props.selectedNodeBounds) syncSelectionBounds(overlay.selectionBounds, props.selectedNodeBounds, scale);
    overlay.selectionBounds.set({ strokeWidth: 1 / scale, cornerRadius: 10 / scale, dashPattern: [2 / scale, 3 / scale] });
    overlay.draft.set({ strokeWidth: 1.4 / scale, dashPattern: [8 / scale, 8 / scale] });
    overlay.guides.set({
        visible: typeof props.alignmentGuides.vertical === "number" || typeof props.alignmentGuides.horizontal === "number",
        path: guidePath(viewport, width, height, props.alignmentGuides),
        stroke: props.theme.accent.primary,
        strokeWidth: 1 / scale,
        dashPattern: [5 / scale, 5 / scale],
        opacity: 0.72,
    });
}

function isViewportPreview(container: HTMLDivElement, viewport: ViewportTransform, rasterViewport: ViewportTransform) {
    return container.dataset.canvasViewportInteracting === "true" && !sameCanvasViewport(viewport, rasterViewport);
}

function applyScenePreview(viewport: ViewportTransform, rasterViewport: ViewportTransform, ...scenes: LeaferScene[]) {
    // 将已栅格画面的屏幕坐标映射到实时视口，缩放手势期间不触碰 Leafer 场景树。
    const { ratio, x, y } = calculateCanvasPreviewTransform(viewport, rasterViewport);
    for (const scene of scenes) {
        scene.host.style.transformOrigin = "0 0";
        scene.host.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
        scene.host.style.willChange = "transform";
        scene.host.dataset.canvasLeaferPreview = "true";
    }
}

function hasScenePreview(...scenes: LeaferScene[]) {
    return scenes.some((scene) => scene.host.dataset.canvasLeaferPreview === "true");
}

function resetScenePreview(...scenes: LeaferScene[]) {
    for (const scene of scenes) {
        scene.host.style.transform = "";
        scene.host.style.transformOrigin = "";
        scene.host.style.willChange = "";
        delete scene.host.dataset.canvasLeaferPreview;
    }
}

function forceSceneRender(...scenes: LeaferScene[]) {
    for (const scene of scenes) scene.leafer.forceRender(undefined, true);
}

function syncSelectionBounds(rect: Rect, bounds: NonNullable<NodeBounds>, viewportScale: number) {
    const padding = 12 / Math.max(viewportScale, 0.05);
    rect.set({
        x: bounds.left - padding,
        y: bounds.top - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
    });
}

function guidePath(viewport: ViewportTransform, width: number, height: number, guides: { vertical?: number; horizontal?: number }) {
    const scale = Math.max(viewport.k, 0.05);
    const left = -viewport.x / scale;
    const top = -viewport.y / scale;
    const right = left + width / scale;
    const bottom = top + height / scale;
    const commands: string[] = [];
    if (typeof guides.vertical === "number") commands.push(`M ${guides.vertical} ${top} L ${guides.vertical} ${bottom}`);
    if (typeof guides.horizontal === "number") commands.push(`M ${left} ${guides.horizontal} L ${right} ${guides.horizontal}`);
    return commands.join(" ");
}

function canvasPixelRatio() {
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}
