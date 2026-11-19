import { canFrameContain, getFrameChildren } from "./canvas-frame";
import { isHiddenBatchChild, normalizeConnection } from "./canvas-project-domain";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type ConnectionEndpoints = Omit<CanvasConnection, "id">;

/** 分组只是操作入口，持久化仍使用素材间连线，生成上下文无需认识分组边。 */
export function planGroupConnections(frameId: string, targetNodeId: string, nodes: CanvasNodeData[], targetHandleId?: string, targetAnchorRatio?: number): { connections: ConnectionEndpoints[]; error?: string } {
    const children = getFrameChildren(frameId, nodes).filter((node) => canFrameContain(node) && !isHiddenBatchChild(node, nodes));
    if (!children.length) return { connections: [], error: "组内没有可连接的素材" };
    if (frameId === targetNodeId || children.some((node) => node.id === targetNodeId)) return { connections: [], error: "请连接到分组外的目标节点" };
    const connections: ConnectionEndpoints[] = [];
    for (const child of children) {
        const connection = normalizeConnection(child.id, targetNodeId, nodes, "source");
        if (!connection) return { connections: [], error: "该目标不能接收整组素材，请选择其他节点" };
        connections.push({ ...connection, toHandleId: targetHandleId, fromAnchorRatio: 0.5, toAnchorRatio: targetAnchorRatio });
    }
    return { connections };
}

export function sameConnectionEndpoints(left: ConnectionEndpoints, right: ConnectionEndpoints) {
    return left.fromNodeId === right.fromNodeId && left.toNodeId === right.toNodeId && left.fromHandleId === right.fromHandleId && left.toHandleId === right.toHandleId;
}
