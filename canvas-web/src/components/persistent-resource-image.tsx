import { useEffect, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

import { useImageReveal } from "@/hooks/use-image-reveal";
import { resourceIdFromStorageKey, resourceIdFromUrl, resourceStorageKey, resourceThumbnailUrl } from "@/services/api/resources";
import { cacheResourceObjectUrl, getCachedResourceObjectUrl, getLoadedResourceObjectUrl } from "@/services/resource-blob-cache";
import { useUserStore } from "@/stores/use-user-store";

type PersistentResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    src: string;
    storageKey?: string;
    thumbnail?: boolean;
    reveal?: boolean;
};

type CachedSource = {
    key: string;
    url: string;
};

export function PersistentResourceImage({ src, storageKey, thumbnail = false, reveal = false, loading, decoding = "async", onError, ...props }: PersistentResourceImageProps) {
    const userId = useUserStore((state) => state.user?.id || "guest");
    const resourceId = resourceIdFromStorageKey(storageKey) || resourceIdFromUrl(src);
    const variant = thumbnail ? "thumbnail" : "original";
    const sourceKey = `${userId}:${resourceId || src}:${variant}`;
    const fallbackUrl = resourceId ? resourceThumbnailUrl(resourceId) : src;
    const [cachedSource, setCachedSource] = useState<CachedSource | null>(null);
    const [visible, setVisible] = useState(loading !== "lazy");
    const loadedUrl = resourceId && userId !== "guest" ? getLoadedResourceObjectUrl(resourceStorageKey(resourceId), variant) : "";
    const displayedUrl = cachedSource?.key === sourceKey ? cachedSource.url : loadedUrl || (thumbnail && resourceId && userId !== "guest" ? undefined : fallbackUrl);
    const { imageRef, revealPhase } = useImageReveal({
        identity: resourceId ? resourceStorageKey(resourceId) : src,
        src: displayedUrl,
        enabled: reveal,
        waitingForOriginal: Boolean(resourceId && userId !== "guest" && !loadedUrl && cachedSource?.key !== sourceKey),
    });

    useEffect(() => {
        if (visible || !imageRef.current) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
        }, { rootMargin: "160px" });
        observer.observe(imageRef.current);
        return () => observer.disconnect();
    }, [visible]);

    useEffect(() => {
        if (!resourceId || userId === "guest" || !visible) return;
        let active = true;
        const storageKey = resourceStorageKey(resourceId);

        void getCachedResourceObjectUrl(storageKey, variant)
            .then((cachedUrl) => cachedUrl || cacheResourceObjectUrl(storageKey, variant))
            .then((cachedUrl) => {
                if (active && cachedUrl) setCachedSource({ key: sourceKey, url: cachedUrl });
            })
            .catch(() => { if (active) setCachedSource({ key: sourceKey, url: fallbackUrl }); });

        return () => {
            active = false;
        };
    }, [resourceId, sourceKey, userId, variant, visible, fallbackUrl]);

    const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
        if (displayedUrl !== fallbackUrl) {
            setCachedSource({ key: sourceKey, url: fallbackUrl });
            return;
        }
        onError?.(event);
    };

    return <img {...props} ref={imageRef} src={displayedUrl} data-image-reveal={revealPhase} loading={loading} decoding={decoding} onError={handleError} />;
}
