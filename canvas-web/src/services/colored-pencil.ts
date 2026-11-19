import localforage from "localforage";

import { COLORED_PENCIL_TRANSFORM, coloredPencilModelConfig, coloredPencilRatioMatches } from "@/lib/colored-pencil";
import { getSystemChannels } from "@/services/api/auth";
import { apiClient, request } from "@/services/api/request";
import { parseBackendGenerationResult, submitBackendGenerationTask } from "@/services/api/generation-task";
import { getResourceAccess, resourceIdFromStorageKey } from "@/services/api/resources";
import { listGenerationTasks, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import type { UploadedImage } from "@/services/image-storage";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type ColoredPencilReceipt = { sourceKey: string; requestId: string; taskId?: string; successTaskId?: string };
const receiptStore = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
const receiptKey = (userId: string) => `colored-pencil-receipts:user:${userId}`;
let receiptWrite: Promise<unknown> = Promise.resolve();

export async function readColoredPencilReceipts(userId: string) {
    return (await receiptStore.getItem<ColoredPencilReceipt[]>(receiptKey(userId))) || [];
}

export function updateColoredPencilReceipt(userId: string, sourceKey: string, receipt?: ColoredPencilReceipt) {
    // 只保存资源标识和任务凭证；不保存私有下载链接、图片正文或渠道密钥。
    // 旧会话的异步结果和新会话恢复可能同时回写，串行合并避免覆盖另一任务凭证。
    const updated = receiptWrite.catch(() => undefined).then(async () => {
        const current = await readColoredPencilReceipts(userId);
        const next = [...current.filter((item) => item.sourceKey !== sourceKey), ...(receipt ? [receipt] : [])].slice(-100);
        await receiptStore.setItem(receiptKey(userId), next);
        return next;
    });
    receiptWrite = updated;
    return updated;
}

export async function refreshColoredPencilConfig(userId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
        const policy = await request<{ version: number }>(apiClient.get("/image-transforms/colored-pencil", { signal, timeout: 30_000 }));
        if (policy.version !== 1) throw new Error("policy unavailable");
    } catch {
        signal?.throwIfAborted();
        throw new Error("转彩铅配置读取失败或超时，请重新读取；尚未提交生成任务");
    }
    const { channels } = await getSystemChannels({ signal, timeout: 30_000 });
    signal?.throwIfAborted();
    if (useUserStore.getState().user?.id !== userId) throw new Error("账号已切换，请重新打开转彩铅");
    useConfigStore.getState().mergeSystemChannels(channels);
    return useConfigStore.getState().config;
}

export function submitColoredPencilTask(config: AiConfig, original: ReferenceImage, requestId: string, signal?: AbortSignal) {
    return submitBackendGenerationTask({
        mode: "image",
        prompt: "参考图转彩铅",
        config: coloredPencilModelConfig(config),
        referenceImages: [original],
        signal,
        metadata: { source: "colored-pencil", imageTransform: COLORED_PENCIL_TRANSFORM, conversationId: "colored-pencil", messageId: requestId },
    });
}

export async function recoverColoredPencilTask(receipt: ColoredPencilReceipt, signal?: AbortSignal) {
    if (receipt.taskId) return queryGenerationTask(receipt.taskId, { signal });
    const recent = await listGenerationTasks(100, { signal });
    const match = recent.find((task) => task.type === "canvas_image" && task.clientContext?.conversationId === "colored-pencil" && task.clientContext.messageId === receipt.requestId);
    return match ? queryGenerationTask(match.id, { signal }) : null;
}

export async function coloredPencilTaskImage(task: GenerationTask, options?: { signal?: AbortSignal }): Promise<UploadedImage> {
    let result = parseBackendGenerationResult(task).images?.[0];
    if (!result?.dataUrl && !result?.storageKey) throw new Error("任务未返回彩铅图片，请到任务中心查看");
    const deadline = Date.now() + 120_000;
    // 生成成功可能先返回 external-image 标记；归档会原子更新同一任务。
    // 只等待已有任务，不能把临时外链当资源，也不能重新上传造成重复归档和扣费。
    while (!resourceIdFromStorageKey(result?.storageKey)) {
        if (!result?.storageKey?.startsWith("external-image:") || Date.now() >= deadline) {
            throw new Error("彩铅图已生成，结果仍在保存中。请点击恢复结果，不会重新生成或扣费");
        }
        await waitForColoredPencilArchivePoll(options?.signal);
        const latest = await queryGenerationTask(task.id, { signal: options?.signal });
        if (latest.status !== "succeeded") throw new Error("已有彩铅任务状态已变化，请重新读取结果");
        result = parseBackendGenerationResult(latest).images?.[0];
    }
    options?.signal?.throwIfAborted();
    const storageKey = result!.storageKey!;
    const previewSignal = AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]);
    const access = await waitForColoredPencilStep(getResourceAccess(storageKey, "display"), previewSignal);
    // 通用 readImageMeta 在失败时兜底 1024；此处必须真实解码，避免误把横竖比不符的图下发。
    const actual = new Image();
    actual.src = access.url;
    try { await waitForColoredPencilStep(actual.decode(), previewSignal); }
    catch {
        actual.removeAttribute("src");
        options?.signal?.throwIfAborted();
        throw new Error("彩铅图片读取失败或超时，请点击恢复结果，无需重新生成");
    }
    options?.signal?.throwIfAborted();
    const input = JSON.parse(task.inputJson || "{}") as { metadata?: { originalWidth?: number; originalHeight?: number } };
    if (!coloredPencilRatioMatches(Number(input.metadata?.originalWidth), Number(input.metadata?.originalHeight), actual.naturalWidth, actual.naturalHeight)) {
        throw new Error("生成图比例与原图不一致，未替换原图。产物已保留在任务中心，可重新生成");
    }
    return { url: access.url, storageKey, width: actual.naturalWidth, height: actual.naturalHeight, bytes: result!.bytes || 0, mimeType: result!.mimeType || "image/png" };
}

function waitForColoredPencilArchivePoll(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const abort = () => { window.clearTimeout(timer); reject(new Error("已停止等待，彩铅结果仍会保留，可稍后恢复")); };
        const timer = window.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 2000);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

// IndexedDB 写入和 Image.decode 不接受 AbortSignal；只解除页面等待，底层写入仍保留任务凭证。
export function waitForColoredPencilStep<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new DOMException("已停止等待", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
