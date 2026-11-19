import { saveAs } from "file-saver";

import { getResource, getResourceBlob, isResourceUrl, resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";

type DownloadMediaInput = {
    url: string;
    fileName: string;
    storageKey?: string;
    kind?: "image" | "video" | "audio" | "file";
};

export async function downloadMediaFile({ url, fileName, storageKey, kind }: DownloadMediaInput) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    let storedBlob: Blob | null = null;
    if (storageKey) {
        try {
            storedBlob = await readStoredBlob(storageKey, kind);
        } catch (error) {
            if (resourceId) {
                // Validate ownership/status first, then let the browser handle
                // the authenticated same-origin response. This avoids turning
                // a proxy stream/CORS hiccup into a false "Failed to fetch".
                const resource = await getResource(resourceId);
                if (resource.status !== "ready") throw new Error("当前媒体尚未准备完成");
                saveAs(resourceFileUrl(resourceId), fileName);
                return;
            }
            throw error;
        }
    }
    if (!storedBlob && resourceId) {
        const resource = await getResource(resourceId);
        if (resource.status !== "ready") throw new Error("当前媒体尚未准备完成");
        saveAs(resourceFileUrl(resourceId), fileName);
        return;
    }
    const blob = storedBlob || await fetchDownloadBlob(url);
    saveAs(blob, fileName);
}

async function readStoredBlob(storageKey: string, kind?: DownloadMediaInput["kind"]) {
    if (resourceIdFromStorageKey(storageKey)) return getResourceBlob(storageKey);
    if (kind === "image" || storageKey.startsWith("image:")) return getImageBlob(storageKey);
    return getMediaBlob(storageKey);
}

async function fetchDownloadBlob(url: string) {
    if (!url) throw new Error("当前媒体没有可下载的文件");
    let response: Response;
    try {
        response = await fetch(url, { credentials: isResourceUrl(url) ? "include" : "same-origin" });
    } catch {
        throw new Error("媒体文件下载失败，请稍后重试");
    }
    if (!response.ok) throw new Error(`媒体文件下载失败（${response.status}）`);
    return response.blob();
}
