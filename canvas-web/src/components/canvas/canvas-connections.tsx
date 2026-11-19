import React, { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Scissors } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT, storyboardTableHeight } from "@/components/canvas/canvas-script-node";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

export const ConnectionPath = React.memo(function ConnectionPath({
    connection,
    from,
    to,
    fromScrollTop = 0,
    toScrollTop = 0,
    active,
    selected,
    visualMode = "full",
    onSelect,
    onDelete,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    fromScrollTop?: number;
    toScrollTop?: number;
    active: boolean;
    selected?: boolean;
    visualMode?: "full" | "hover-only";
    onSelect: () => void;
    onDelete?: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    const { pathD, startX, startY, endX, endY } = canvasConnectionPath(connection, from, to, fromScrollTop, toScrollTop);
    const flowActive = active || Boolean(selected);
    const emphasized = flowActive || hovered;
    // 普通连线始终保留灰色骨架；流动亮条只在选中连线或选中关联节点时显示。
    // hover-only 仅用于需要悬停预览的只读场景，主画布的 full 模式不会常驻动画。
    const showFlow = visualMode === "hover-only" ? flowActive || hovered : flowActive;
    const flowColor = theme.connection.flow;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                vectorEffect="non-scaling-stroke"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            {emphasized ? <path d={pathD} stroke={theme.connection.active} strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" style={{ pointerEvents: "none" }} /> : null}
            {/* 归一化路径让每条线保持三段流光；叠加短条形成随路径移动的尾迹，而非整线渐变。 */}
            {showFlow ? <g stroke={flowColor} fill="none" style={{ pointerEvents: "none" }}>
                {CONNECTION_FLOW_LAYERS.map((layer, index) => <path
                    key={index}
                    className="canvas-connection-flow"
                    d={pathD}
                    pathLength={300}
                    strokeWidth={layer.width}
                    vectorEffect="non-scaling-stroke"
                    strokeOpacity={layer.opacity}
                    strokeDasharray={layer.dash}
                    strokeLinecap={index < 2 ? "round" : "butt"}
                />)}
            </g> : null}
            {selected && onDelete ? (
                <g
                    transform={`translate(${(startX + endX) / 2} ${(startY + endY) / 2})`}
                    role="button"
                    tabIndex={0}
                    aria-label="断开连线"
                    style={{ cursor: "pointer", pointerEvents: "all" }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onDelete();
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        onDelete();
                    }}
                >
                    <title>断开连线</title>
                    <circle r="11" fill={theme.spatial.elevated} stroke={theme.accent.primary} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                    <Scissors x="-8" y="-8" width="16" height="16" stroke={theme.node.text} strokeWidth="1.8" aria-hidden="true" />
                </g>
            ) : null}
        </g>
    );
}, (previous, next) => previous.connection === next.connection && previous.from === next.from && previous.to === next.to && previous.active === next.active && previous.selected === next.selected && previous.visualMode === next.visualMode && previous.fromScrollTop === next.fromScrollTop && previous.toScrollTop === next.toScrollTop);

export function canvasConnectionPath(connection: CanvasConnection, from: CanvasNodeData, to: CanvasNodeData, fromScrollTop = 0, toScrollTop = 0) {
    const startX = from.position.x + from.width;
    const startY = connectionVisualY(from, connection.fromHandleId, fromScrollTop, connection.fromAnchorRatio);
    const endX = to.position.x;
    const endY = connectionVisualY(to, connection.toHandleId, toScrollTop, connection.toAnchorRatio);
    return { pathD: connectionCurvePath(startX, startY, endX, endY), startX, startY, endX, endY };
}

export function activeConnectionPath(node: CanvasNodeData | undefined, handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData, nodeScrollTop = 0, targetAnchorRatio?: number) {
    if (!node) return "";
    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? connectionVisualY(node, handle.handleId, nodeScrollTop, handle.anchorRatio) : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : connectionVisualY(node, handle.handleId, nodeScrollTop, handle.anchorRatio);
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? connectionVisualCenterY(target) : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? connectionVisualCenterY(target) : endY;
    return connectionCurvePath(snappedStartX, snappedStartY, snappedEndX, snappedEndY);
}

// 普通节点的视觉路径统一在节点中线汇聚；分镜行端口保留行级锚点，
// 仅用于脚本节点的逐镜头关系，避免破坏分镜数据的可读性。
function connectionVisualY(node: CanvasNodeData, handleId?: string, scrollTop = 0, anchorRatio?: number) {
    if (handleId === "storyboard:context" || handleId?.startsWith("row:")) return connectionHandleY(node, handleId, scrollTop, anchorRatio);
    return connectionVisualCenterY(node);
}

function connectionVisualCenterY(node: CanvasNodeData) {
    return node.position.y + node.height / 2;
}

function connectionCurvePath(startX: number, startY: number, endX: number, endY: number) {
    const distance = endX - startX;
    // 控制点随完整横向距离变化，避免长线被固定上限压成斜直线。
    // 接近垂直时保留短水平切线；反向连接保持对称，不产生大回环。
    const bend = Math.abs(distance) < 48 ? (distance < 0 ? -24 : 24) : distance / 2;
    return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

const CONNECTION_FLOW_LAYERS = [
    { width: 6, opacity: 0.06, dash: "36 64" },
    { width: 3.5, opacity: 0.12, dash: "36 64" },
    { width: 2, opacity: 0.15, dash: "36 64" },
    { width: 2, opacity: 0.18, dash: "0 6 30 64" },
    { width: 2, opacity: 0.21, dash: "0 12 24 64" },
    { width: 2, opacity: 0.27, dash: "0 18 18 64" },
    { width: 2, opacity: 0.38, dash: "0 24 12 64" },
    { width: 2, opacity: 0.6, dash: "0 30 6 64" },
];

export function connectionHandleY(node: CanvasNodeData, handleId?: string, scrollTop = 0, anchorRatio?: number) {
    if (handleId === "storyboard:context") return node.position.y + node.height - (node.metadata?.storyboardComposerHeight || 104) / 2;
    if (!handleId?.startsWith("row:")) return node.position.y + node.height * normalizedAnchorRatio(anchorRatio);
    const rowId = handleId.slice(4);
    const index = (node.metadata?.storyboard?.rows || []).findIndex((row) => row.id === rowId);
    if (index < 0) return node.position.y + node.height / 2;
    const tableHeight = storyboardTableHeight(node.height, node.metadata?.storyboardComposerHeight);
    const localY = Math.min(Math.max(index * STORYBOARD_ROW_HEIGHT + STORYBOARD_ROW_HEIGHT / 2 - scrollTop, 4), tableHeight - 4);
    return node.position.y + STORYBOARD_HEADER_HEIGHT + localY;
}

function normalizedAnchorRatio(value?: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
    return Math.min(0.94, Math.max(0.06, value));
}
