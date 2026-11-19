import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Clapperboard, FilePenLine, Image as ImageIcon, List, Music2, Pencil, Video, WandSparkles } from "lucide-react";

import { CanvasCreateMenu, type CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { canvasThemes } from "@/lib/canvas-theme";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { subscribeCanvasViewportPreview } from "@/lib/canvas/canvas-live-viewport";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle, type Position, type ViewportTransform } from "@/types/canvas";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
    quick?: boolean;
};

export function CanvasSelectionToolbar({ anchorRef, containerRef, count, children }: { anchorRef: RefObject<HTMLDivElement | null>; containerRef: RefObject<HTMLDivElement | null>; count: number; children: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const reducedMotion = useReducedMotion();
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [anchor, setAnchor] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);

    useLayoutEffect(() => {
        const element = anchorRef.current;
        const container = containerRef.current;
        if (!element || !container) {
            setAnchor(null);
            return;
        }

        const update = () => {
            const bounds = element.getBoundingClientRect();
            const containerBounds = container.getBoundingClientRect();
            const toolbarWidth = toolbarRef.current?.offsetWidth || 320;
            const toolbarHeight = toolbarRef.current?.offsetHeight || 38;
            const halfWidth = Math.min(toolbarWidth / 2, Math.max(0, containerBounds.width / 2 - 12));
            const center = bounds.left - containerBounds.left + bounds.width / 2;
            const left = Math.min(Math.max(center, 12 + halfWidth), Math.max(12 + halfWidth, containerBounds.width - 12 - halfWidth));
            const boundsTop = bounds.top - containerBounds.top;
            const boundsBottom = bounds.bottom - containerBounds.top;
            const placement = boundsTop - toolbarHeight - 8 >= 68 ? "above" : "below";
            const top = placement === "above" ? boundsTop - 8 : Math.min(boundsBottom + 8, containerBounds.height - toolbarHeight - 12);
            if (toolbarRef.current) {
                toolbarRef.current.style.left = `${left}px`;
                toolbarRef.current.style.top = `${top}px`;
                toolbarRef.current.classList.toggle("-translate-y-full", placement === "above");
                return;
            }
            setAnchor((current) => current?.left === left && current.top === top && current.placement === placement ? current : { left, top, placement });
        };

        update();
        const resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(element);
        resizeObserver.observe(container);
        if (toolbarRef.current) resizeObserver.observe(toolbarRef.current);
        const viewportLayer = element.parentElement;
        const mutationObserver = new MutationObserver(update);
        if (viewportLayer) mutationObserver.observe(viewportLayer, { attributes: true, attributeFilter: ["style"] });
        const unsubscribeViewport = subscribeCanvasViewportPreview(container, update);
        window.addEventListener("resize", update);
        return () => {
            resizeObserver.disconnect();
            mutationObserver.disconnect();
            unsubscribeViewport();
            window.removeEventListener("resize", update);
        };
    }, [anchorRef, containerRef, count]);

    if (!anchor) return null;
    return (
        <div
            ref={toolbarRef}
            data-canvas-no-zoom
            className={`absolute z-[var(--z-panel-floating)] max-w-[calc(100%_-_24px)] -translate-x-1/2 ${anchor.placement === "above" ? "-translate-y-full" : ""}`}
            style={{ left: anchor.left, top: anchor.top, color: theme.node.text, transformOrigin: anchor.placement === "above" ? "bottom center" : "top center" }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reducedMotion ? 0 : 0.15 }} className="canvas-selection-toolbar-content">
                {children}
            </motion.div>
        </div>
    );
}

export function CanvasNodePanelOverlay({ node, viewport, containerRef, panelWidth = 520, panelHeight = 420, placement = "auto", children }: { node: CanvasNodeData; viewport: ViewportTransform; containerRef: RefObject<HTMLDivElement | null>; panelWidth?: number; panelHeight?: number; placement?: "auto" | "below"; children: ReactNode }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const initialPosition = getNodePanelPosition(node, viewport, { width: containerRef.current?.clientWidth || 0, height: containerRef.current?.clientHeight || 0 }, panelWidth, panelHeight, placement);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const panel = panelRef.current;
        if (!container || !panel) return;
        const update = (nextViewport: ViewportTransform) => {
            const position = getNodePanelPosition(node, nextViewport, { width: container.clientWidth, height: container.clientHeight }, panel.offsetWidth || panelWidth, panel.offsetHeight || panelHeight, placement);
            panel.style.left = `${position.left}px`;
            panel.style.top = `${position.top}px`;
            panel.style.maxHeight = `${position.maxHeight}px`;
        };
        update(viewport);
        const resizeObserver = new ResizeObserver(() => update(viewport));
        resizeObserver.observe(container);
        resizeObserver.observe(panel);
        const unsubscribeViewport = subscribeCanvasViewportPreview(container, update);
        return () => {
            resizeObserver.disconnect();
            unsubscribeViewport();
        };
    }, [containerRef, node.height, node.id, node.position.x, node.position.y, node.width, panelHeight, panelWidth, placement, viewport]);

    return (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            className="thin-scrollbar absolute z-[var(--z-modal-overlay)] max-w-[calc(100%_-_24px)] overflow-y-auto"
            style={{ left: initialPosition.left, top: initialPosition.top, width: panelWidth, maxHeight: initialPosition.maxHeight }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {children}
        </div>
    );
}

export function CanvasConnectionCreateMenu({ pending, viewport, viewportSize, containerRef, canCreateDrawing, onCreate, onOpenViralVideo, onOpenScreenplay, onClose }: { pending: PendingConnectionCreate; viewport: ViewportTransform; viewportSize: { width: number; height: number }; containerRef: RefObject<HTMLDivElement | null>; canCreateDrawing: boolean; onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Script | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Drawing) => void; onOpenViralVideo: () => void; onOpenScreenplay: () => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const reducedMotion = useReducedMotion();
    const menuRef = useRef<HTMLDivElement>(null);
    const menuWidth = 264;
    const menuHeight = (canCreateDrawing ? 8 : 7) * 44 + 60;
    const gap = 12;
    const initialPosition = getConnectionMenuPosition(pending.position, viewport, viewportSize, menuWidth, menuHeight, gap);
    const commands: CanvasCreateCommand[] = [
        { id: "text", label: "文本生成", icon: <List />, section: "node", onClick: () => onCreate(CanvasNodeType.Text) },
        { id: "screenplay", label: "写剧本", icon: <FilePenLine />, section: "node", onClick: onOpenScreenplay },
        { id: "script", label: "分镜脚本", icon: <Clapperboard />, section: "node", onClick: () => onCreate(CanvasNodeType.Script) },
        { id: "image", label: "图片生成", icon: <ImageIcon />, section: "node", onClick: () => onCreate(CanvasNodeType.Image) },
        ...(canCreateDrawing ? [{ id: "drawing", label: "绘图", icon: <Pencil />, section: "node" as const, onClick: () => onCreate(CanvasNodeType.Drawing) }] : []),
        { id: "video", label: "视频生成", icon: <Video />, section: "node", onClick: () => onCreate(CanvasNodeType.Video) },
        { id: "viral-video", label: "复刻爆款", icon: <WandSparkles />, badge: "NEW", badgeTone: "new", section: "node", onClick: onOpenViralVideo },
        { id: "audio", label: "音频参考", icon: <Music2 />, section: "node", onClick: () => onCreate(CanvasNodeType.Audio) },
    ];

    useLayoutEffect(() => {
        const container = containerRef.current;
        const menu = menuRef.current;
        if (!container || !menu) return;
        const update = (nextViewport: ViewportTransform) => {
            const containerBounds = container.getBoundingClientRect();
            const position = getConnectionMenuPosition(pending.position, nextViewport, { width: containerBounds.width, height: containerBounds.height }, menu.offsetWidth || menuWidth, menu.offsetHeight || menuHeight, gap);
            menu.style.left = `${position.left}px`;
            menu.style.top = `${position.top}px`;
        };
        update(viewport);
        // 搜索和新增菜单项都会改变实际高度，不能只按旧版固定尺寸避让。
        const observer = new ResizeObserver(() => update(viewport));
        observer.observe(menu);
        observer.observe(container);
        const unsubscribe = subscribeCanvasViewportPreview(container, update);
        return () => { observer.disconnect(); unsubscribe(); };
    }, [containerRef, pending.position, viewport, viewportSize.height, viewportSize.width]);

    return (
        <motion.div
            ref={menuRef}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
            className="canvas-command-panel canvas-command-connection"
            data-canvas-no-zoom
            data-connection-create-menu
            style={{ left: initialPosition.left, top: initialPosition.top, "--canvas-command-bg": theme.toolbar.panel, "--canvas-command-border": theme.toolbar.border, "--canvas-command-text": theme.node.text, "--canvas-command-muted": theme.node.muted, "--canvas-command-hover": theme.toolbar.itemHover, "--canvas-command-active": theme.toolbar.activeBg } as CSSProperties}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
        >
            <CanvasCreateMenu title="创建下一步" commands={commands} onClose={onClose} />
        </motion.div>
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function getConnectionMenuPosition(position: Position, viewport: ViewportTransform, viewportSize: { width: number; height: number }, menuWidth: number, menuHeight: number, gap: number) {
    const screenX = viewport.x + position.x * viewport.k;
    const screenY = viewport.y + position.y * viewport.k;
    return {
        left: clamp(screenX, gap, Math.max(gap, viewportSize.width - menuWidth - gap)),
        top: clamp(screenY, 72, Math.max(72, viewportSize.height - menuHeight - gap)),
    };
}

function getNodePanelPosition(node: CanvasNodeData, viewport: ViewportTransform, viewportSize: { width: number; height: number }, panelWidth: number, panelHeight: number, placement: "auto" | "below") {
    const gap = 10;
    const margin = 12;
    const topBoundary = 72;
    const nodeCenterX = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const nodeTop = viewport.y + node.position.y * viewport.k;
    const nodeBottom = viewport.y + (node.position.y + node.height) * viewport.k;
    const maxLeft = Math.max(margin, viewportSize.width - panelWidth - margin);
    const left = clamp(nodeCenterX - panelWidth / 2, margin, maxLeft);
    const belowTop = nodeBottom + gap;
    const aboveTop = nodeTop - panelHeight - gap;
    // 生成输入框必须始终跟在节点下方；空间不足时由面板自身滚动，不再跳到图片上方。
    const preferredTop = placement === "below" || belowTop + panelHeight <= viewportSize.height - margin ? belowTop : aboveTop;
    const top = placement === "below"
        ? Math.max(topBoundary, belowTop)
        : clamp(preferredTop, topBoundary, Math.max(topBoundary, viewportSize.height - panelHeight - margin));
    return {
        left,
        top,
        maxHeight: placement === "below"
            ? Math.max(120, viewportSize.height - top - margin)
            : Math.max(120, Math.min(panelHeight, viewportSize.height - top - margin)),
    };
}
