/** 本地视频按需解码首帧；不重下完整文件，超时或退出时释放解码器。 */
export function createVideoPosterBlob(source: Blob | string, signal?: AbortSignal): Promise<Blob> {
    return new Promise<Blob>((resolve, reject): void => {
        const objectUrl = source instanceof Blob ? URL.createObjectURL(source) : undefined;
        const video = document.createElement('video');
        let settled = false;
        const finish = (blob?: Blob, error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.pause();
            video.removeAttribute('src');
            video.load();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            if (blob) resolve(blob);
            else reject(error || new Error('视频首帧读取失败'));
        };
        const abort = (): void => finish(undefined, new DOMException('首帧读取已取消', 'AbortError'));
        const capture = (): void => {
            if (settled) return;
            if (!video.videoWidth || !video.videoHeight) { finish(); return; }
            const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            try {
                const context = canvas.getContext('2d');
                if (!context) { finish(); return; }
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob): void => finish(blob || undefined), 'image/jpeg', 0.84);
            } catch { finish(undefined, new Error('视频首帧无法转换为图片')); }
        };
        const timer = setTimeout((): void => finish(undefined, new Error('视频首帧读取超时')), 10_000);
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        video.onloadeddata = (): void => {
            // 跳过容器起点，取最靠前的可解码画面，避免只有元数据时抓到黑帧。
            const position = Number.isFinite(video.duration) ? Math.min(0.1, video.duration / 2) : 0;
            if (position > 0) { video.onseeked = capture; video.currentTime = position; }
            else capture();
        };
        video.onerror = (): void => finish(undefined, new Error(`视频解码失败（${video.error?.code || '未知'}）`));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        video.src = objectUrl || String(source);
    });
}
