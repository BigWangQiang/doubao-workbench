const VIDEO_FRAME_ANALYSIS_TIMEOUT_MS = 30_000;
const LAST_FRAME_EPSILON_SECONDS = 0.001;
const DEFAULT_MAX_FRAME_WIDTH = 1280;

export type CanvasVideoFrameSample = {
    id: string;
    timeSeconds: number;
    sourceDurationSeconds: number;
    width: number;
    height: number;
    blob: Blob;
};

export type CanvasVideoFrameShotRange = {
    frameId: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
};

export function buildVideoFrameSampleTimes(durationSeconds: number, intervalSeconds: number, maxFrames: number) {
    const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    const interval = Number.isFinite(intervalSeconds) ? Math.max(0.25, intervalSeconds) : 2;
    const limit = Math.max(2, Math.min(60, Math.floor(maxFrames)));
    const end = Math.max(0, duration - LAST_FRAME_EPSILON_SECONDS);
    if (end <= 0) return [0];

    const requestedCount = Math.floor(end / interval) + 2;
    if (requestedCount > limit) {
        return Array.from({ length: limit }, (_, index) => Number(((end * index) / (limit - 1)).toFixed(3)));
    }

    const times: number[] = [];
    for (let time = 0; time < end; time += interval) times.push(Number(time.toFixed(3)));
    if (!times.length || Math.abs(times[times.length - 1] - end) > 0.01) times.push(Number(end.toFixed(3)));
    return times;
}

export async function captureVideoFrameSamples(source: Blob | string, intervalSeconds: number, maxFrames: number, signal?: AbortSignal): Promise<CanvasVideoFrameSample[]> {
    const blob = await readVideoBlob(source, signal);
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    try {
        const loaded = waitForVideoEvent(video, "loadeddata", "视频读取超时或编码不受浏览器支持", signal);
        video.src = objectUrl;
        video.load();
        await loaded;
        throwIfAborted(signal);
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("无法确定视频时长");
        if (!video.videoWidth || !video.videoHeight) throw new Error("无法读取视频画面尺寸");

        const scale = Math.min(1, DEFAULT_MAX_FRAME_WIDTH / video.videoWidth);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法创建图片画布");

        const times = buildVideoFrameSampleTimes(video.duration, intervalSeconds, maxFrames);
        const samples: CanvasVideoFrameSample[] = [];
        for (const [index, timeSeconds] of times.entries()) {
            throwIfAborted(signal);
            if (Math.abs(video.currentTime - timeSeconds) > 0.001) {
                const seeked = waitForVideoEvent(video, "seeked", `无法定位到 ${timeSeconds.toFixed(2)} 秒`, signal);
                video.currentTime = timeSeconds;
                await seeked;
            }
            context.drawImage(video, 0, 0, width, height);
            samples.push({
                id: `frame-${index}-${Math.round(timeSeconds * 1000)}`,
                timeSeconds,
                sourceDurationSeconds: video.duration,
                width,
                height,
                blob: await canvasToJpegBlob(canvas),
            });
        }
        return samples;
    } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
    }
}

export function buildVideoFrameShotRanges(frames: CanvasVideoFrameSample[]): CanvasVideoFrameShotRange[] {
    if (!frames.length) return [];
    const sorted = [...frames].sort((left, right) => left.timeSeconds - right.timeSeconds);
    const sourceDurationSeconds = Math.max(...sorted.map((frame) => frame.sourceDurationSeconds || frame.timeSeconds));
    return sorted.map((frame, index) => {
        const previous = sorted[index - 1];
        const next = sorted[index + 1];
        const startSeconds = previous ? (previous.timeSeconds + frame.timeSeconds) / 2 : 0;
        const endSeconds = next ? (frame.timeSeconds + next.timeSeconds) / 2 : Math.max(frame.timeSeconds, sourceDurationSeconds);
        return {
            frameId: frame.id,
            startSeconds: Number(startSeconds.toFixed(3)),
            endSeconds: Number(endSeconds.toFixed(3)),
            durationSeconds: Number(Math.max(0.001, endSeconds - startSeconds).toFixed(3)),
        };
    });
}

export function formatVideoFrameTime(timeSeconds: number) {
    const totalMilliseconds = Math.max(0, Math.round(timeSeconds * 1000));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

async function readVideoBlob(source: Blob | string, signal?: AbortSignal) {
    if (source instanceof Blob) return source;
    try {
        const response = await fetch(source, { signal });
        if (!response.ok) throw new Error(String(response.status));
        return await response.blob();
    } catch (error) {
        if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
        throw new Error("无法读取视频文件，请重新上传视频后再进行逐帧拉片", { cause: error });
    }
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadeddata" | "seeked", errorMessage: string, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("操作已取消", "AbortError"));
            return;
        }
        let timer = 0;
        const cleanup = () => {
            window.clearTimeout(timer);
            video.removeEventListener(eventName, onSuccess);
            video.removeEventListener("error", onError);
            signal?.removeEventListener("abort", onAbort);
        };
        const onSuccess = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error(errorMessage));
        };
        const onAbort = () => {
            cleanup();
            reject(new DOMException("操作已取消", "AbortError"));
        };
        video.addEventListener(eventName, onSuccess, { once: true });
        video.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = window.setTimeout(onError, VIDEO_FRAME_ANALYSIS_TIMEOUT_MS);
    });
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
}

function canvasToJpegBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("拉片图片编码失败"))), "image/jpeg", 0.9));
}
