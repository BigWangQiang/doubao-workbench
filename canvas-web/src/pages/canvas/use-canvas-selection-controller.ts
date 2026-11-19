import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";

import { applyCanvasSelectionPreview } from "@/lib/canvas/canvas-live-viewport";
import { isCanvasOverlayTarget } from "@/lib/canvas/canvas-interaction-boundary";
import { calculateNodeAlignment, createNodeAlignmentContext, isHiddenBatchChild, sameStringSet, type NodeAlignmentContext } from "@/lib/canvas/canvas-project-domain";
import { applyFrameDrop, findFrameDropTarget, getFrameChildIds, isFrameNode, isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import type { CanvasNodeData, CanvasToolMode, Position, SelectionBox, ViewportTransform } from "@/types/canvas";

type UseCanvasSelectionControllerOptions = {
    containerRef: RefObject<HTMLDivElement | null>;
    nodesRef: { current: CanvasNodeData[] };
    viewportRef: { current: ViewportTransform };
    selectedNodeIdsRef: { current: Set<string> };
    historyPausedRef: { current: boolean };
    screenToCanvas: (clientX: number, clientY: number) => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    cancelPendingConnectionCreate: () => void;
    onCanvasSelectionStart: () => void;
    onNodeInteractionStart: (selectionModifier: boolean) => void;
    onNodeClick: (node: CanvasNodeData) => void;
    onDeselect: () => void;
    onSelectionBoxEnd?: () => void;
    canvasTool: CanvasToolMode;
};

type DragState = {
    isDraggingNode: boolean;
    hasMoved: boolean;
    openPanelOnClick: boolean;
    startX: number;
    startY: number;
    anchorNodeId: string | null;
    anchorGrabOffset: Position;
    draggedNodeIds: string[];
    initialSelectedNodes: Array<{ id: string; x: number; y: number }>;
};

const EMPTY_DRAG_STATE: DragState = {
    isDraggingNode: false,
    hasMoved: false,
    openPanelOnClick: true,
    startX: 0,
    startY: 0,
    anchorNodeId: null,
    anchorGrabOffset: { x: 0, y: 0 },
    draggedNodeIds: [],
    initialSelectedNodes: [],
};

export function useCanvasSelectionController({
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
    onCanvasSelectionStart,
    onNodeInteractionStart,
    onNodeClick,
    onDeselect,
    onSelectionBoxEnd,
    canvasTool,
}: UseCanvasSelectionControllerOptions) {
    const dragFrameRef = useRef<number | null>(null);
    const pendingNodeDragRef = useRef<Position>({ x: 0, y: 0 });
    const pendingAlignmentGuidesRef = useRef<{ vertical?: number; horizontal?: number }>({});
    const alignmentContextRef = useRef<NodeAlignmentContext | null>(null);
    const lastAlignedOffsetRef = useRef<Position | null>(null);
    const lastAlignedResultRef = useRef<{ offset: Position; guides: { vertical?: number; horizontal?: number } } | null>(null);
    const frameDropCandidatesRef = useRef<CanvasNodeData[]>([]);
    const lastFrameDropCheckRef = useRef(0);
    const selectionFrameRef = useRef<number | null>(null);
    const selectionBoundsElementRef = useRef<HTMLDivElement>(null);
    const selectionCandidatesRef = useRef<Array<{ id: string; left: number; top: number; right: number; bottom: number }>>([]);
    const pendingSelectionPointRef = useRef<Position | null>(null);
    const selectionActivatedRef = useRef(false);
    const selectionBoxRef = useRef<SelectionBox | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<DragState>({ ...EMPTY_DRAG_STATE });
    const liveDragElementsRef = useRef<Array<{ element: HTMLElement; x: number; y: number }>>([]);
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [frameDropTargetId, setFrameDropTargetId] = useState<string | null>(null);
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [dragPreview, setDragPreview] = useState<{ x: number; y: number; nodeIds: Set<string> } | null>(null);
    const [alignmentGuides, setAlignmentGuides] = useState<{ vertical?: number; horizontal?: number }>({});

    const applyLiveNodeDrag = useCallback((offset: Position) => {
        liveDragElementsRef.current.forEach(({ element, x, y }) => {
            if (!element.isConnected) return;
            // 只写独立 translate，不覆盖 React 根据节点 position 维护的 transform。
            // 否则任意一次状态重绘都会把拖动中的节点复位，或在视口裁剪时被卸载。
            void x;
            void y;
            element.style.translate = `${offset.x}px ${offset.y}px`;
        });
    }, []);

    const clearLiveNodeDrag = useCallback(() => {
        const elements = liveDragElementsRef.current;
        const clear = () => {
            elements.forEach(({ element }) => {
                if (element.isConnected) element.style.removeProperty("translate");
            });
            if (liveDragElementsRef.current === elements) liveDragElementsRef.current = [];
        };
        clear();
    }, []);

    const cancelSelectionBox = useCallback(() => {
        selectionBoxRef.current = null;
        selectionCandidatesRef.current = [];
        pendingSelectionPointRef.current = null;
        selectionActivatedRef.current = false;
        if (selectionFrameRef.current) cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
        setSelectionBox(null);
    }, []);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        cancelSelectionBox();
        const emptySelection = new Set<string>();
        selectedNodeIdsRef.current = emptySelection;
        setSelectedNodeIds(emptySelection);
        setSelectedConnectionId(null);
        onDeselect();
    }, [cancelPendingConnectionCreate, cancelSelectionBox, onDeselect, selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds]);

    const handleCanvasMouseDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        cancelPendingConnectionCreate();
        onCanvasSelectionStart();
        if (event.button !== 0) return;
        const world = screenToCanvas(event.clientX, event.clientY);
        const subtractive = event.altKey;
        const additive = !subtractive && (event.shiftKey || event.ctrlKey || event.metaKey);
        const nextSelectionBox: SelectionBox = {
            startWorldX: world.x,
            startWorldY: world.y,
            currentWorldX: world.x,
            currentWorldY: world.y,
            additive,
            subtractive,
            initialSelectedNodeIds: additive || subtractive ? Array.from(selectedNodeIdsRef.current) : [],
        };
        selectionBoxRef.current = nextSelectionBox;
        selectionActivatedRef.current = false;
        selectionCandidatesRef.current = nodesRef.current
            .filter((node) => !isHiddenBatchChild(node, nodesRef.current) && !isNodeHiddenByCollapsedFrame(node, nodesRef.current))
            .map((node) => ({ id: node.id, left: node.position.x, top: node.position.y, right: node.position.x + node.width, bottom: node.position.y + node.height }));
        setSelectedConnectionId(null);
    }, [cancelPendingConnectionCreate, nodesRef, onCanvasSelectionStart, screenToCanvas, selectedNodeIdsRef, setSelectedConnectionId]);

    const handleNodeMouseDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
        const target = event.target instanceof Element ? event.target : null;
        if (isCanvasOverlayTarget(target, event.currentTarget)) return;
        event.stopPropagation();
        if (event.button !== 0) return;
        // 节点内的编辑器、按钮和连接手柄保留各自的指针行为，不启动节点拖动。
        // 视频画面本身是节点拖动面，播放器控制条和菜单仍由播放器处理。
        const isVideoSurface = Boolean(target?.closest(".canvas-video-player")) && !target?.closest(".vds-controls,.vds-menu-items");
        if (target?.closest("button,input,textarea,select,[data-canvas-no-zoom]") && !isVideoSurface) return;
        // 抓手模式由 InfiniteCanvas 在捕获阶段接管平移；这里再做一次防护，
        // 避免节点内部事件在浏览器兼容路径中意外改变选中态或打开编辑面板。
        if (canvasTool === "move") return;
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // 指针已被浏览器取消时，窗口级 pointercancel/blur 仍会负责清理状态。
        }
        setSelectedConnectionId(null);
        const currentNodes = nodesRef.current;
        const nextSelected = new Set(selectedNodeIdsRef.current);
        const isSubtractClick = event.altKey;
        const isMultiSelectClick = !isSubtractClick && (event.shiftKey || event.metaKey || event.ctrlKey);
        const isSelectionModifier = isSubtractClick || isMultiSelectClick;
        onNodeInteractionStart(isSelectionModifier);

        if (isSubtractClick) nextSelected.delete(nodeId);
        else if (isMultiSelectClick) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }

        selectedNodeIdsRef.current = nextSelected;
        setSelectedNodeIds(nextSelected);
        if (isSelectionModifier && !nextSelected.has(nodeId)) {
            dragRef.current = { ...EMPTY_DRAG_STATE, openPanelOnClick: false };
            return;
        }

        const clickedNode = currentNodes.find((node) => node.id === nodeId);
        if (clickedNode?.metadata?.locked) {
            dragRef.current = { ...EMPTY_DRAG_STATE };
            onNodeClick(clickedNode);
            return;
        }

        const draggedNodeIds = currentNodes.filter((node) => nextSelected.has(node.id) && !node.metadata?.locked && !(node.parentId && nextSelected.has(node.parentId))).map((node) => node.id);
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (nextSelected.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
            if (nextSelected.has(node.id) && isFrameNode(node)) getFrameChildIds(node.id, currentNodes).forEach((childId) => dragIds.add(childId));
        });
        currentNodes.forEach((node) => {
            if (dragIds.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
        });
        const initialSelectedNodes = currentNodes.filter((node) => dragIds.has(node.id) && !node.metadata?.locked).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y }));
        if (!initialSelectedNodes.length) return;

        const pointerWorld = screenToCanvas(event.clientX, event.clientY);
        const anchor = initialSelectedNodes.find((node) => node.id === nodeId) || initialSelectedNodes[0];
        // 记录鼠标按下点相对锚点左上角的画布坐标。拖动时先把锚点放回
        // “指针位置 - 抓取偏移”，节点就会从用户抓住的位置跟手移动，而不是吸附到鼠标位置。
        const anchorGrabOffset = { x: pointerWorld.x - anchor.x, y: pointerWorld.y - anchor.y };
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            openPanelOnClick: !isMultiSelectClick,
            startX: event.clientX,
            startY: event.clientY,
            anchorNodeId: anchor.id,
            anchorGrabOffset,
            draggedNodeIds,
            initialSelectedNodes,
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        pendingNodeDragRef.current = { x: 0, y: 0 };
        alignmentContextRef.current = createNodeAlignmentContext(currentNodes, initialSelectedNodes);
        lastAlignedOffsetRef.current = null;
        lastAlignedResultRef.current = null;
        lastFrameDropCheckRef.current = 0;
        const draggedIdSet = new Set(initialSelectedNodes.map((item) => item.id));
        frameDropCandidatesRef.current = currentNodes.filter((node) => isFrameNode(node) && !draggedIdSet.has(node.id));
        liveDragElementsRef.current = Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") || [])
            .flatMap((element) => {
                const nodeId = element.dataset.nodeId;
                const initial = nodeId && draggedIdSet.has(nodeId) ? initialSelectedNodes.find((item) => item.id === nodeId) : undefined;
                return initial ? [{ element, x: initial.x, y: initial.y }] : [];
            });
        setIsNodeDragging(true);
        setAlignmentGuides({});
        setDragPreview({ x: 0, y: 0, nodeIds: new Set(initialSelectedNodes.map((item) => item.id)) });
    }, [canvasTool, containerRef, historyPausedRef, nodesRef, onNodeClick, onNodeInteractionStart, screenToCanvas, selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds]);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (dragFrameRef.current) {
            cancelAnimationFrame(dragFrameRef.current);
            dragFrameRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;
        const shouldOpenPanelOnClick = dragRef.current.openPanelOnClick;
        const wasClick = shouldOpenPanelOnClick && !dragRef.current.hasMoved && dragRef.current.draggedNodeIds.length === 1;
        const clickedNodeId = dragRef.current.draggedNodeIds[0];
        const currentViewport = viewportRef.current;
        const dragState = dragRef.current;
        const anchorInitial = dragState.initialSelectedNodes.find((node) => node.id === dragState.anchorNodeId) || dragState.initialSelectedNodes[0];
        const pointerWorld = clientX != null && clientY != null && anchorInitial ? screenToCanvas(clientX, clientY) : null;
        const rawOffset = pointerWorld && anchorInitial
            ? {
                x: pointerWorld.x - dragState.anchorGrabOffset.x - anchorInitial.x,
                y: pointerWorld.y - dragState.anchorGrabOffset.y - anchorInitial.y,
            }
            : { x: 0, y: 0 };
        const initialPositions = dragRef.current.initialSelectedNodes;
        const initialById = new Map(initialPositions.map((item) => [item.id, item]));
        const { x: dx, y: dy } = calculateNodeAlignment(alignmentContextRef.current, rawOffset, 7 / currentViewport.k).offset;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setAlignmentGuides({});
        const committed = dragRef.current.hasMoved && clientX != null && clientY != null;
        if (committed) {
            applyLiveNodeDrag({ x: dx, y: dy });
            const draggedNodeIds = new Set(dragRef.current.draggedNodeIds);
            setNodes((currentNodes) => {
                const positioned = currentNodes.map((node) => {
                    const initial = initialById.get(node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                return applyFrameDrop(positioned, draggedNodeIds, findFrameDropTarget(positioned, draggedNodeIds));
            });
            // React 状态提交和临时 DOM 偏移必须在同一事件内完成，避免
            // “新位置 + 旧 translate”叠加一帧导致节点松手时闪烁。
            clearLiveNodeDrag();
        } else {
            clearLiveNodeDrag();
        }
        setDragPreview(null);
        setFrameDropTargetId(null);
        alignmentContextRef.current = null;
        frameDropCandidatesRef.current = [];
        lastAlignedOffsetRef.current = null;
        lastAlignedResultRef.current = null;
        dragRef.current = { ...EMPTY_DRAG_STATE };
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode) onNodeClick(clickedNode);
        }
    }, [applyLiveNodeDrag, clearLiveNodeDrag, historyPausedRef, nodesRef, onNodeClick, screenToCanvas, setNodes, viewportRef]);

    const scheduleNodeDrag = useCallback((clientX: number, clientY: number) => {
        if (!dragRef.current.isDraggingNode) return;
        const pointerWorld = screenToCanvas(clientX, clientY);
        const dragState = dragRef.current;
        const anchorInitial = dragState.initialSelectedNodes.find((node) => node.id === dragState.anchorNodeId) || dragState.initialSelectedNodes[0];
        if (!anchorInitial) return;
        const nextAnchorPosition = { x: pointerWorld.x - dragState.anchorGrabOffset.x, y: pointerWorld.y - dragState.anchorGrabOffset.y };
        pendingNodeDragRef.current = { x: nextAnchorPosition.x - anchorInitial.x, y: nextAnchorPosition.y - anchorInitial.y };
        if (Math.abs(clientX - dragState.startX) > 6 || Math.abs(clientY - dragState.startY) > 6) dragState.hasMoved = true;
        if (dragFrameRef.current) return;
        dragFrameRef.current = requestAnimationFrame(() => {
            const pending = pendingNodeDragRef.current;
            const previous = lastAlignedOffsetRef.current;
            const cached = lastAlignedResultRef.current;
            const aligned = previous && cached && Math.hypot(pending.x - previous.x, pending.y - previous.y) < 1
                ? cached
                : calculateNodeAlignment(alignmentContextRef.current, pending, 7 / viewportRef.current.k);
            if (aligned !== cached) {
                lastAlignedOffsetRef.current = pending;
                lastAlignedResultRef.current = aligned;
            }
            const latest = aligned.offset;
            applyLiveNodeDrag(latest);
            // 节点本体通过 DOM translate 跟手移动；这里同步同一份偏移给
            // 连线渲染层，保证连线端点和节点在同一帧更新，不依赖提交后的节点状态。
            setDragPreview({
                x: latest.x,
                y: latest.y,
                nodeIds: new Set(dragRef.current.initialSelectedNodes.map((item) => item.id)),
            });
            pendingAlignmentGuidesRef.current = aligned.guides;
            const initialById = new Map(dragRef.current.initialSelectedNodes.map((item) => [item.id, item]));
            const now = performance.now();
            if (now - lastFrameDropCheckRef.current >= 100) {
                lastFrameDropCheckRef.current = now;
                const draggedNodeIds = new Set(dragRef.current.draggedNodeIds);
                const movingNodes = nodesRef.current.filter((node) => draggedNodeIds.has(node.id));
                const positioned = [...frameDropCandidatesRef.current, ...movingNodes].map((node) => {
                    const initial = initialById.get(node.id);
                    return initial ? { ...node, position: { x: initial.x + latest.x, y: initial.y + latest.y } } : node;
                });
                setFrameDropTargetId(findFrameDropTarget(positioned, draggedNodeIds));
            }
            const nextGuides = dragRef.current.hasMoved ? pendingAlignmentGuidesRef.current : {};
            setAlignmentGuides((current) => current.vertical === nextGuides.vertical && current.horizontal === nextGuides.horizontal ? current : nextGuides);
            dragFrameRef.current = null;
        });
    }, [applyLiveNodeDrag, nodesRef, screenToCanvas, viewportRef]);

    const handlePointerMove = useCallback((event: PointerEvent) => {
        if (dragRef.current.isDraggingNode) {
            event.preventDefault();
            scheduleNodeDrag(event.clientX, event.clientY);
            return;
        }
        const currentSelection = selectionBoxRef.current;
        if (!currentSelection) return;
        if (event.buttons === 0) {
            cancelSelectionBox();
            return;
        }
        pendingSelectionPointRef.current = screenToCanvas(event.clientX, event.clientY);
        if (selectionFrameRef.current) return;
        selectionFrameRef.current = requestAnimationFrame(() => {
            selectionFrameRef.current = null;
            let selection = selectionBoxRef.current;
            const world = pendingSelectionPointRef.current;
            if (!selection || !world) return;
            if (!selectionActivatedRef.current) {
                const threshold = 4 / viewportRef.current.k;
                if (Math.hypot(world.x - selection.startWorldX, world.y - selection.startWorldY) < threshold) return;
                selectionActivatedRef.current = true;
                selection = { ...selection, currentWorldX: world.x, currentWorldY: world.y };
                selectionBoxRef.current = selection;
                setSelectionBox(selection);
                if (!selection.additive) {
                    const emptySelection = new Set<string>();
                    selectedNodeIdsRef.current = emptySelection;
                    setSelectedNodeIds(emptySelection);
                }
            }
            const rectX = Math.min(selection.startWorldX, world.x);
            const rectY = Math.min(selection.startWorldY, world.y);
            const rectW = Math.abs(world.x - selection.startWorldX);
            const rectH = Math.abs(world.y - selection.startWorldY);
            selection = { ...selection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = selection;
            applyCanvasSelectionPreview(containerRef.current, selection);
            const nextSelected = new Set<string>(selection.additive || selection.subtractive ? selection.initialSelectedNodeIds : []);
            selectionCandidatesRef.current.forEach((node) => {
                if (rectX >= node.right || rectX + rectW <= node.left || rectY >= node.bottom || rectY + rectH <= node.top) return;
                if (selection.subtractive) nextSelected.delete(node.id);
                else nextSelected.add(node.id);
            });
            if (sameStringSet(nextSelected, selectedNodeIdsRef.current)) return;
            selectedNodeIdsRef.current = nextSelected;
            setSelectedNodeIds(nextSelected);
        });
    }, [cancelSelectionBox, containerRef, scheduleNodeDrag, screenToCanvas, selectedNodeIdsRef, setSelectedNodeIds, viewportRef]);

    const finishSelection = useCallback(() => {
        const hadPendingSelection = Boolean(selectionBoxRef.current);
        const wasSelection = selectionActivatedRef.current;
        cancelSelectionBox();
        if (hadPendingSelection && !wasSelection) deselectCanvas();
        if (hadPendingSelection) onSelectionBoxEnd?.();
    }, [cancelSelectionBox, deselectCanvas, onSelectionBoxEnd]);

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            finishSelection();
        };
        const cancel = () => {
            finishNodeDrag();
            finishSelection();
        };
        window.addEventListener("pointermove", handlePointerMove, { passive: false });
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        return () => {
            if (dragFrameRef.current) cancelAnimationFrame(dragFrameRef.current);
            if (selectionFrameRef.current) cancelAnimationFrame(selectionFrameRef.current);
            clearLiveNodeDrag();
            // removeEventListener 只按 capture 匹配监听器，使用布尔值避免
            // TypeScript 将 PointerEvent 回调误判为 Worker 事件重载。
            window.removeEventListener("pointermove", handlePointerMove, false);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", cancel);
        };
    }, [clearLiveNodeDrag, finishNodeDrag, finishSelection, handlePointerMove]);

    return {
        alignmentGuides,
        cancelSelectionBox,
        deselectCanvas,
        dragPreview,
        frameDropTargetId,
        handleCanvasMouseDown,
        handleNodeMouseDown,
        isNodeDragging,
        nodeDraggingRef,
        selectionBoundsElementRef,
        selectionBox,
    };
}
