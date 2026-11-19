import { generationErrorMessage } from "@/lib/generation-error";
import { teamTaskCredentials } from "@/services/team-canvas-session";
import { apiClient, request, type BackendEnvelope } from "@/services/api/request";

export type { BackendEnvelope } from "@/services/api/request";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskBillingStatus = "reserved" | "running" | "settled" | "refunded" | "uncertain";
export type ProviderCancelStatus = "requested" | "confirmed" | "uncertain";
export type AgentSessionStatus = "active" | "completed" | "failed";

export type GenerationTask = {
    id: string;
    sessionId?: string;
    projectId?: string;
    type: string;
    status: TaskStatus;
    /** 当前阶段原始百分比；-1 表示未知，视频时间估算仅由展示层计算。 */
    progress?: number;
    stage?: string;
    prompt: string;
    operation?: string;
    provider?: string;
    model?: string;
    providerRequestId?: string;
    /** 服务端已接单并持续查询；浏览器不以默认等待时长判定生成失败。 */
    continuePolling?: boolean;
    providerCancelStatus?: ProviderCancelStatus;
    providerCancelError?: string;
    providerCancelAttempts?: number;
    providerCancelRequestedAt?: string;
    providerCancelledAt?: string;
    errorCode?: string;
    previewUrl?: string;
    previewKind?: "image" | "video";
    previews?: Array<{ url: string; kind: "image" | "video" }>;
    inputJson?: string;
    resultJson?: string;
    textDraft?: string;
    error?: string;
    attempts: number;
    startedAt?: string;
    completedAt?: string;
    createdAt: string;
    updatedAt: string;
    billing?: {
        amountMicrocredits: number;
        status: TaskBillingStatus;
        refundPending?: boolean;
    };
    clientContext?: {
        conversationId: string;
        messageId: string;
        batchIndex?: number;
        batchCount?: number;
    };
    workbenchContext?: {
        kind: "image" | "video";
        toolId?: string;
        presetId?: string;
        parameters?: Record<string, string | number | boolean>;
        references?: Array<{
            resourceId: string;
            kind: "image" | "video" | "audio";
            role?: "reference" | "first_frame" | "last_frame";
            slotKey?: string;
        }>;
    };
    created_at?: string;
    updated_at?: string;
};

export type ProviderTaskQueryResult = {
    task: GenerationTask;
    providerStatus: string;
    recovered: boolean;
    billingSettled: boolean;
};

export type TaskTextDelta = {
    id: string;
    taskId: string;
    sequence: number;
    content: string;
    byteCount: number;
    createdAt: string;
    expiresAt: string;
};

export type TaskTextReplay = {
    deltas: TaskTextDelta[];
    textDraft?: string;
    finalText?: string;
    complete: boolean;
};

export type AgentSession = {
    id: string;
    projectId?: string;
    status: AgentSessionStatus;
    prompt: string;
    canvasSnapshotJson?: string;
    canvasOpsJson?: string;
    createdAt: string;
    updatedAt: string;
};

export type AgentMessage = {
    id: string;
    sessionId: string;
    role: "user" | "assistant" | "system" | "tool" | string;
    content: string;
    payload?: string;
    createdAt: string;
};

export type TaskResult = {
    id: string;
    taskId: string;
    sessionId?: string;
    kind: string;
    url?: string;
    payload?: string;
    createdAt: string;
};

export type SessionFile = {
    id: string;
    sessionId: string;
    fileName: string;
    mimeType: string;
    size: number;
    createdAt: string;
};

export type TaskLog = {
    id: string;
    taskId: string;
    level: "info" | "warn" | "error" | string;
    message: string;
    payload?: string;
    createdAt: string;
};

export type AgentSessionDetail = {
    session: AgentSession;
    messages: AgentMessage[];
    tasks: GenerationTask[];
    results: TaskResult[];
};

export type CreateSessionInput = {
    projectId?: string;
    shotCount?: number;
    shotDurationSeconds?: number;
    prompt: string;
    canvasSnapshot?: Record<string, unknown>;
    references?: string[];
    projectStyle?: { presetId: string; title: string; prompt: string };
    characters?: Array<{ assetId: string; versionId: string; name: string; definition: Record<string, unknown> }>;
    config?: Record<string, unknown>;
};

export type CreateTaskInput = {
    sessionId?: string;
    projectId?: string;
    type?: string;
    operation?: string;
    prompt: string;
    provider?: string;
    model?: string;
    input?: Record<string, unknown>;
};

const api = apiClient;

export function createAgentSession(input: CreateSessionInput) {
    return request<AgentSessionDetail>(api.post("/sessions", input)).then((detail) => {
        detail.tasks.forEach((task) => notifyCanvasTaskCreated(task));
        return detail;
    });
}

export function queryAgentSession(id: string) {
    return request<AgentSessionDetail>(api.get(`/sessions/${encodeURIComponent(id)}`));
}

export function agentSessionFailureMessage(detail: AgentSessionDetail, fallback = "后端影视 Agent 会话失败") {
    for (let index = detail.tasks.length - 1; index >= 0; index -= 1) {
        const task = detail.tasks[index];
        if ((task.status === "failed" || task.status === "cancelled") && task.error?.trim()) return generationErrorMessage(task.error.trim());
    }
    for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
        const message = detail.messages[index];
        if (message.role === "assistant" && message.content.trim()) return generationErrorMessage(message.content.trim());
    }
    return fallback;
}

export function downloadSessionResults(id: string) {
    return request<TaskResult[]>(api.get(`/sessions/${encodeURIComponent(id)}/results`));
}

export function uploadAgentFile(sessionId: string, file: File) {
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("file", file);
    return request<SessionFile>(api.post("/files", formData));
}

export function createGenerationTask(input: CreateTaskInput, options?: { signal?: AbortSignal }) {
    return request<GenerationTask>(api.post("/tasks", { ...input, ...teamTaskCredentials(input.projectId) }, { signal: options?.signal })).then((task) => {
        notifyCanvasTaskCreated(task);
        // 创建任务时积分已被预占，不能等任务结束后才刷新可用余额。
        window.dispatchEvent(new CustomEvent("wallet:updated"));
        return task;
    });
}

export function listGenerationTasks(limit = 30, options?: { projectId?: string; activeOnly?: boolean; signal?: AbortSignal }) {
    return request<GenerationTask[]>(api.get("/tasks", { params: { limit, projectId: options?.projectId, activeOnly: options?.activeOnly || undefined }, signal: options?.signal }));
}

export function hideWorkbenchTaskHistory(kind: "image" | "video") {
    return request<{ hiddenCount: number }>(api.delete("/tasks", { params: { workbenchKind: kind } }));
}

export function queryGenerationTask(id: string, options?: { signal?: AbortSignal; timeout?: number }) {
    return request<GenerationTask>(api.get(`/tasks/${encodeURIComponent(id)}`, { signal: options?.signal, timeout: options?.timeout }));
}

export function appendTaskTextDelta(id: string, content: string) {
    return request<TaskTextDelta>(api.post(`/tasks/${encodeURIComponent(id)}/text-deltas`, { content }));
}

export function queryTaskTextReplay(id: string, after = 0) {
    return request<TaskTextReplay>(api.get(`/tasks/${encodeURIComponent(id)}/text-deltas`, { params: { after } }));
}

export function retryGenerationTask(id: string) {
    return request<GenerationTask>(api.post(`/tasks/${encodeURIComponent(id)}/retry`));
}

export function queryFailedVideoProviderTask(id: string) {
    return request<ProviderTaskQueryResult>(api.post(`/tasks/${encodeURIComponent(id)}/query-provider`));
}

export function cancelGenerationTask(id: string, options?: { timeout?: number }) {
    return request<GenerationTask>(api.post(`/tasks/${encodeURIComponent(id)}/cancel`, undefined, options));
}

export function listTaskLogs(id: string) {
    return request<TaskLog[]>(api.get(`/tasks/${encodeURIComponent(id)}/logs`));
}

// 页面卸载或账号切换只结束本地等待，不能替用户取消已经提交的计费任务。
export const GENERATION_WAIT_DETACHED = "generation-wait-detached";

export async function waitForGenerationTask(id: string, options?: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number; initialTask?: GenerationTask; onTaskUpdate?: (task: GenerationTask) => void }) {
    const startedAt = Date.now();
    const intervalMs = options?.intervalMs || 2000;
    let lastTask = options?.initialTask;
    let lastQueryError: unknown;
    let reconnectDelayMs = intervalMs;
    try {
        while (Date.now() - startedAt < (options?.timeoutMs || taskWaitTimeoutMs(lastTask))) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let task: GenerationTask;
            try {
                task = await queryGenerationTask(id, { signal: options?.signal, timeout: lastTask?.continuePolling ? 30_000 : undefined });
                lastTask = task;
                lastQueryError = undefined;
                reconnectDelayMs = intervalMs;
                options?.onTaskUpdate?.(task);
            } catch (error) {
                if (options?.signal?.aborted) throw error;
                lastQueryError = error;
                if (lastTask?.continuePolling) {
                    options?.onTaskUpdate?.({ ...lastTask, stage: "任务状态同步暂时中断，正在重连", progress: -1 });
                }
                await delay(reconnectDelayMs, options?.signal);
                if (lastTask?.continuePolling) reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
                continue;
            }
            if (task.status === "succeeded") {
                window.dispatchEvent(new CustomEvent("wallet:updated"));
                return task;
            }
            if (task.status === "failed" || task.status === "cancelled") {
                window.dispatchEvent(new CustomEvent("wallet:updated"));
                throw new Error(task.error ? generationErrorMessage(task.error) : `任务${task.status === "cancelled" ? "已取消" : "失败"}`);
            }
            await delay(intervalMs, options?.signal);
        }
    } catch (error) {
        if (options?.signal?.aborted) {
            if (options.signal.reason !== GENERATION_WAIT_DETACHED) {
                await cancelGenerationTask(id);
                window.dispatchEvent(new CustomEvent("wallet:updated"));
            }
            throw new DOMException("Aborted", "AbortError");
        }
        throw error;
    }
    throw new Error(lastQueryError instanceof Error ? `任务状态同步失败：${lastQueryError.message}` : "任务执行超时，请稍后重试");
}

function taskWaitTimeoutMs(task?: GenerationTask) {
    if (task?.continuePolling && task.providerRequestId && task.status === "running") return Number.POSITIVE_INFINITY;
    const type = task?.type || "";
    if (type.includes("storyboard")) return 13 * 60 * 1000;
    if (type.includes("video")) return 32 * 60 * 1000;
    if (type.includes("image")) return 10 * 60 * 1000;
    if (type.includes("text") || type.includes("audio")) return 12 * 60 * 1000;
    return 10 * 60 * 1000;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function notifyCanvasTaskCreated(task: GenerationTask) {
    if (typeof window === "undefined" || !task.projectId) return;
    window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
}
