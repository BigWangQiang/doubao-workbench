import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { canvasNodeVideoPreviewReference } from "@/lib/canvas/canvas-media-preview";
import { isResourceUrl, resourceIdFromStorageKey, resourceIdFromUrl, resourceStorageKey } from "@/services/api/resources";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasVideoPreviewImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    node: CanvasNodeData;
    fallback?: ReactNode;
    loadingFallback?: ReactNode;
    eager?: boolean;
};

/**
 * Passive video poster image. Persisted posters are always resolved through
 * their resource storage key so remote media is served by OSS/CDN rather than
 * an obsolete platform proxy URL embedded in older canvas snapshots.
 */
export function CanvasVideoPreviewImage({ node, fallback = null, loadingFallback = fallback, eager = false, ...props }: CanvasVideoPreviewImageProps) {
    const preview = canvasNodeVideoPreviewReference(node);
    const videoResourceId = resourceIdFromStorageKey(node.metadata?.storageKey) || resourceIdFromUrl(node.metadata?.content);
    const previewStorageKey = preview?.storageKey || (videoResourceId ? resourceStorageKey(videoResourceId) : undefined);
    const previewSource = preview?.src || "";
    const canCaptureLocalFrame = !preview && !previewStorageKey && isLocalVideoSource(node.metadata?.content);
    if (!preview && !previewStorageKey && !canCaptureLocalFrame) return <>{fallback}</>;
    if (canCaptureLocalFrame) return <LocalVideoPoster src={node.metadata?.content || ""} eager={eager} fallback={fallback} loadingFallback={loadingFallback} {...props} />;
    return <CachedResourceImage {...props} storageKey={previewStorageKey} src={previewSource} variant={previewStorageKey ? "thumbnail" : "original"} fallback={fallback} loadingFallback={loadingFallback} eager={eager} />;
}

/**
 * A local upload/data URL has no server-side thumbnail to read. Capture only
 * its first decoded frame while the node is near the viewport, then release
 * the decoder and object URL immediately. Remote resource URLs intentionally
 * do not enter this path: their thumbnail endpoint must stay the lightweight
 * display contract and must not turn a passive canvas node into a full-video
 * download.
 */
function LocalVideoPoster({ src, eager, fallback, loadingFallback, ...props }: Omit<CanvasVideoPreviewImageProps, "node"> & { src: string }) {
    const [posterUrl, setPosterUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const objectUrlRef = useRef("");

    useEffect(() => {
        if (!eager || !src) return;
        let cancelled = false;
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.crossOrigin = "anonymous";
        setLoading(true);

        const cleanup = () => {
            video.removeEventListener("loadeddata", capture);
            video.removeEventListener("error", finish);
            video.pause();
            video.removeAttribute("src");
            video.load();
        };
        const finish = () => {
            cleanup();
            if (!cancelled) setLoading(false);
        };
        const capture = () => {
            if (cancelled || !video.videoWidth || !video.videoHeight) {
                finish();
                return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext("2d");
            if (!context) {
                finish();
                return;
            }
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
                if (cancelled || !blob) {
                    finish();
                    return;
                }
                const nextUrl = URL.createObjectURL(blob);
                objectUrlRef.current = nextUrl;
                setPosterUrl(nextUrl);
                finish();
            }, "image/jpeg", 0.84);
        };

        video.addEventListener("loadeddata", capture, { once: true });
        video.addEventListener("error", finish, { once: true });
        video.src = src;
        video.load();
        return () => {
            cancelled = true;
            cleanup();
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = "";
        };
    }, [eager, src]);

    if (posterUrl) return <img {...props} src={posterUrl} />;
    return <>{loading ? loadingFallback : fallback}</>;
}

function isLocalVideoSource(source?: string) {
    const value = String(source || "").trim();
    if (!value || isResourceUrl(value)) return false;
    return /^(?:blob:|data:|file:)/i.test(value);
}
