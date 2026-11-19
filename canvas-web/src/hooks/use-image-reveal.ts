import { useEffect, useRef, useState } from "react";

import { useUserStore } from "@/stores/use-user-store";
import "@/styles/image-reveal.css";

// 只记本次会话已看过的资源身份，不保存图片或鉴权地址到持久化存储。
const revealedImages = new Set<string>();
const MAX_REVEALED_IMAGES = 512;
useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) revealedImages.clear();
});

type ImageRevealOptions = {
    identity: string;
    src?: string;
    enabled?: boolean;
    waitingForOriginal?: boolean;
};

/** 有真实图像后才渐显；缩略图可先保持磨砂，正式图加载/解码完成再变清晰。 */
export function useImageReveal({ identity, src, enabled = true, waitingForOriginal = false }: ImageRevealOptions) {
    const userId = useUserStore((state) => state.user?.id || "guest");
    const key = `${userId}:${identity}`;
    const imageRef = useRef<HTMLImageElement>(null);
    const [revealedKey, setRevealedKey] = useState(() => revealedImages.has(key) ? key : "");
    const revealed = revealedKey === key || revealedImages.has(key);

    useEffect(() => {
        const image = imageRef.current;
        if (!enabled || !src || !image || waitingForOriginal || revealed) return;
        let cancelled = false;
        let decoding = false;
        let firstFrame = 0;
        let secondFrame = 0;
        const reveal = async () => {
            if (decoding || !image.complete || image.naturalWidth === 0) return;
            decoding = true;
            try {
                if (image.decode) await image.decode();
            } catch {
                // 部分浏览器 decode() 拒绝，但 load 成功的图片仍可正常显示。
                if (!image.complete || image.naturalWidth === 0) return;
            }
            if (cancelled) return;
            // 让浏览器先绘制磨砂态；不用定时器假装下载进度，也不阻止用户操作。
            firstFrame = requestAnimationFrame(() => {
                secondFrame = requestAnimationFrame(() => {
                    if (cancelled) return;
                    revealedImages.add(key);
                    if (revealedImages.size > MAX_REVEALED_IMAGES) {
                        const oldest = revealedImages.values().next().value;
                        if (oldest) revealedImages.delete(oldest);
                    }
                    setRevealedKey(key);
                });
            });
        };
        image.addEventListener("load", reveal);
        if (image.complete) void reveal();
        return () => {
            cancelled = true;
            image.removeEventListener("load", reveal);
            cancelAnimationFrame(firstFrame);
            cancelAnimationFrame(secondFrame);
        };
    }, [enabled, key, revealed, src, waitingForOriginal]);

    return { imageRef, revealPhase: enabled ? revealed ? "revealed" as const : "waiting" as const : undefined };
}
