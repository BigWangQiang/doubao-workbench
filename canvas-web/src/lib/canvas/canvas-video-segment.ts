import { fetchFile } from "@ffmpeg/util";

import { getMediaBlob } from "@/services/file-storage";
import { loadFFmpeg } from "./canvas-video-merge";

export type VideoSegmentRange = {
    startMs: number;
    endMs: number;
};

export type VideoSegmentSource = {
    url?: string;
    storageKey?: string;
};

export type VideoSegmentProgress = {
    phase: "loading" | "reading" | "encoding";
    progress: number;
};

export type VideoSubtitleRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type VideoSourceDimensions = {
    width: number;
    height: number;
};

const INPUT_NAME = "segment-input.mp4";
const OUTPUT_NAME = "segment-output.mp4";
const SUBTITLE_INPUT_NAME = "subtitle-input.mp4";
const SUBTITLE_OUTPUT_NAME = "subtitle-output.mp4";

function assertValidRange(range: VideoSegmentRange, durationMs?: number) {
    const startMs = Math.max(0, Math.round(range.startMs));
    const endMs = Math.round(range.endMs);
    if (endMs <= startMs) throw new Error("片段结束时间必须晚于开始时间");
    if (durationMs !== undefined && endMs > Math.round(durationMs)) throw new Error("片段结束时间超过视频时长");
}

async function readVideoSourceBlob(source: VideoSegmentSource) {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`视频资源请求失败（${response.status}）`);
        return response.blob();
    }
    throw new Error("找不到视频素材，请重新上传后再操作");
}

async function runSegmentJob(
    source: VideoSegmentSource,
    range: VideoSegmentRange,
    durationMs: number | undefined,
    buildArgs: (startSec: string, durationSec: string) => string[],
    onProgress?: (progress: VideoSegmentProgress) => void,
    outputType = "video/mp4",
) {
    assertValidRange(range, durationMs);
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress }));
    const blob = await readVideoSourceBlob(source);
    onProgress?.({ phase: "reading", progress: 45 });
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(blob));
    const startSec = String(range.startMs / 1000);
    const durationSec = String((range.endMs - range.startMs) / 1000);
    onProgress?.({ phase: "encoding", progress: 55 });
    try {
        const exitCode = await ffmpeg.exec(["-y", ...buildArgs(startSec, durationSec)]);
        if (exitCode !== 0) throw new Error("媒体处理失败，请确认视频编码格式兼容");
        const output = await ffmpeg.readFile(OUTPUT_NAME);
        onProgress?.({ phase: "encoding", progress: 100 });
        return new Blob([output as BlobPart], { type: outputType });
    } finally {
        await Promise.all([INPUT_NAME, OUTPUT_NAME].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}

/** 按片段范围截取视频，输出统一编码 MP4（复用时间线 trim 的参数模板）。 */
export async function trimVideoSegment(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    return runSegmentJob(
        source,
        range,
        durationMs,
        (startSec, durationSec) => ["-ss", startSec, "-i", INPUT_NAME, "-t", durationSec, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", OUTPUT_NAME],
        onProgress,
        "video/mp4",
    );
}

/** 从视频片段提取声音为 MP3；优先 libmp3lame，内核不支持时回退默认 mp3 编码器。 */
export async function extractVideoAudio(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress }));
    const blob = await readVideoSourceBlob(source);
    onProgress?.({ phase: "reading", progress: 45 });
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(blob));
    assertValidRange(range, durationMs);
    const startSec = String(range.startMs / 1000);
    const durationSec = String((range.endMs - range.startMs) / 1000);
    onProgress?.({ phase: "encoding", progress: 55 });
    try {
        const args = (audioCodec: string) => ["-ss", startSec, "-i", INPUT_NAME, "-t", durationSec, "-vn", "-c:a", audioCodec, "-q:a", "2", OUTPUT_NAME];
        let exitCode = await ffmpeg.exec(["-y", ...args("libmp3lame")]);
        if (exitCode !== 0) exitCode = await ffmpeg.exec(["-y", ...args("mp3")]);
        if (exitCode !== 0) throw new Error("音频提取失败：当前 FFmpeg 内核不支持 MP3 编码");
        const output = await ffmpeg.readFile(OUTPUT_NAME);
        onProgress?.({ phase: "encoding", progress: 100 });
        return new Blob([output as BlobPart], { type: "audio/mpeg" });
    } finally {
        await Promise.all([INPUT_NAME, OUTPUT_NAME].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}

/**
 * 将归一化框选区域转换为 FFmpeg delogo 参数。边缘至少保留 1px，避免滤镜读取画面外像素。
 */
export function buildVideoSubtitleDelogoFilter(region: VideoSubtitleRegion, dimensions: VideoSourceDimensions) {
    const sourceWidth = Math.round(dimensions.width);
    const sourceHeight = Math.round(dimensions.height);
    if (sourceWidth < 8 || sourceHeight < 8) throw new Error("无法读取有效的视频尺寸");
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
        throw new Error("去字幕区域无效，请重新框选");
    }

    const x = clampInteger(Math.round(region.x * sourceWidth), 1, sourceWidth - 3);
    const y = clampInteger(Math.round(region.y * sourceHeight), 1, sourceHeight - 3);
    const width = clampInteger(Math.round(region.width * sourceWidth), 2, sourceWidth - x - 1);
    const height = clampInteger(Math.round(region.height * sourceHeight), 2, sourceHeight - y - 1);
    return `delogo=x=${x}:y=${y}:w=${width}:h=${height}:show=0`;
}

/** 框选固定字幕区域后在浏览器本地重编码视频，保留原音轨并输出 MP4。 */
export async function removeVideoSubtitleRegion(
    source: VideoSegmentSource,
    region: VideoSubtitleRegion,
    dimensions: VideoSourceDimensions,
    onProgress?: (progress: VideoSegmentProgress) => void,
) {
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress }));
    const blob = await readVideoSourceBlob(source);
    const filter = buildVideoSubtitleDelogoFilter(region, dimensions);
    onProgress?.({ phase: "reading", progress: 45 });
    await ffmpeg.writeFile(SUBTITLE_INPUT_NAME, await fetchFile(blob));
    onProgress?.({ phase: "encoding", progress: 55 });
    try {
        const exitCode = await ffmpeg.exec([
            "-y",
            "-i", SUBTITLE_INPUT_NAME,
            "-vf", filter,
            "-map", "0:v:0",
            "-map", "0:a?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-movflags", "+faststart",
            SUBTITLE_OUTPUT_NAME,
        ]);
        if (exitCode !== 0) throw new Error("去字幕处理失败，请确认视频编码格式兼容");
        const output = await ffmpeg.readFile(SUBTITLE_OUTPUT_NAME);
        onProgress?.({ phase: "encoding", progress: 100 });
        return new Blob([output as BlobPart], { type: "video/mp4" });
    } finally {
        await Promise.all([SUBTITLE_INPUT_NAME, SUBTITLE_OUTPUT_NAME].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}

function clampInteger(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
