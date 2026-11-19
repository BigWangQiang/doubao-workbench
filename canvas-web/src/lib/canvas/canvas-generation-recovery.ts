import type { CanvasNodeData } from "@/types/canvas";

export function recoverableGenerationTaskIds(nodes: CanvasNodeData[], ignoredTaskIds: ReadonlySet<string>) {
    const taskIds = nodes.flatMap((node) => {
        const taskId = node.metadata?.taskId;
        if (!taskId || node.metadata?.status === "success" || ignoredTaskIds.has(taskId)) return [];
        return [taskId];
    });
    return Array.from(new Set(taskIds)).sort();
}
