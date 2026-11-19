import { apiBaseURL, apiClient, request } from "@/services/api/request";
import type { GenerationTask, TaskTextReplay } from "@/services/api/task-center";
import type { ResponseFunctionTool, ResponseInputMessage, ResponseToolCall } from "@/services/api/image";

export type CloudAgentModel = {
    channelId: string;
    model: string;
    displayName: string;
    description?: string;
    protocol: string;
    billingMode: string;
    unitPriceMicrocredits: number;
    inputTokenPriceMicrocredits?: number;
    outputTokenPriceMicrocredits?: number;
    cachedTokenPriceMicrocredits?: number;
};

export type CloudAgentCapabilities = {
    enabled: boolean;
    readOnly: boolean;
    maxPromptRunes: number;
    maxSnapshotBytes: number;
    models: CloudAgentModel[];
};

export type CloudAgentMessage = {
    id: string;
    taskId: string;
    prompt: string;
    text?: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
    error?: string;
    createdAt: string;
    updatedAt: string;
};

export type CloudAgentRun = {
    id: string;
    channelId: string;
    model: string;
    status: string;
    readOnly: boolean;
    messages: CloudAgentMessage[];
    createdAt: string;
    updatedAt: string;
};

export type CloudAgentCanvasSnapshot = Record<string, unknown>;

export type OnlineAgentTurnInput = {
    idempotencyKey: string;
    projectId: string;
    prompt: string;
    config: Record<string, unknown>;
    messages: ResponseInputMessage[];
    tools: ResponseFunctionTool[];
    toolChoice?: "auto" | "required" | { type: "function"; name: string };
};

export type OnlineAgentTurnState = {
    task: GenerationTask;
    replay: TaskTextReplay;
};

export type OnlineAgentTurnResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

export type OnlineAgentTurnWaitOptions = {
    signal?: AbortSignal;
    after?: number;
    onDelta?: (text: string) => void;
    onTask?: (task: GenerationTask) => void;
    intervalMs?: number;
};

export type CloudAgentRunInput = {
    channelId: string;
    model: string;
    prompt: string;
    canvasSnapshot?: CloudAgentCanvasSnapshot;
    idempotencyKey?: string;
};

export type CloudAgentMessageInput = {
    prompt: string;
    canvasSnapshot?: CloudAgentCanvasSnapshot;
    idempotencyKey?: string;
};

export async function createOnlineAgentTurn(input: OnlineAgentTurnInput) {
    return request<OnlineAgentTurnState>(apiClient.post("/agent/turns", input));
}

export async function getOnlineAgentTurn(id: string, after = 0, signal?: AbortSignal) {
    return request<OnlineAgentTurnState>(apiClient.get(`/agent/turns/${encodeURIComponent(id)}`, { params: { after }, signal }));
}

export async function cancelOnlineAgentTurn(id: string) {
    return request<OnlineAgentTurnState>(apiClient.post(`/agent/turns/${encodeURIComponent(id)}/cancel`));
}

export async function waitForOnlineAgentTurn(id: string, options: OnlineAgentTurnWaitOptions = {}): Promise<OnlineAgentTurnResult> {
    let after = options.after || 0;
    let streamed = "";
    const intervalMs = options.intervalMs || 700;
    while (true) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await getOnlineAgentTurn(id, after, options.signal);
        options.onTask?.(state.task);
        for (const delta of state.replay.deltas) {
            if (delta.sequence <= after) continue;
            after = delta.sequence;
            streamed += delta.content;
            options.onDelta?.(delta.content);
        }
        if (state.task.status === "succeeded") {
            const result = parseOnlineAgentTurnResult(state.task.resultJson, state.replay.finalText || streamed);
            if (!streamed && result.content) options.onDelta?.(result.content);
            return result;
        }
        if (state.task.status === "failed") throw new Error(state.task.error || "Agent 模型请求失败，请稍后重试");
        if (state.task.status === "cancelled") throw new Error(state.task.error || "Agent 任务已停止");
        await waitForNextOnlineAgentPoll(intervalMs, options.signal);
    }
}

function parseOnlineAgentTurnResult(raw: string | undefined, fallbackText: string): OnlineAgentTurnResult {
    if (raw) {
        try {
            const value = JSON.parse(raw) as { text?: unknown; toolCalls?: unknown };
            return {
                content: typeof value.text === "string" ? value.text : fallbackText,
                toolCalls: Array.isArray(value.toolCalls) ? (value.toolCalls as ResponseToolCall[]) : [],
            };
        } catch {
            // Preserve the streamed text if a legacy task result is not JSON.
        }
    }
    return { content: fallbackText, toolCalls: [] };
}

function waitForNextOnlineAgentPoll(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export async function getCloudAgentCapabilities(signal?: AbortSignal) {
    return request<CloudAgentCapabilities>(apiClient.get("/agent/capabilities", { signal }));
}

export async function createCloudAgentRun(input: CloudAgentRunInput, signal?: AbortSignal) {
    return request<CloudAgentRun>(apiClient.post("/agent/runs", input, { signal }));
}

export async function getCloudAgentRun(id: string, signal?: AbortSignal) {
    return request<CloudAgentRun>(apiClient.get(`/agent/runs/${encodeURIComponent(id)}`, { signal }));
}

export async function sendCloudAgentMessage(id: string, input: CloudAgentMessageInput, signal?: AbortSignal) {
    return request<CloudAgentRun>(apiClient.post(`/agent/runs/${encodeURIComponent(id)}/messages`, input, { signal }));
}

export async function cancelCloudAgent(id: string, signal?: AbortSignal) {
    return request<CloudAgentRun>(apiClient.post(`/agent/runs/${encodeURIComponent(id)}/cancel`, undefined, { signal }));
}

export type CloudAgentEventHandlers = {
    signal?: AbortSignal;
    onSnapshot: (run: CloudAgentRun) => void;
    onError?: (error: Error) => void;
};

function cloudAgentEventsURL(id: string) {
    return `${apiBaseURL.replace(/\/$/, "")}/agent/runs/${encodeURIComponent(id)}/events`;
}

function parseCloudAgentEvent(block: string) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    if (!dataLines.length) return { event, data: null };
    try {
        return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
    } catch {
        return { event, data: null };
    }
}

export async function subscribeCloudAgentRun(id: string, { signal, onSnapshot, onError }: CloudAgentEventHandlers) {
    try {
        const response = await fetch(cloudAgentEventsURL(id), {
            method: "GET",
            credentials: "include",
            headers: { Accept: "text/event-stream" },
            signal,
        });
        if (!response.ok) throw new Error("云端 Agent 状态连接失败");
        if (!response.body) throw new Error("云端 Agent 状态流不可用");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || "";
            for (const block of blocks) {
                const parsed = parseCloudAgentEvent(block);
                if (parsed.event === "snapshot" && parsed.data && typeof parsed.data === "object") onSnapshot(parsed.data as CloudAgentRun);
                if (parsed.event === "error") throw new Error("云端 Agent 状态暂时不可用");
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            const parsed = parseCloudAgentEvent(buffer);
            if (parsed.event === "snapshot" && parsed.data && typeof parsed.data === "object") onSnapshot(parsed.data as CloudAgentRun);
        }
    } catch (error) {
        if (signal?.aborted) return;
        const normalized = error instanceof Error ? error : new Error("云端 Agent 状态连接失败");
        onError?.(normalized);
        throw normalized;
    }
}
