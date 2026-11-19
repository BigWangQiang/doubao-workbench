import localforage from "localforage";
import { nanoid } from "nanoid";

import { getActiveUserScope } from "@/lib/user-scope";
import { resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, resolveResourceUrl, uploadResourceFile } from "@/services/api/resources";
import { getCachedResourceBlob, getCachedResourceObjectUrl, primeResourceBlobCache } from "@/services/resource-blob-cache";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

export { createVideoPosterBlob } from "@/lib/video-poster";

export async function readVideoMetadata(url: string, fallback = { width: 1280, height: 720 }) {
    if (!url) return fallback;
    return readVideoMeta(url, fallback);
}

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: { onProgress?: (percent: number) => void; signal?: AbortSignal; requireRemote?: boolean }): Promise<UploadedFile> {
    const userScope = getActiveUserScope();
    options?.signal?.throwIfAborted();
    const response = typeof input === "string" ? await fetch(input, { signal: options?.signal }) : undefined;
    if (response && !response.ok) throw new Error(`媒体读取失败：HTTP ${response.status}`);
    const blob = response ? await response.blob() : input as Blob;
    const previewUrl = URL.createObjectURL(blob);
    const meta: { width?: number; height?: number; durationMs?: number } = blob.type.startsWith("video/") ? await readVideoMeta(previewUrl, undefined, options?.signal) : blob.type.startsWith("audio/") ? await readAudioMeta(previewUrl) : {};
    try {
        const kind = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
        options?.signal?.throwIfAborted();
        if (userScope !== getActiveUserScope()) throw new Error("账号已切换，请重新上传");
        const resource = await uploadResourceFile(blob, kind, { ...meta, fileName: input instanceof File ? input.name : undefined, onProgress: options?.onProgress, signal: options?.signal });
        if (userScope !== getActiveUserScope()) throw new Error("账号已切换，请重新上传");
        options?.signal?.throwIfAborted();
        await primeResourceBlobCache(resourceStorageKey(resource.id), blob).catch(() => "");
        URL.revokeObjectURL(previewUrl);
        return { url: resource.publicUrl || resourceFileUrl(resource.id), storageKey: resourceStorageKey(resource.id), bytes: resource.size || blob.size, mimeType: resource.mimeType || blob.type || "application/octet-stream", width: resource.width || meta.width, height: resource.height || meta.height, durationMs: resource.durationMs || meta.durationMs };
    } catch (error) {
        if (options?.requireRemote || options?.signal?.aborted || userScope !== getActiveUserScope()) {
            URL.revokeObjectURL(previewUrl);
            throw error;
        }
        // OSS is optional during local/self-hosted setup. Keep the existing local fallback.
    }
    const storageKey = `${prefix}:${getActiveUserScope()}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = previewUrl;
    objectUrls.set(storageKey, url);
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (resourceIdFromStorageKey(storageKey)) {
        const cached = await getCachedResourceObjectUrl(storageKey).catch(() => "");
        return cached || resolveResourceUrl(storageKey, fallback);
    }
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    if (resourceIdFromStorageKey(storageKey)) return getCachedResourceBlob(storageKey);
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    if (resourceIdFromStorageKey(storageKey)) return primeResourceBlobCache(storageKey, blob);
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (resourceIdFromStorageKey(key)) return;
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const currentScope = getActiveUserScope();
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        const parts = key.split(":");
        if (parts.length >= 3 && parts[1] === currentScope && !usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.includes(":") || resourceIdFromStorageKey(value.storageKey))) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string, fallback = { width: 1280, height: 720 }, signal?: AbortSignal) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => {
            const dimensions = video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : fallback;
            const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined;
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            video.onloadedmetadata = null;
            video.onerror = null;
            video.removeAttribute("src");
            video.load();
            resolve({ ...dimensions, durationMs });
        };
        // 新上传允许取消/超时释放本地解码器；已有远程视频读取保留原等待策略。
        const timer = signal ? setTimeout(done, 3000) : undefined;
        if (signal?.aborted) { done(); return; }
        signal?.addEventListener("abort", done, { once: true });
        video.preload = "metadata";
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
