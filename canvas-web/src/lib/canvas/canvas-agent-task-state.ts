type OnlineAgentTaskReference = {
    idempotencyKey: string;
    taskId?: string;
};

type PendingOnlineTurnState = {
    idempotencyKey: string;
    status?: string;
};

export type ActiveCanvasAgentTask = {
    taskKey: string;
    phase: string;
};

const activeTaskPhases = new Map<string, string>();
const activeTaskListeners = new Set<() => void>();
let activeTaskSnapshot: readonly ActiveCanvasAgentTask[] = [];

export function canvasAgentTaskKey(projectId: string, sessionId: string, assistantId: string) {
    return `${projectId}:${sessionId}:${assistantId}`;
}

export function claimCanvasAgentTask(taskKey: string, phase = "analysis") {
    if (activeTaskPhases.has(taskKey)) return false;
    activeTaskPhases.set(taskKey, phase);
    publishActiveTaskSnapshot();
    return true;
}

export function updateCanvasAgentTask(taskKey: string, phase: string) {
    if (!activeTaskPhases.has(taskKey) || activeTaskPhases.get(taskKey) === phase) return;
    activeTaskPhases.set(taskKey, phase);
    publishActiveTaskSnapshot();
}

export function releaseCanvasAgentTask(taskKey: string) {
    if (!activeTaskPhases.delete(taskKey)) return;
    publishActiveTaskSnapshot();
}

export function subscribeToCanvasAgentTasks(listener: () => void) {
    activeTaskListeners.add(listener);
    return () => {
        activeTaskListeners.delete(listener);
    };
}

export function getActiveCanvasAgentTasks() {
    return activeTaskSnapshot;
}

export function shouldRetainAwaitingApprovalTaskReference(activeTask: OnlineAgentTaskReference | null, pendingTurn: PendingOnlineTurnState | undefined) {
    return Boolean(activeTask && !activeTask.taskId && pendingTurn?.idempotencyKey === activeTask.idempotencyKey && pendingTurn.status === "awaiting_approval");
}

function publishActiveTaskSnapshot() {
    activeTaskSnapshot = Array.from(activeTaskPhases, ([taskKey, phase]) => ({ taskKey, phase }));
    activeTaskListeners.forEach((listener) => listener());
}
