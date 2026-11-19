import { nanoid } from "nanoid";

import { getActiveUserScope } from "@/lib/user-scope";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { getLoadedResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";

export type CanvasMediaUploadSnapshot = {
    previewUrl: string;
    progress: number;
    status: "uploading" | "saving" | "ready" | "failed";
    error?: string;
};

type Upload = {
    userScope: string;
    snapshot: CanvasMediaUploadSnapshot;
    controller: AbortController;
    result: Promise<UploadedFile>;
};

// 不向画布快照写入 blob URL；刷新后缺失的会话必须明确失败，不能被当作空参考图跳过。
const uploads = new Map<string, Upload>();
const listeners = new Map<string, Set<() => void>>();
// 仅记住解码成功的缓存地址；Blob 生命周期仍由资源缓存管理，超时不启用本地替换。
const decodedImageUrls = new Map<string, string>();

export function getCanvasUploadedImageUrl(storageKey: string) {
    const key = `${getActiveUserScope()}:${storageKey}`;
    const url = decodedImageUrls.get(key);
    if (url && url === getLoadedResourceObjectUrl(storageKey)) return url;
    decodedImageUrls.delete(key);
    return "";
}

export function forgetCanvasUploadedImageUrl(storageKey: string) {
    decodedImageUrls.delete(`${getActiveUserScope()}:${storageKey}`);
}

export function getCanvasMediaUpload(id: string) {
    const upload = uploads.get(id);
    return upload?.userScope === getActiveUserScope() ? upload.snapshot : undefined;
}

export function subscribeCanvasMediaUpload(id: string, listener: () => void) {
    const subscribers = listeners.get(id) || new Set<() => void>();
    subscribers.add(listener);
    listeners.set(id, subscribers);
    return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(id);
    };
}

function notify(id: string) {
    listeners.get(id)?.forEach((listener) => listener());
}

export function startCanvasMediaUpload(file: File) {
    const id = nanoid();
    const controller = new AbortController();
    const userScope = getActiveUserScope();
    const previewUrl = URL.createObjectURL(file);
    const update = (patch: Partial<CanvasMediaUploadSnapshot>) => {
        const upload = uploads.get(id);
        if (!upload) return;
        upload.snapshot = { ...upload.snapshot, ...patch };
        notify(id);
    };
    const result = Promise.resolve().then(async () => {
        const options = {
            requireRemote: true,
            signal: controller.signal,
            onProgress: (value: number) => {
                if (!Number.isFinite(value)) return;
                const progress = Math.max(uploads.get(id)?.snapshot.progress || 0, Math.min(100, Math.max(0, value)));
                update({ progress, status: progress === 100 ? "saving" : "uploading" });
            },
        };
        const media = file.type.startsWith("image/") ? await uploadImage(file, options) : await uploadMediaFile(file, "video", options);
        controller.signal.throwIfAborted();
        if (userScope !== getActiveUserScope()) throw new Error("账号已切换，请重新上传");
        if (!resourceIdFromStorageKey(media.storageKey)) throw new Error("素材尚未保存到服务器，请重新上传");
        // 1.5 秒仅限制预览解码等待，不限制文件上传，也不把上传进度当作保存回执。
        const imageUrl = file.type.startsWith("image/") ? getLoadedResourceObjectUrl(media.storageKey) : "";
        const decoded = imageUrl ? await decodePreview(imageUrl) : false;
        controller.signal.throwIfAborted();
        if (userScope !== getActiveUserScope()) throw new Error("账号已切换，请重新上传");
        if (decoded) {
            decodedImageUrls.set(`${userScope}:${media.storageKey}`, imageUrl);
            if (decodedImageUrls.size > 500) decodedImageUrls.delete(decodedImageUrls.keys().next().value!);
        }
        update({ status: "ready", progress: 100 });
        return media;
    }).catch((error: unknown) => {
        update({ status: "failed", error: error instanceof Error ? error.message : "素材上传失败，请重新上传" });
        throw error;
    });
    // 上传组件与生成等待分别订阅同一个结果；未点击生成时也不产生未处理的拒绝。
    void result.catch(() => undefined);
    uploads.set(id, { userScope, snapshot: { previewUrl, progress: 0, status: "uploading" }, controller, result });
    return { id, result };
}

export function waitForCanvasMediaUpload(id: string, signal?: AbortSignal): Promise<UploadedFile> {
    const upload = uploads.get(id);
    if (!upload || upload.userScope !== getActiveUserScope()) return Promise.reject(new Error("素材上传已中断，请重新选择文件上传后再生成"));
    return new Promise((resolve, reject) => {
        const cancel = () => { cleanup(); reject(new DOMException("请求已取消", "AbortError")); };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        if (signal?.aborted) { cancel(); return; }
        signal?.addEventListener("abort", cancel, { once: true });
        upload.result.then((result) => {
            cleanup();
            if (upload.userScope !== getActiveUserScope()) reject(new Error("账号已切换，请重新生成"));
            else resolve(result);
        }, (error) => { cleanup(); reject(error); });
    });
}

export function releaseCanvasMediaUpload(id: string) {
    const upload = uploads.get(id);
    if (!upload) return;
    upload.controller.abort();
    URL.revokeObjectURL(upload.snapshot.previewUrl);
    uploads.delete(id);
    notify(id);
}

function decodePreview(url: string) {
    return new Promise<boolean>((resolve) => {
        const image = new Image();
        const finish = (decoded: boolean) => { clearTimeout(timer); resolve(decoded); };
        const timer = setTimeout(() => finish(false), 1500);
        image.onload = () => finish(true);
        image.onerror = () => finish(false);
        image.src = url;
        if (typeof image.decode === "function") void image.decode().then(() => finish(true), () => finish(false));
    });
}
