import localforage from "localforage";

import { getActiveUserScope } from "@/lib/user-scope";
import { getResource, getResourceBlob, resourceIdFromStorageKey, resourceThumbnailUrl, type RemoteResource } from "@/services/api/resources";

type ResourceCacheMeta = {
    variant?: "original" | "thumbnail";
    key: string;
    userScope: string;
    resourceId: string;
    version: string;
    size: number;
    mimeType: string;
    lastAccessedAt: number;
};

const blobStore = localforage.createInstance({ name: "infinite-canvas", storeName: "resource_blobs" });
const metaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "resource_blob_meta" });
const objectUrls = new Map<string, string>();
const sessionTargets = new Map<string, ResourceCacheMeta>();
const sessionBlobs = new Map<string, Blob>();
const inFlight = new Map<string, Promise<string>>();
const downloadQueue: Array<() => void> = [];
let activeDownloads = 0;
let persistQueue: Promise<void> = Promise.resolve();
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const FALLBACK_CACHE_BYTES = 512 * 1024 * 1024;
const MIN_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_DOWNLOADS = 4;

/** 只返回本用户本次会话已经验证并加载的资源，供节点重新进入视口时同步复用。 */
export function getLoadedResourceObjectUrl(storageKey: string, variant: "original" | "thumbnail" = "original") {
    const resourceId = resourceIdFromStorageKey(storageKey);
    const target = sessionTargets.get(`${getActiveUserScope()}:${resourceId}:${variant}`);
    return target ? objectUrls.get(target.key) || "" : "";
}

export async function getCachedResourceObjectUrl(storageKey: string, variant: "original" | "thumbnail" = "original") {
    const target = await cacheTarget(storageKey, variant);
    if (!target) return "";
    return readCachedObjectUrl(target);
}

export async function cacheResourceObjectUrl(storageKey: string, variant: "original" | "thumbnail" = "original") {
    const target = await cacheTarget(storageKey, variant);
    if (!target) return "";
    const cached = await readCachedObjectUrl(target);
    if (cached) return cached;
    const pending = inFlight.get(target.key);
    if (pending) return pending;

    const task = withDownloadSlot(() => downloadAndCacheResource(storageKey, target), variant === "thumbnail").finally(() => inFlight.delete(target.key));
    inFlight.set(target.key, task);
    return task;
}

function withDownloadSlot<T>(task: () => Promise<T>, priority = false) {
    return new Promise<T>((resolve, reject) => {
        const start = () => {
            activeDownloads += 1;
            task().then(resolve, reject).finally(() => {
                activeDownloads -= 1;
                runDownloadQueue();
            });
        };
        // 当前可见的缩略图优先于尚未开始下载的原图，下载总并发仍保持上限。
        if (priority) downloadQueue.unshift(start);
        else downloadQueue.push(start);
        runDownloadQueue();
    });
}

function runDownloadQueue() {
    while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) downloadQueue.shift()?.();
}

export async function primeResourceBlobCache(storageKey: string, blob: Blob) {
    const target = await cacheTarget(storageKey);
    if (!target) return "";
    sessionBlobs.set(target.key, blob);
    const url = objectUrl(target.key, blob);
    if (blob.size <= MAX_CACHE_BYTES) void enqueuePersist(target, blob);
    return url;
}

export async function getCachedResourceBlob(storageKey: string) {
    const target = await cacheTarget(storageKey);
    if (!target) return null;
    const cached = await blobStore.getItem<Blob>(target.key);
    if (cached) {
        void touchCacheMeta(target).catch(() => undefined);
        return cached;
    }
    const sessionBlob = sessionBlobs.get(target.key);
    if (sessionBlob) return sessionBlob;
    const pending = inFlight.get(target.key);
    if (pending) {
        await pending;
        return sessionBlobs.get(target.key) || blobStore.getItem<Blob>(target.key);
    }
    await cacheResourceObjectUrl(storageKey);
    return sessionBlobs.get(target.key) || blobStore.getItem<Blob>(target.key);
}

async function downloadAndCacheResource(storageKey: string, target: ResourceCacheMeta) {
    const blob = await downloadResourceBlob(storageKey, target);
    if (!blob) return "";
    return objectUrl(target.key, blob);
}

async function downloadResourceBlob(storageKey: string, target: ResourceCacheMeta) {
    let blob: Blob | null;
    if (target.variant === "thumbnail") {
        // 资产列表只缓存缩略图，避免打开上百项时下载全部原图挤占网络和内存。
        const response = await fetch(resourceThumbnailUrl(target.resourceId), { credentials: "include" });
        if (!response.ok) throw new Error("缩略图加载失败");
        blob = await response.blob();
        if (!blob.type.startsWith("image/")) throw new Error("缩略图格式无效");
    } else {
        blob = await getResourceBlob(storageKey);
    }
    if (!blob) return null;
    sessionBlobs.set(target.key, blob);
    // 图片可显示后立即返回；索引清理和磁盘写入不阻塞当前帧及后面的下载队列。
    if (blob.size <= MAX_CACHE_BYTES) void enqueuePersist(target, blob);
    return blob;
}

function enqueuePersist(target: ResourceCacheMeta, blob: Blob) {
    const task = persistQueue.then(() => persistBlob(target, blob));
    persistQueue = task.catch(() => undefined);
    return task.catch(() => undefined);
}

async function persistBlob(target: ResourceCacheMeta, blob: Blob) {
    // 不尝试写入超过当前缓存预算的单个媒体，避免触发浏览器配额异常和无效的全量淘汰。
    if (blob.size > (await cacheBudget())) return;
    await evictFor(blob.size, target.key);
    try {
        await blobStore.setItem(target.key, blob);
        await metaStore.setItem(target.key, { ...target, size: blob.size, mimeType: blob.type || target.mimeType, lastAccessedAt: Date.now() });
    } catch (error) {
        await evictFor(blob.size, target.key, true);
        try {
            await blobStore.setItem(target.key, blob);
            await metaStore.setItem(target.key, { ...target, size: blob.size, mimeType: blob.type || target.mimeType, lastAccessedAt: Date.now() });
        } catch {
            await blobStore.removeItem(target.key);
            await metaStore.removeItem(target.key);
            throw error;
        }
    }
}

async function readCachedObjectUrl(target: ResourceCacheMeta) {
    const existing = objectUrls.get(target.key);
    if (existing) {
        void touchCacheMeta(target).catch(() => undefined);
        return existing;
    }
    const blob = await blobStore.getItem<Blob>(target.key);
    if (!blob) return "";
    void touchCacheMeta(target).catch(() => undefined);
    return objectUrl(target.key, blob);
}

async function cacheTarget(storageKey: string, variant: "original" | "thumbnail" = "original"): Promise<ResourceCacheMeta | null> {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return null;
    const resource = await getResource(resourceId);
    const userScope = getActiveUserScope();
    if (userScope === "guest" || resource.userId !== userScope) throw new Error("当前用户不能读取该媒体缓存");
    const version = resourceVersion(resource);
    const target: ResourceCacheMeta = {
        key: `${userScope}:${resourceId}:${version}${variant === "thumbnail" ? ":thumbnail" : ""}`,
        variant,
        userScope,
        resourceId,
        version,
        size: resource.size || 0,
        mimeType: resource.mimeType || "application/octet-stream",
        lastAccessedAt: Date.now(),
    };
    sessionTargets.set(`${userScope}:${resourceId}:${variant}`, target);
    return target;
}

function resourceVersion(resource: RemoteResource) {
    return (resource.etag || `${resource.size}:${resource.updatedAt}`).replace(/[^a-zA-Z0-9:._-]/g, "_");
}

async function touchCacheMeta(target: ResourceCacheMeta) {
    const current = await metaStore.getItem<ResourceCacheMeta>(target.key);
    if (!current || Date.now() - current.lastAccessedAt < TOUCH_INTERVAL_MS) return;
    await metaStore.setItem(target.key, { ...current, lastAccessedAt: Date.now() });
}

async function evictFor(incomingBytes: number, protectedKey: string, aggressive = false) {
    const metas: ResourceCacheMeta[] = [];
    await metaStore.iterate<ResourceCacheMeta, void>((value) => {
        if (value?.key) metas.push(value);
    });
    const budget = aggressive ? Math.max(MIN_CACHE_BYTES, (await cacheBudget()) / 2) : await cacheBudget();
    let total = metas.reduce((sum, item) => sum + Math.max(0, item.size || 0), 0);
    let count = metas.length;
    // 当前页面正在使用的 Blob URL 不能在 LRU 清理时撤销，否则已渲染节点会立即变成失效资源。
    const candidates = metas.filter((item) => item.key !== protectedKey && !objectUrls.has(item.key) && !sessionBlobs.has(item.key)).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (const candidate of candidates) {
        if (total + incomingBytes <= budget && count < MAX_CACHE_ENTRIES) break;
        await removeCacheEntry(candidate);
        total -= Math.max(0, candidate.size || 0);
        count -= 1;
    }
}

async function removeCacheEntry(meta: ResourceCacheMeta) {
    const url = objectUrls.get(meta.key);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(meta.key);
    sessionBlobs.delete(meta.key);
    await Promise.all([blobStore.removeItem(meta.key), metaStore.removeItem(meta.key)]);
}

async function cacheBudget() {
    if (!navigator.storage?.estimate) return FALLBACK_CACHE_BYTES;
    const estimate = await navigator.storage.estimate().catch(() => null);
    if (!estimate?.quota) return FALLBACK_CACHE_BYTES;
    return Math.min(MAX_CACHE_BYTES, Math.max(MIN_CACHE_BYTES, Math.floor(estimate.quota * 0.2)));
}

function objectUrl(key: string, blob: Blob) {
    const existing = objectUrls.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    objectUrls.set(key, url);
    return url;
}

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", (event) => {
        if (event.persisted) return;
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
        objectUrls.clear();
        sessionTargets.clear();
        sessionBlobs.clear();
    });
}
