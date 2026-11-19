import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { importResourceFromUrl, isResourceUrl, resourceIdFromStorageKey, resourceIdFromUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { createGenerationTask, waitForGenerationTask, type CreateTaskInput, type GenerationTask } from "@/services/api/task-center";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { localizeErrorMessage } from "@/lib/generation-error";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export type BackendGenerationMode = "text" | "image" | "video" | "audio";

export type BackendGenerationResult = {
    mode?: BackendGenerationMode;
    images?: Array<{ dataUrl: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }>;
    video?: { dataUrl: string; storageKey?: string; width?: number; height?: number; durationMs?: number; bytes?: number; mimeType?: string };
    audio?: { dataUrl: string; storageKey?: string; durationMs?: number; bytes?: number; mimeType?: string; format?: string };
    text?: string;
};

type BackendGenerationTaskOptions = {
    projectId?: string;
    mode: BackendGenerationMode;
    prompt: string;
    config: AiConfig;
    referenceImages?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    mask?: ReferenceImage;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    onTaskUpdate?: (task: GenerationTask) => void;
};

type PreparedGenerationReferences = {
    referenceImages: Awaited<ReturnType<typeof prepareBackendImageReference>>[];
    referenceVideos: Awaited<ReturnType<typeof prepareBackendMediaReference>>[];
    referenceAudios: Awaited<ReturnType<typeof prepareBackendMediaReference>>[];
    mask?: Awaited<ReturnType<typeof prepareBackendImageReference>>;
};

// 生成、计费、取消和任务记录必须共用后端任务生命周期，页面层不能再直连供应商。
export async function runBackendGenerationTask({
    projectId,
    mode,
    prompt,
    config,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = [],
    mask,
    signal,
    metadata,
    onTaskUpdate,
}: BackendGenerationTaskOptions) {
    throwIfAborted(signal);
    const prepared = await prepareGenerationReferences({ referenceImages, referenceVideos, referenceAudios, mask, signal });
    throwIfAborted(signal);
    return createAndWaitGenerationTask({ projectId, mode, prompt, config, referenceImages, referenceVideos, signal, metadata, onTaskUpdate }, prepared);
}

/** 工作台立即返回任务凭证，由统一任务中心负责查询状态与结果。 */
export async function submitBackendGenerationTask(options: BackendGenerationTaskOptions) {
    throwIfAborted(options.signal);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    const input = await buildGenerationTaskInput(options, prepared);
    throwIfAborted(options.signal);
    return createGenerationTask(input, { signal: options.signal });
}

export async function runBackendGenerationTaskBatch(options: BackendGenerationTaskOptions & { count: number }) {
    const count = Math.max(1, Math.min(15, Math.floor(Number(options.count)) || 1));
    throwIfAborted(options.signal);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    return Promise.allSettled(Array.from({ length: count }, (_, batchIndex) => createAndWaitGenerationTask({
        ...options,
        metadata: { ...options.metadata, batchIndex, batchCount: count },
    }, prepared)));
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function prepareGenerationReferences({ referenceImages = [], referenceVideos = [], referenceAudios = [], mask, signal }: Pick<BackendGenerationTaskOptions, "referenceImages" | "referenceVideos" | "referenceAudios" | "mask" | "signal">): Promise<PreparedGenerationReferences> {
    const preparedImages = await Promise.all(referenceImages.map((image) => prepareBackendImageReference(image, signal)));
    const preparedVideos = await Promise.all(referenceVideos.map((video) => prepareBackendMediaReference(video, signal)));
    const preparedAudios = await Promise.all(referenceAudios.map((audio) => prepareBackendMediaReference(audio, signal)));
    const preparedMask = mask ? await prepareBackendImageReference(mask, signal) : undefined;
    return { referenceImages: preparedImages, referenceVideos: preparedVideos, referenceAudios: preparedAudios, mask: preparedMask };
}

async function createAndWaitGenerationTask({ projectId, mode, prompt, config, referenceImages = [], signal, metadata, onTaskUpdate }: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences) {
    const task = await createGenerationTask(await buildGenerationTaskInput({ projectId, mode, prompt, config, referenceImages, metadata }, prepared));
    onTaskUpdate?.(task);
    const completed = await waitForGenerationTask(task.id, { signal, initialTask: task, onTaskUpdate });
    return parseBackendGenerationResult(completed);
}

async function buildGenerationTaskInput({ projectId, mode, prompt, config, referenceImages = [], metadata }: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences): Promise<CreateTaskInput> {
    const providerConfig = backendProviderConfig(config);
    const klingReference = mode === "video" && providerConfig.interfaceType === "kling-cli-video" && (prepared.referenceImages.length + prepared.referenceVideos.length + prepared.referenceAudios.length > 0);
    // 对话、工作台和画布共用提交入口：任务列表与执行元数据必须同为全能参考。
    const videoOperation = klingReference ? "reference_to_video" : String(metadata?.videoEditOperation || (referenceImages.length ? "image_to_video" : "text_to_video"));
    return {
        ...(projectId ? { projectId } : {}),
        type: `canvas_${mode}`,
        operation: mode === "video" ? videoOperation : mode,
        prompt,
        model: config.model,
        input: {
            mode,
            prompt,
            config: providerConfig,
            referenceImages: prepared.referenceImages,
            referenceVideos: prepared.referenceVideos,
            referenceAudios: prepared.referenceAudios,
            mask: prepared.mask,
            metadata: klingReference ? { ...metadata, videoEditOperation: videoOperation } : metadata,
        },
    };
}

async function prepareBackendMediaReference(media: ReferenceVideo | ReferenceAudio, signal?: AbortSignal) {
    if (resourceIdFromStorageKey(media.storageKey)) return backendMediaReference(media, { storageKey: media.storageKey });
    const url = media.url || "";
    if (/^https?:\/\//i.test(url)) return backendMediaReference(media, { url });
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && (url.startsWith("blob:") || url.startsWith("data:"))) blob = await (await fetch(url, { signal })).blob();
    if (!blob) throw new Error("参考媒体尚未保存，请重新上传后再生成");
    try {
        const kind: "video" | "audio" | "file" = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
        const resource = await uploadResourceFile(blob, kind, { fileName: media.name, width: "width" in media ? media.width : undefined, height: "height" in media ? media.height : undefined, durationMs: media.durationMs, signal });
        return backendMediaReference(media, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || media.type || blob.type });
    } catch (error) {
        throw new Error(`参考媒体上传失败：${localizeErrorMessage(error, "请稍后重试")}`);
    }
}

async function prepareBackendImageReference(image: ReferenceImage, signal?: AbortSignal) {
    if (resourceIdFromStorageKey(image.storageKey)) return backendImageReference(image, { storageKey: image.storageKey });
    const sourceUrls = [image.url, image.dataUrl].map((value) => String(value || "").trim()).filter((value, index, values) => value && values.indexOf(value) === index);
    for (const sourceUrl of sourceUrls) {
        // Older canvas nodes persisted the authenticated resource URL but not
        // its storage key. Rebuild the stable key so the backend can hydrate
        // the resource with the current user's permissions.
        const resourceId = isResourceUrl(sourceUrl) ? resourceIdFromUrl(sourceUrl) : "";
        if (resourceId) return backendImageReference(image, { storageKey: resourceStorageKey(resourceId), type: image.type });
        if (/^https?:\/\//i.test(sourceUrl)) {
            try {
                const resource = await importResourceFromUrl(sourceUrl, "image", { width: image.width, height: image.height, signal });
                return backendImageReference(image, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || image.type });
            } catch {
                throwIfAborted(signal);
                // Some self-hosted deployments disable URL import; fall back
                // to a credentialed browser read below.
            }
        }
    }
    const blob = await readReferenceImageBlob(image, sourceUrls, signal);
    if (!blob) throw new Error("参考图片尚未保存，请重新上传后再生成");
    if (!blob.type.startsWith("image/")) throw new Error("参考图片读取失败：返回内容不是图片，请重新上传");
    try {
        const resource = await uploadResourceFile(blob, "image", { fileName: image.name, signal });
        return backendImageReference(image, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || image.type || blob.type });
    } catch (error) {
        throw new Error(`参考图片上传失败：${localizeErrorMessage(error, "请稍后重试")}`);
    }
}

async function readReferenceImageBlob(image: ReferenceImage, sourceUrls: string[], signal?: AbortSignal) {
    if (image.storageKey) {
        const cached = await getImageBlob(image.storageKey);
        if (cached) return cached;
    }
    let lastError: unknown;
    for (const sourceUrl of sourceUrls) {
        if (!sourceUrl) continue;
        const isRelativeUrl = sourceUrl.startsWith("/") || sourceUrl.startsWith("./") || sourceUrl.startsWith("../");
        if (!/^https?:\/\/|^blob:|^data:/i.test(sourceUrl) && !isRelativeUrl) continue;
        try {
            const response = await fetch(sourceUrl, { credentials: isResourceUrl(sourceUrl) ? "include" : "same-origin", signal });
            if (!response.ok) throw new Error(`参考图片读取失败：HTTP ${response.status}`);
            return response.blob();
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) throw lastError;
    return null;
}

// 任务输入只允许后端协议字段，避免把 previewUrl 等页面态 Data URL 带入强校验写路径。
function backendImageReference(image: ReferenceImage, override: Partial<ReferenceImage>): ReferenceImage {
    return {
        id: image.id,
        name: image.name,
        type: override.type || image.type,
        dataUrl: "",
        url: override.url,
        storageKey: override.storageKey,
        ...(image.bytes ? { bytes: image.bytes } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
    };
}

function backendMediaReference<T extends ReferenceVideo | ReferenceAudio>(media: T, override: Partial<T>): T {
    return {
        id: media.id,
        name: media.name,
        type: override.type || media.type,
        url: override.url || "",
        storageKey: override.storageKey,
        ...("bytes" in media && media.bytes ? { bytes: media.bytes } : {}),
        ...("width" in media && media.width ? { width: media.width } : {}),
        ...("height" in media && media.height ? { height: media.height } : {}),
        ...(media.durationMs ? { durationMs: media.durationMs } : {}),
    } as T;
}

export function backendProviderConfig(config: AiConfig) {
    const requestConfig = resolveModelRequestConfig(config, config.model);
    return {
        channelId: requestConfig.channelId,
        apiFormat: requestConfig.apiFormat,
        interfaceType: requestConfig.interfaceType,
        baseUrl: requestConfig.baseUrl,
        apiKey: requestConfig.apiKey,
        secretKey: requestConfig.secretKey,
        model: requestConfig.model,
        size: config.size,
        quality: config.quality,
        transparentBackground: config.transparentBackground,
        count: config.count,
        videoSeconds: config.videoSeconds,
        vquality: config.vquality,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
        // requestConfig.model 已去掉渠道前缀；同名模型存在于多个渠道时会误取第一个渠道的能力配置。
        // 保留调用方的渠道限定模型，只把真实上游模型名写入 model 字段。
        capabilityConfig: modelCapabilityConfigFor(config, config.model),
        // Canvas workflow steps provide a per-task system prompt (for example,
        // the character/scene/prop/storyboard JSON contract). The global store
        // keeps its prompt empty, so forwarding this value cannot leak a stale
        // prompt between tasks and is required for structured responses.
        systemPrompt: config.systemPrompt?.trim() || "",
    };
}

export function parseBackendGenerationResult(task: GenerationTask): BackendGenerationResult {
    if (!task.resultJson) throw new Error("后端任务没有返回结果");
    const result = JSON.parse(task.resultJson) as BackendGenerationResult;
    if (!result || typeof result !== "object") throw new Error("后端任务结果格式错误");
    return result;
}
