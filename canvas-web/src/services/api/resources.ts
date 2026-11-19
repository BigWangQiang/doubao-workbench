import { getActiveUserScope } from "@/lib/user-scope";
import { localResourceUrl, localResourceAccess } from "@desktop/resources";
import axios from "axios";
import { apiBaseURL, apiClient, request, type BackendEnvelope } from "@/services/api/request";
import { localizeErrorMessage } from "@/lib/generation-error";

export type RemoteResource = {
    id: string;
    userId: string;
    kind: "image" | "video" | "audio" | "file" | string;
    status: "pending" | "ready" | "failed" | "deleted" | string;
    provider: string;
    endpoint: string;
    bucket: string;
    objectKey: string;
    publicUrl: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    durationMs?: number;
    etag?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
};

export type UserOSSSetting = {
    enabled: boolean;
    provider: "aliyun" | "s3";
    region: string;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    hasAccessKeyId: boolean;
    hasAccessKeySecret: boolean;
    publicBaseUrl: string;
    pathPrefix: string;
    updatedAt?: string;
};

export type UserOSSSettingInput = Pick<UserOSSSetting, "enabled" | "provider" | "region" | "endpoint" | "bucket" | "accessKeyId" | "pathPrefix"> & {
    accessKeySecret?: string;
};

export type ResourceAccessPurpose = "display" | "copy" | "download" | "browser-process" | "provider-input";
export type ResourceAccessVariant = "original" | "playback" | "thumbnail";
export type ResourceAccess = {
    resourceId: string;
    requestedVariant: ResourceAccessVariant;
    actualVariant: ResourceAccessVariant;
    url: string;
    delivery: "platform-local" | "platform-proxy" | "origin" | "cdn";
    issuedAt: string;
    expiresAt?: string;
    refreshAt: string;
    revision: string;
    originalWidth?: number;
    originalHeight?: number;
};

export type ResourcePlaybackStatus = "none" | "processing" | "ready" | "failed";

const api = apiClient;
const resourceCache = new Map<string, RemoteResource>();
const resourceRequests = new Map<string, Promise<RemoteResource>>();
const missingResourceIds = new Set<string>();

export function resourceStorageKey(id: string) {
    return `resource:${id}`;
}

export function getUserOSSSetting() {
    return request<{ setting: UserOSSSetting }>(api.get("/settings/oss"));
}

export function updateUserOSSSetting(input: UserOSSSettingInput) {
    return request<{ setting: UserOSSSetting }>(api.patch("/settings/oss", input));
}

export function resourceIdFromStorageKey(storageKey?: string) {
    return storageKey?.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
}

/** Extract a resource id from the stable /resources/:id/file URL used in synced data. */
export function resourceIdFromUrl(url?: string) {
    const value = String(url || "").trim();
    if (!value) return "";
    const path = value.split(/[?#]/, 1)[0];
    const match = path.match(/(?:^|\/)resources\/([^/]+)\/file$/);
    if (!match?.[1]) return "";
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

export function isResourceUrl(url?: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    const path = url?.split(/[?#]/, 1)[0] || "";
    return path.startsWith(`${base}/resources/`) && path.endsWith("/file");
}

export async function uploadResourceFile(file: Blob, kind: "image" | "video" | "audio" | "file", meta?: { width?: number; height?: number; durationMs?: number; fileName?: string; onProgress?: (percent: number) => void; signal?: AbortSignal }) {
    const formData = new FormData();
    const name = meta?.fileName || (file instanceof File ? file.name : `${kind}.${extensionFromMime(file.type, kind)}`);
    formData.append("kind", kind);
    formData.append("file", file, name);
    if (meta?.width) formData.append("width", String(Math.round(meta.width)));
    if (meta?.height) formData.append("height", String(Math.round(meta.height)));
    if (meta?.durationMs) formData.append("durationMs", String(Math.round(meta.durationMs)));
    const data = await request<{ resource: RemoteResource }>(api.post("/resources", formData, {
        signal: meta?.signal,
        onUploadProgress: (event) => {
            if (event.total) meta?.onProgress?.(Math.round((event.loaded / event.total) * 100));
        },
    }));
    // 字节传输完成不代表资源可用，必须收到服务端持久化完成的回执。
    if (!data.resource?.id?.trim() || data.resource.status !== "ready") throw new Error("服务器尚未确认资源保存完成，请重新上传");
    resourceCache.set(resourceCacheKey(data.resource.id), data.resource);
    return data.resource;
}

export async function importResourceFromUrl(url: string, kind: "image" | "video" | "audio" | "file", meta?: { width?: number; height?: number; durationMs?: number; signal?: AbortSignal }) {
    const data = await request<{ resource: RemoteResource }>(api.post("/resources/import", { url, kind, width: meta?.width, height: meta?.height, durationMs: meta?.durationMs }, { signal: meta?.signal }));
    resourceCache.set(resourceCacheKey(data.resource.id), data.resource);
    return data.resource;
}

export type PlatformVideoImport = {
    resource: RemoteResource;
    title: string;
    platform: string;
    sourceUrl: string;
};

export function importPlatformVideoUrl(url: string) {
    return request<PlatformVideoImport>(api.post("/resources/import-platform-video", { url }));
}

export function getResource(id: string): Promise<RemoteResource> {
    const cacheKey = resourceCacheKey(id);
    const cached = resourceCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    if (missingResourceIds.has(cacheKey)) return Promise.reject(new Error("资源不存在或已被删除"));
    const pending = resourceRequests.get(cacheKey);
    if (pending) return pending;
    const task = request<{ resource: RemoteResource }>(api.get(`/resources/${encodeURIComponent(id)}`))
        .then((data) => {
            resourceCache.set(cacheKey, data.resource);
            return data.resource;
        })
        .catch((error) => {
            if (axios.isAxiosError(error) && error.response?.status === 404) missingResourceIds.add(cacheKey);
            throw error;
        })
        .finally(() => resourceRequests.delete(cacheKey));
    resourceRequests.set(cacheKey, task);
    return task;
}

export async function getResourcePlaybackStatus(id: string): Promise<ResourcePlaybackStatus> {
    const data = await request<{ status: ResourcePlaybackStatus }>(api.get(`/resources/${encodeURIComponent(id)}/playback/status`));
    return data.status;
}

/**
 * 兼容编辑器预览的资源刷新合同，同时返回独立播放变体的真实状态。
 * 播放变体是可重建缓存，不改变原视频资源和任务结果。
 */
export async function refreshResource(id: string): Promise<RemoteResource & { playbackStatus: ResourcePlaybackStatus }> {
    const resource = await getResource(id);
    const playbackStatus = resource.kind === "video" ? await getResourcePlaybackStatus(id).catch(() => "none" as ResourcePlaybackStatus) : "none";
    return {
        ...resource,
        playbackStatus: resource.status === "failed" ? "failed" : playbackStatus,
    };
}

export async function getResourceOSSUrl(storageKey?: string) {
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) throw new Error("当前媒体尚未上传到后端资源存储");
    try {
        const data = await request<{ url: string }>(api.get(`/resources/${encodeURIComponent(id)}/oss-url`));
        if (!data.url) throw new Error("后端未返回 OSS 地址");
        return data.url;
    } catch (error) {
        if (axios.isAxiosError<BackendEnvelope<unknown>>(error)) throw new Error(localizeErrorMessage(error.response?.data.msg || error.message, "获取 OSS 地址失败"));
        throw new Error(localizeErrorMessage(error, "获取 OSS 地址失败"));
    }
}

/** Resolve owned media through the authenticated resource routes. Thumbnail
 * requests must stay on the JPEG endpoint; silently substituting the original
 * file would make a passive canvas preview download a full video.
 */
export async function getResourceAccess(
    storageKey: string | undefined,
    purpose: ResourceAccessPurpose = "display",
    variant: ResourceAccessVariant = "original",
    _downloadName = "",
): Promise<ResourceAccess> {
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) throw new Error("当前媒体尚未上传到后端资源存储");
    const resource = await getResource(id);
    const now = new Date();
    const revision = resource.updatedAt || resource.etag || resource.id;
    return {
        resourceId: id,
        requestedVariant: variant,
        ...await localResourceAccess(resource, variant),
        delivery: "platform-local",
        issuedAt: now.toISOString(),
        refreshAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        revision,
        originalWidth: resource.width,
        originalHeight: resource.height,
    };
}

export async function getResourceInputURL(storageKey?: string) {
    return (await getResourceAccess(storageKey, "provider-input")).url;
}

export function resolveResourceAccessURL(url: string) {
    if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url;
    const base = String(apiBaseURL).trim();
    if (!/^https?:\/\//i.test(base)) return url;
    return new URL(url, `${base.replace(/\/+$/, "")}/`).toString();
}

export function playbackVariantUrl(id: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    return `${base}/resources/${encodeURIComponent(id)}/playback/master.m3u8`;
}

function resourceCacheKey(id: string) {
    return `${getActiveUserScope()}:${id}`;
}

export function resourceFileUrl(id: string, options?: { direct?: boolean }) {
    return localResourceUrl(id);
}

/** Stable, authenticated preview image used by media grids. */
export function resourceThumbnailUrl(id: string, width = 640) {
    return localResourceUrl(id);
}

function resourceProxyFileUrl(id: string) {
    return localResourceUrl(id);
}

export async function resolveResourceUrl(storageKey?: string, fallback = "") {
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) return fallback;
    const resource = await getResource(id).catch(() => null);
    return resource ? resource.publicUrl || resourceFileUrl(id) : fallback;
}

export async function getResourceBlob(storageKey: string) {
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) return null;
    const url = resourceProxyFileUrl(id);
    let lastError: unknown;
    // A large OSS-backed video can briefly reset while the authenticated
    // same-origin proxy is opening its upstream stream. Retry the proxy before
    // allowing the caller to use its browser-native download fallback.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(url, {
                credentials: isResourceUrl(url) ? "include" : "same-origin",
                cache: "no-store",
            });
            if (!response.ok) {
                // Ownership/auth and missing-resource responses are terminal;
                // retrying them only delays the caller's clear error path.
                if (response.status < 500 && response.status !== 429) return null;
                throw new Error(`资源读取失败（${response.status}）`);
            }
            return await response.blob();
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    throw lastError instanceof Error ? lastError : new Error("资源读取失败，请稍后重试");
}

function extensionFromMime(mimeType: string, kind: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    return kind === "image" ? "png" : "bin";
}
