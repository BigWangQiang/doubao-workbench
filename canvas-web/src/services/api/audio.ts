import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { createClientId } from "@/lib/client-id";
import { channelRequest } from "@/services/api/custom-channel-relay";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, isSystemProxyBaseUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { localizeErrorMessage } from "@/lib/generation-error";

type RequestOptions = { signal?: AbortSignal };

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(isSystemProxyBaseUrl(config.baseUrl) ? { "X-Canvas-Scene": "audio", "X-Idempotency-Key": createClientId() } : {}),
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    assertAudioConfig(requestConfig, model);
    if (requestConfig.interfaceType === "suno-music") {
        return await requestSunoMusicGeneration(requestConfig, model, prompt, options);
    }
    const isIndexTTS2 = requestConfig.interfaceType === "index-tts-v2";
    const format = isIndexTTS2 ? normalizeIndexTTS2Format(config.audioFormat) : normalizeAudioFormatValue(config.audioFormat);
    const instructions = config.audioInstructions.trim();
    const payload = {
        model,
        input: prompt,
        voice: isIndexTTS2 ? normalizeIndexTTS2Voice(config.audioVoice) : normalizeAudioVoiceValue(config.audioVoice),
        response_format: format,
        ...(isIndexTTS2 ? {} : { speed: Number(normalizeAudioSpeedValue(config.audioSpeed)) }),
        ...(instructions ? { instructions } : {}),
    };

    try {
        if (requestConfig.interfaceType === "async-audio") {
            return await requestAsyncAudioGeneration(requestConfig, payload, format, options);
        }
        const request = channelRequest(requestConfig, aiApiUrl(requestConfig, "/audio/speech"), aiHeaders(requestConfig));
        const response = await axios.post<Blob>(request.url, payload, { headers: request.headers, withCredentials: request.credentials === "include", responseType: "blob", signal: options?.signal });
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, "音频生成失败"));
    }
}

async function requestSunoMusicGeneration(config: AiConfig, model: string, prompt: string, options?: RequestOptions) {
    const payload = {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
    };
    try {
        const request = channelRequest(config, aiApiUrl(config, "/music"), aiHeaders(config));
        const response = await axios.post<Blob>(request.url, payload, { headers: request.headers, withCredentials: request.credentials === "include", responseType: "blob", signal: options?.signal });
        return await readSunoMusicResponse(response.data, config, options);
    } catch (error) {
        throw new Error(readAxiosError(error, "Suno 音乐生成失败"));
    }
}

async function readSunoMusicResponse(blob: Blob, config: AiConfig, options?: RequestOptions) {
    const mimeType = blob.type.toLowerCase();
    if (!mimeType.includes("json") && !mimeType.startsWith("text/")) {
        await assertAudioBlob(blob);
        return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType("mp3") });
    }
    let payload: unknown;
    try {
        payload = JSON.parse(await blob.text()) as unknown;
    } catch {
        throw new Error("Suno 音乐响应不是有效的 JSON 或音频文件");
    }
    const resultUrl = sunoMusicResultUrl(payload);
    if (!resultUrl) {
        throw new Error(sunoMusicErrorMessage(payload) || "Suno 音乐接口未返回音频地址");
    }
    if (/^data:audio\//i.test(resultUrl)) {
        const result = await fetch(resultUrl, { signal: options?.signal });
        if (!result.ok) throw new Error(`音频结果下载失败（${result.status}）`);
        const resultBlob = await result.blob();
        await assertAudioBlob(resultBlob);
        return resultBlob;
    }
    if (resultUrl.startsWith("/")) {
        const request = channelRequest(config, aiApiUrl(config, resultUrl), aiHeaders(config));
        const result = await axios.get<Blob>(request.url, { headers: request.headers, withCredentials: request.credentials === "include", responseType: "blob", signal: options?.signal });
        await assertAudioBlob(result.data);
        return result.data;
    }
    const result = await axios.get<Blob>(resultUrl, { responseType: "blob", signal: options?.signal });
    await assertAudioBlob(result.data);
    return result.data;
}

function sunoMusicResultUrl(payload: unknown): string {
    return sunoMusicResultUrlDepth(payload, 0);
}

function sunoMusicResultUrlDepth(payload: unknown, depth: number): string {
    if (depth > 8) return "";
    if (typeof payload === "string") {
        const value = payload.trim();
        return /^data:audio\//i.test(value) || /^https?:\/\//i.test(value) || value.startsWith("/") ? value : "";
    }
    if (Array.isArray(payload)) {
        for (const item of payload) {
            const result = sunoMusicResultUrlDepth(item, depth + 1);
            if (result) return result;
        }
        return "";
    }
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    for (const key of ["audio_url", "audioUrl", "music_url", "musicUrl", "song_url", "songUrl", "download_url", "downloadUrl", "file_url", "fileUrl", "result_url", "resultUrl", "output_url", "outputUrl", "url", "data"]) {
        const result = sunoMusicResultUrlDepth(record[key], depth + 1);
        if (result) return result;
    }
    for (const key of ["result", "output", "audio", "choices", "message", "content"]) {
        const result = sunoMusicResultUrlDepth(record[key], depth + 1);
        if (result) return result;
    }
    return "";
}

function sunoMusicErrorMessage(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
        const nested = record.error as Record<string, unknown>;
        if (typeof nested.message === "string" && nested.message.trim()) return nested.message.trim();
    }
    const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (["failed", "error", "cancelled", "canceled"].includes(status) || record.success === false) {
        return (typeof record.msg === "string" && record.msg.trim()) || (typeof record.message === "string" && record.message.trim()) || "上游返回失败状态";
    }
    return "";
}

function normalizeIndexTTS2Voice(value: string) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return /^voice_(?:0[1-9]|10)$/.test(normalized) ? normalized : "voice_01";
}

function normalizeIndexTTS2Format(value: string) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return ["wav", "flac", "ogg", "opus"].includes(normalized) ? normalized : "wav";
}

async function requestAsyncAudioGeneration(config: AiConfig, payload: Record<string, unknown>, format: string, options?: RequestOptions) {
    const createRequest = channelRequest(config, aiApiUrl(config, "/audio/tasks"), aiHeaders(config));
    const created = await axios.post<Record<string, unknown>>(createRequest.url, payload, { headers: createRequest.headers, withCredentials: createRequest.credentials === "include", signal: options?.signal });
    let state = asyncAudioPayload(created.data);
    const taskId = asyncAudioTaskId(state);
    if (!taskId) throw new Error("异步音频接口没有返回任务 ID");
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (asyncAudioSucceeded(state)) return downloadAsyncAudio(config, taskId, state, format, options);
        const status = String(state.status || "").toLowerCase();
        if (["failed", "cancelled", "canceled", "expired", "error"].includes(status)) {
            throw new Error(asyncAudioError(state));
        }
        await waitForAudioPoll(options?.signal);
        const pollRequest = channelRequest(config, aiApiUrl(config, `/audio/tasks/${encodeURIComponent(taskId)}`), aiHeaders(config));
        const polled = await axios.get<Record<string, unknown>>(pollRequest.url, { headers: pollRequest.headers, withCredentials: pollRequest.credentials === "include", signal: options?.signal });
        state = asyncAudioPayload(polled.data);
    }
    throw new Error(`异步音频生成超时（任务 ${taskId}）`);
}

function asyncAudioPayload(payload: Record<string, unknown>): Record<string, unknown> {
    for (const key of ["data", "result", "output"]) {
        const nested = payload[key];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) return { ...payload, ...(nested as Record<string, unknown>) };
    }
    return payload;
}

function asyncAudioTaskId(payload: Record<string, unknown>) {
    for (const value of [payload.id, payload.task_id, payload.request_id]) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

function asyncAudioSucceeded(payload: Record<string, unknown>) {
    const status = String(payload.status || "").toLowerCase();
    return payload.done === true || ["completed", "succeeded", "success", "done"].includes(status) || (!status && Boolean(asyncAudioResultUrl(payload)));
}

function asyncAudioResultUrl(payload: Record<string, unknown>): string {
    for (const key of ["audio_url", "audioUrl", "result_url", "resultUrl", "output_url", "outputUrl", "url", "data"]) {
        const value = payload[key];
        if (typeof value === "string" && (/^https?:\/\//i.test(value) || value.startsWith("data:audio/"))) return value;
    }
    for (const key of ["audio", "data", "result", "output"]) {
        const value = payload[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const nested = asyncAudioResultUrl(value as Record<string, unknown>);
            if (nested) return nested;
        }
    }
    return "";
}

async function downloadAsyncAudio(config: AiConfig, taskId: string, state: Record<string, unknown>, format: string, options?: RequestOptions) {
    const resultUrl = asyncAudioResultUrl(state);
    let blob: Blob;
    if (resultUrl.startsWith("data:audio/")) {
        blob = await (await fetch(resultUrl, { signal: options?.signal })).blob();
    } else if (/^https?:\/\//i.test(resultUrl)) {
        blob = (await axios.get<Blob>(resultUrl, { responseType: "blob", signal: options?.signal })).data;
    } else {
        const contentRequest = channelRequest(config, aiApiUrl(config, `/audio/tasks/${encodeURIComponent(taskId)}/content`), aiHeaders(config));
        blob = (await axios.get<Blob>(contentRequest.url, { headers: contentRequest.headers, withCredentials: contentRequest.credentials === "include", responseType: "blob", signal: options?.signal })).data;
    }
    await assertAudioBlob(blob);
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

function asyncAudioError(payload: Record<string, unknown>) {
    const error = payload.error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message;
    }
    return typeof payload.message === "string" && payload.message.trim() ? payload.message : "异步音频生成失败";
}

function waitForAudioPoll(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, 2500);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

async function assertAudioBlob(blob: Blob) {
    const mimeType = blob.type.toLowerCase();
    if (mimeType.startsWith("image/") || mimeType.startsWith("video/") || mimeType.startsWith("text/")) throw new Error(`上游返回了非音频内容：${mimeType}`);
    if (!mimeType.includes("json")) return;
    let payload: { code?: number; msg?: string; message?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; message?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(localizeErrorMessage(payload.msg || payload.message || payload.error?.message, "音频生成失败，请稍后重试。"));
    if (payload.error?.message) throw new Error(localizeErrorMessage(payload.error.message, "音频生成失败，请稍后重试。"));
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return localizeErrorMessage(responseData?.msg || responseData?.message || responseData?.error?.message || statusMessage(error.response?.status, fallback), fallback);
    }
    return localizeErrorMessage(error, fallback);
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
