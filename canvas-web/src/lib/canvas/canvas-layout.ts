import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

export type CanvasLayoutMode = "row" | "column" | "grid";
export type CanvasAlignmentMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "distributeX" | "distributeY";

const AUTO_LAYOUT_HORIZONTAL_GAP = 72;
const AUTO_LAYOUT_VERTICAL_GAP = 64;
const AUTO_LAYOUT_TARGET_ASPECT_RATIO = 16 / 10;

function compareCanvasNodePosition(a: CanvasNodeData, b: CanvasNodeData) {
    return a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id);
}

function orderCanvasComponent(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (nodes.length < 2) return nodes;
    const nodeIds = new Set(nodes.map((node) => node.id));
    const inbound = new Map(nodes.map((node) => [node.id, 0]));
    const outbound = new Map(nodes.map((node) => [node.id, [] as string[]]));
    const layerById = new Map<string, number>();

    connections.forEach((connection) => {
        if (!nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId) || connection.fromNodeId === connection.toNodeId) return;
        inbound.set(connection.toNodeId, (inbound.get(connection.toNodeId) || 0) + 1);
        outbound.get(connection.fromNodeId)?.push(connection.toNodeId);
    });

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const compareIds = (a: string, b: string) => compareCanvasNodePosition(byId.get(a)!, byId.get(b)!);
    const queue = nodes.filter((node) => !inbound.get(node.id)).map((node) => node.id).sort(compareIds);
    const resolved = new Set<string>();

    queue.forEach((id) => layerById.set(id, 0));
    while (queue.length) {
        const id = queue.shift()!;
        resolved.add(id);
        const layer = layerById.get(id) || 0;
        outbound.get(id)?.forEach((target) => {
            layerById.set(target, Math.max(layerById.get(target) || 0, layer + 1));
            inbound.set(target, (inbound.get(target) || 1) - 1);
            if (!inbound.get(target)) {
                queue.push(target);
                queue.sort(compareIds);
            }
        });
    }

    const ordered = nodes
        .filter((node) => resolved.has(node.id))
        .sort((a, b) => (layerById.get(a.id) || 0) - (layerById.get(b.id) || 0) || compareCanvasNodePosition(a, b));
    const cyclic = nodes.filter((node) => !resolved.has(node.id)).sort(compareCanvasNodePosition);
    return [...ordered, ...cyclic];
}

function orderCanvasNodesForAutoLayout(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    const usableConnections = connections.filter((connection) => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId));

    usableConnections.forEach((connection) => {
        neighbors.get(connection.fromNodeId)?.add(connection.toNodeId);
        neighbors.get(connection.toNodeId)?.add(connection.fromNodeId);
    });

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visited = new Set<string>();
    const components: CanvasNodeData[][] = [];
    [...nodes].sort(compareCanvasNodePosition).forEach((node) => {
        if (visited.has(node.id)) return;
        const componentIds: string[] = [];
        const queue = [node.id];
        visited.add(node.id);
        while (queue.length) {
            const id = queue.shift()!;
            componentIds.push(id);
            neighbors.get(id)?.forEach((neighborId) => {
                if (visited.has(neighborId)) return;
                visited.add(neighborId);
                queue.push(neighborId);
            });
        }
        components.push(componentIds.map((id) => byId.get(id)!));
    });

    return components.flatMap((component) => orderCanvasComponent(component, usableConnections));
}

function autoLayoutColumnCount(nodes: CanvasNodeData[]) {
    if (nodes.length < 2) return 1;
    const averageWidth = nodes.reduce((sum, node) => sum + Math.max(1, node.width), 0) / nodes.length;
    const averageHeight = nodes.reduce((sum, node) => sum + Math.max(1, node.height), 0) / nodes.length;
    const ideal = Math.ceil(Math.sqrt((nodes.length * averageHeight * AUTO_LAYOUT_TARGET_ASPECT_RATIO) / averageWidth));
    return Math.max(2, Math.min(nodes.length, ideal));
}

export function layoutCanvasNodes(nodes: CanvasNodeData[], mode: CanvasLayoutMode) {
    const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    const left = Math.min(...sorted.map((node) => node.position.x));
    const top = Math.min(...sorted.map((node) => node.position.y));
    const gap = 32;
    const result = new Map<string, Position>();

    if (mode === "row") {
        let x = left;
        sorted.forEach((node) => {
            result.set(node.id, { x, y: top });
            x += node.width + gap;
        });
        return result;
    }

    if (mode === "column") {
        let y = top;
        sorted.forEach((node) => {
            result.set(node.id, { x: left, y });
            y += node.height + gap;
        });
        return result;
    }

    const columns = Math.ceil(Math.sqrt(sorted.length));
    const cellWidth = Math.max(...sorted.map((node) => node.width)) + gap;
    const cellHeight = Math.max(...sorted.map((node) => node.height)) + gap;
    sorted.forEach((node, index) => result.set(node.id, { x: left + (index % columns) * cellWidth, y: top + Math.floor(index / columns) * cellHeight }));
    return result;
}

// One-click layout keeps connected workflows together, then wraps them into a compact two-dimensional grid.
export function layoutCanvasAuto(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const result = new Map<string, Position>();
    if (!nodes.length) return result;

    const ordered = orderCanvasNodesForAutoLayout(nodes, connections);
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const columns = autoLayoutColumnCount(ordered);
    const rows = Array.from({ length: Math.ceil(ordered.length / columns) }, (_, rowIndex) => ordered.slice(rowIndex * columns, (rowIndex + 1) * columns));
    const rowWidths = rows.map((row) => row.reduce((width, node, index) => width + node.width + (index ? AUTO_LAYOUT_HORIZONTAL_GAP : 0), 0));
    const layoutWidth = Math.max(...rowWidths);
    let y = top;

    rows.forEach((row, rowIndex) => {
        const rowHeight = Math.max(...row.map((node) => node.height));
        let x = left + (layoutWidth - rowWidths[rowIndex]) / 2;
        row.forEach((node) => {
            result.set(node.id, { x, y: y + (rowHeight - node.height) / 2 });
            x += node.width + AUTO_LAYOUT_HORIZONTAL_GAP;
        });
        y += rowHeight + AUTO_LAYOUT_VERTICAL_GAP;
    });

    return result;
}

function storyboardWorkflowStage(node: CanvasNodeData) {
    const workflow = node.metadata?.workflowKind;
    if (node.type === "script" || workflow === "script" || workflow === "story_input") return 0;
    if (node.type === "image" || workflow === "storyboard" || workflow === "shot" || workflow === "action_board" || workflow === "styleboard") return 1;
    if (node.type === "video" || workflow === "reference_video") return 2;
    if (workflow === "final" || node.type === "audio") return 3;
    return node.type === "text" || node.type === "config" ? 0 : 1;
}

/** 创作工作流固定按“脚本 → 分镜图 → 视频 → 成片/音频”分列，列内按镜头号与原位置排序。 */
export function layoutCanvasStoryboardWorkflow(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const result = new Map<string, Position>();
    if (!nodes.length) return result;
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const connectedOrder = new Map(orderCanvasNodesForAutoLayout(nodes, connections).map((node, index) => [node.id, index]));
    const groups = new Map<number, CanvasNodeData[]>();
    nodes.forEach((node) => groups.set(storyboardWorkflowStage(node), [...(groups.get(storyboardWorkflowStage(node)) || []), node]));
    let x = left;
    [0, 1, 2, 3].forEach((stage) => {
        const column = (groups.get(stage) || []).sort((a, b) => {
            const shot = (a.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER) - (b.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER);
            return shot || (connectedOrder.get(a.id) || 0) - (connectedOrder.get(b.id) || 0) || compareCanvasNodePosition(a, b);
        });
        if (!column.length) return;
        let y = top;
        const width = Math.max(...column.map((node) => node.width));
        column.forEach((node) => {
            result.set(node.id, { x, y });
            y += node.height + AUTO_LAYOUT_VERTICAL_GAP;
        });
        x += width + 140;
    });
    return result;
}

export function applyCanvasLayoutPositions(nodes: CanvasNodeData[], positions: Map<string, Position>) {
    const parentOffsets = new Map<string, Position>();
    nodes.forEach((node) => {
        const position = positions.get(node.id);
        if (!position) return;
        parentOffsets.set(node.id, { x: position.x - node.position.x, y: position.y - node.position.y });
    });

    return nodes.map((node) => {
        const position = positions.get(node.id);
        if (position) return { ...node, position };
        const parentOffset = node.parentId ? parentOffsets.get(node.parentId) : undefined;
        if (!parentOffset) return node;
        return { ...node, position: { x: node.position.x + parentOffset.x, y: node.position.y + parentOffset.y } };
    });
}

export function layoutCanvasFlow(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const selectedIds = new Set(nodes.map((node) => node.id));
    const inbound = new Map(nodes.map((node) => [node.id, 0]));
    const outbound = new Map(nodes.map((node) => [node.id, [] as string[]]));

    connections.forEach((connection) => {
        if (!selectedIds.has(connection.fromNodeId) || !selectedIds.has(connection.toNodeId)) return;
        inbound.set(connection.toNodeId, (inbound.get(connection.toNodeId) || 0) + 1);
        outbound.get(connection.fromNodeId)?.push(connection.toNodeId);
    });

    // Kahn 拓扑分层让依赖方向保持从左到右；环形连接留在第一层，避免布局死循环。
    const queue = nodes.filter((node) => !inbound.get(node.id)).map((node) => node.id);
    const layerById = new Map<string, number>();
    queue.forEach((id) => layerById.set(id, 0));
    while (queue.length) {
        const id = queue.shift()!;
        const layer = layerById.get(id) || 0;
        outbound.get(id)?.forEach((target) => {
            layerById.set(target, Math.max(layerById.get(target) || 0, layer + 1));
            inbound.set(target, (inbound.get(target) || 1) - 1);
            if (!inbound.get(target)) queue.push(target);
        });
    }
    nodes.forEach((node) => {
        if (!layerById.has(node.id)) layerById.set(node.id, 0);
    });

    const groups = new Map<number, CanvasNodeData[]>();
    nodes.forEach((node) => {
        const layer = layerById.get(node.id) || 0;
        groups.set(layer, [...(groups.get(layer) || []), node]);
    });

    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const result = new Map<string, Position>();
    let x = left;
    [...groups.keys()].sort((a, b) => a - b).forEach((layer) => {
        const column = groups.get(layer)!.sort((a, b) => a.position.y - b.position.y);
        let y = top;
        const width = Math.max(...column.map((node) => node.width));
        column.forEach((node) => {
            result.set(node.id, { x, y });
            y += node.height + 48;
        });
        x += width + 120;
    });
    return result;
}

export function alignCanvasNodes(nodes: CanvasNodeData[], mode: CanvasAlignmentMode) {
    const result = new Map<string, Position>();
    if (nodes.length < 2) return result;
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const right = Math.max(...nodes.map((node) => node.position.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.position.y + node.height));
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;

    if (mode === "distributeX") {
        const sorted = [...nodes].sort((a, b) => a.position.x - b.position.x);
        const totalWidth = sorted.reduce((sum, node) => sum + node.width, 0);
        const gap = (right - left - totalWidth) / Math.max(1, sorted.length - 1);
        let x = left;
        sorted.forEach((node) => {
            result.set(node.id, { x, y: node.position.y });
            x += node.width + gap;
        });
        return result;
    }

    if (mode === "distributeY") {
        const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y);
        const totalHeight = sorted.reduce((sum, node) => sum + node.height, 0);
        const gap = (bottom - top - totalHeight) / Math.max(1, sorted.length - 1);
        let y = top;
        sorted.forEach((node) => {
            result.set(node.id, { x: node.position.x, y });
            y += node.height + gap;
        });
        return result;
    }

    nodes.forEach((node) => {
        const x = mode === "left" ? left : mode === "centerX" ? centerX - node.width / 2 : mode === "right" ? right - node.width : node.position.x;
        const y = mode === "top" ? top : mode === "centerY" ? centerY - node.height / 2 : mode === "bottom" ? bottom - node.height : node.position.y;
        result.set(node.id, { x, y });
    });
    return result;
}

export function nextCanvasVersionLabel(rootId: string, nodes: CanvasNodeData[]) {
    const labels = nodes
        .filter((node) => (node.metadata?.versionOfNodeId || node.id) === rootId)
        .map((node) => node.metadata?.versionLabel)
        .filter((label): label is string => Boolean(label));
    if (!labels.length) return "B";
    const highest = Math.max(...labels.map((label) => label.charCodeAt(0)), "A".charCodeAt(0));
    return String.fromCharCode(Math.min("Z".charCodeAt(0), highest + 1));
}
