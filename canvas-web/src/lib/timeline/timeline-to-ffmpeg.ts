// 时间线 → FFmpeg 命令序列的纯函数规划层。
// 运行时负责写入媒体、执行参数与清理；本文件只描述可审计的合成步骤。

import type { TimelineClip, TimelineProject } from "@/types/timeline";

export type TimelineRenderSource = {
    nodeId: string;
    fileName: string;
    durationMs: number;
    storageKey?: string;
    url?: string;
};

export type TimelineRenderStep = {
    kind: "trim" | "gap" | "concat" | "audio" | "overlay" | "mix" | "subtitle" | "burn" | "output";
    output: string;
    args: string[];
    description: string;
    requiresLibass?: boolean;
};

export type TimelineRenderContext = {
    width: number;
    height: number;
    fps: number;
    burnSubtitles: boolean;
    outputName: string;
};

export type TimelineRenderPlan = {
    steps: TimelineRenderStep[];
    finalOutput: string;
    concatEntries: string[];
};

export const SUBTITLE_FILE = "timeline.srt";

export function getOrderedVideoClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips
        .filter((clip) => clip.kind === "video")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || (a.layer || 0) - (b.layer || 0) || a.trackId.localeCompare(b.trackId));
}

export function getOrderedSubtitleClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips
        .filter((clip) => clip.kind === "subtitle")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

export function formatSrtTimestamp(ms: number): string {
    const safe = Math.max(0, Math.round(ms));
    const pad = (value: number, length = 2) => String(value).padStart(length, "0");
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor((safe % 3_600_000) / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1_000);
    const millis = safe % 1_000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export function buildSubtitleSrt(clips: TimelineClip[]): string {
    return getOrderedSubtitleClips({ version: 2, tracks: [], clips, durationMs: 0 })
        .filter((clip) => clip.text && clip.durationMs > 0)
        .map((clip, index) => {
            const text = (clip.text || "").replace(/\r?\n/g, " ").trim();
            return [String(index + 1), `${formatSrtTimestamp(clip.startMs)} --> ${formatSrtTimestamp(clip.startMs + clip.durationMs)}`, text].join("\n");
        })
        .join("\n\n");
}

function defaultContext(): TimelineRenderContext {
    return { width: 1920, height: 1080, fps: 30, burnSubtitles: true, outputName: "export.mp4" };
}

function clampRate(value: number | undefined) {
    return Math.max(0.25, Math.min(4, value || 1));
}

function atempoFilters(rate: number) {
    const filters: string[] = [];
    let remaining = rate;
    while (remaining > 2) {
        filters.push("atempo=2");
        remaining /= 2;
    }
    while (remaining < 0.5) {
        filters.push("atempo=0.5");
        remaining /= 0.5;
    }
    if (Math.abs(remaining - 1) > 0.001) filters.push(`atempo=${remaining.toFixed(4)}`);
    return filters;
}

function clipAudioFilters(clip: TimelineClip) {
    const filters = atempoFilters(clampRate(clip.playbackRate));
    filters.push(`volume=${clip.muted ? 0 : Math.max(0, Math.min(2, clip.volume ?? 1)).toFixed(3)}`);
    const pan = Math.max(-1, Math.min(1, clip.pan || 0));
    if (Math.abs(pan) > 0.001) {
        const left = pan > 0 ? 1 - pan : 1;
        const right = pan < 0 ? 1 + pan : 1;
        filters.push(`pan=stereo|c0=c0*${left.toFixed(3)}|c1=c1*${right.toFixed(3)}`);
    }
    const durationSec = clip.durationMs / 1_000;
    const fadeInSec = Math.min(durationSec, Math.max(0, clip.fadeInMs || 0) / 1_000);
    const fadeOutSec = Math.min(durationSec, Math.max(0, clip.fadeOutMs || 0) / 1_000);
    if (fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`);
    if (fadeOutSec > 0) filters.push(`afade=t=out:st=${Math.max(0, durationSec - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}`);
    return filters;
}

function sourceSpanSec(clip: TimelineClip) {
    return Math.max(0.1, (clip.durationMs * clampRate(clip.playbackRate)) / 1_000);
}

/**
 * 生成导出计划：
 * 1. 主视频片段裁切、变速并按时间顺序补黑场；
 * 2. 画中画片段按归一化位置叠加；
 * 3. 独立音轨裁切、延迟和混音；
 * 4. 最后烧录字幕（内核不支持 libass 时由运行时回退）。
 */
export function buildTimelineRenderPlan(timeline: TimelineProject, sources: TimelineRenderSource[], context: Partial<TimelineRenderContext> = {}): TimelineRenderPlan {
    const cfg: TimelineRenderContext = { ...defaultContext(), ...context };
    const sourceByNode = new Map(sources.map((item) => [item.nodeId, item]));
    const steps: TimelineRenderStep[] = [];
    const concatEntries: string[] = [];
    const allVideoClips = getOrderedVideoClips(timeline);
    const baseVideoClips = allVideoClips.filter((clip) => !clip.pictureInPicture?.enabled);
    const overlayVideoClips = allVideoClips.filter((clip) => clip.pictureInPicture?.enabled);
    const trimOutputByClip = new Map<string, string>();

    allVideoClips.forEach((clip, index) => {
        const source = sourceByNode.get(clip.nodeId);
        if (!source) return;
        const output = `trim-${index}.mp4`;
        const rate = clampRate(clip.playbackRate);
        const pip = clip.pictureInPicture?.enabled ? clip.pictureInPicture : null;
        const width = pip ? Math.max(2, Math.round(cfg.width * pip.width / 2) * 2) : cfg.width;
        const height = pip ? Math.max(2, Math.round(cfg.height * pip.height / 2) * 2) : cfg.height;
        const videoFilters = [`setpts=(PTS-STARTPTS)/${rate.toFixed(4)}`, `scale=${width}:${height}:force_original_aspect_ratio=decrease`];
        if (!pip) videoFilters.push(`pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2:black`);
        const args = [
            "-ss", String((clip.sourceStartMs || 0) / 1_000),
            "-t", String(sourceSpanSec(clip)),
            "-i", source.fileName,
            "-vf", videoFilters.join(","),
            "-t", String(Math.max(0.1, clip.durationMs / 1_000)),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "20",
        ];
        if (pip || clip.muted) args.push("-an");
        else {
            const audioFilters = clipAudioFilters(clip);
            const hasAudioAdjustment = Math.abs(rate - 1) > 0.001
                || Math.abs((clip.volume ?? 1) - 1) > 0.001
                || Math.abs(clip.pan || 0) > 0.001
                || Boolean(clip.fadeInMs || clip.fadeOutMs);
            if (hasAudioAdjustment) args.push("-af", audioFilters.join(","));
            args.push("-c:a", "aac", "-b:a", "128k");
        }
        args.push(output);
        steps.push({ kind: "trim", output, args, description: `裁切片段 ${index + 1}（${clip.title || clip.nodeId}）` });
        trimOutputByClip.set(clip.id, output);
    });

    let cursorMs = 0;
    baseVideoClips.forEach((clip, index) => {
        const output = trimOutputByClip.get(clip.id);
        if (!output) return;
        const gapMs = Math.max(0, clip.startMs - cursorMs);
        if (gapMs > 100) {
            const gapOutput = `gap-${index}.mp4`;
            const durationSec = gapMs / 1_000;
            steps.push({
                kind: "gap",
                output: gapOutput,
                args: ["-f", "lavfi", "-i", `color=c=black:s=${cfg.width}x${cfg.height}:r=${cfg.fps}:d=${durationSec}`, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", String(durationSec), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-shortest", gapOutput],
                description: `补黑场 ${durationSec.toFixed(2)}s`,
            });
            concatEntries.push(gapOutput);
        }
        concatEntries.push(output);
        cursorMs = Math.max(cursorMs, clip.startMs + clip.durationMs);
    });

    if (!concatEntries.length) {
        const gapOutput = "timeline-black.mp4";
        const durationSec = Math.max(0.1, timeline.durationMs / 1_000);
        steps.push({
            kind: "gap",
            output: gapOutput,
            args: ["-f", "lavfi", "-i", `color=c=black:s=${cfg.width}x${cfg.height}:r=${cfg.fps}:d=${durationSec}`, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", String(durationSec), "-c:v", "libx264", "-c:a", "aac", "-shortest", gapOutput],
            description: "创建空白主画面",
        });
        concatEntries.push(gapOutput);
    }

    let currentVideo = "timeline-video.mp4";
    steps.push({
        kind: "concat",
        output: currentVideo,
        args: ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", currentVideo],
        description: "拼接主视频轨",
    });

    overlayVideoClips.forEach((clip, index) => {
        const overlayInput = trimOutputByClip.get(clip.id);
        const pip = clip.pictureInPicture;
        if (!overlayInput || !pip) return;
        const output = `timeline-overlay-${index}.mp4`;
        const x = Math.round(Math.max(0, Math.min(1, pip.x)) * cfg.width);
        const y = Math.round(Math.max(0, Math.min(1, pip.y)) * cfg.height);
        const startSec = clip.startMs / 1_000;
        const endSec = (clip.startMs + clip.durationMs) / 1_000;
        steps.push({
            kind: "overlay",
            output,
            args: ["-i", currentVideo, "-i", overlayInput, "-filter_complex", `[1:v]setpts=PTS-STARTPTS+${startSec}/TB[overlay];[0:v][overlay]overlay=${x}:${y}:enable='between(t,${startSec},${endSec})':shortest=1[video]`, "-map", "[video]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", output],
            description: `叠加画中画 ${clip.title || index + 1}`,
        });
        currentVideo = output;
    });

    const audioOutputs: Array<{ clip: TimelineClip; output: string }> = [];
    timeline.clips.filter((clip) => clip.kind === "audio").sort((a, b) => a.startMs - b.startMs).forEach((clip, index) => {
        const source = sourceByNode.get(clip.nodeId);
        if (!source) return;
        const output = `audio-${index}.m4a`;
        steps.push({
            kind: "audio",
            output,
            args: ["-ss", String((clip.sourceStartMs || 0) / 1_000), "-t", String(sourceSpanSec(clip)), "-i", source.fileName, "-vn", "-af", clipAudioFilters(clip).join(","), "-t", String(Math.max(0.1, clip.durationMs / 1_000)), "-c:a", "aac", "-b:a", "192k", output],
            description: `处理音轨 ${clip.title || index + 1}`,
        });
        audioOutputs.push({ clip, output });
    });

    if (audioOutputs.length) {
        const output = "timeline-audio-mix.mp4";
        const args = ["-i", currentVideo, "-f", "lavfi", "-t", String(Math.max(0.1, timeline.durationMs / 1_000)), "-i", "anullsrc=r=44100:cl=stereo"];
        audioOutputs.forEach(({ output: audioOutput }) => args.push("-i", audioOutput));
        const delayed = audioOutputs.map(({ clip }, index) => {
            const delay = Math.max(0, Math.round(clip.startMs));
            return `[${index + 2}:a]adelay=${delay}|${delay}[audio${index}]`;
        });
        const mixInputs = ["[1:a]", ...audioOutputs.map((_, index) => `[audio${index}]`)].join("");
        args.push("-filter_complex", `${delayed.join(";")};${mixInputs}amix=inputs=${audioOutputs.length + 1}:duration=longest:normalize=0[mixed]`, "-map", "0:v", "-map", "[mixed]", "-c:v", "copy", "-c:a", "aac", "-shortest", output);
        steps.push({ kind: "mix", output, args, description: "混合独立音轨" });
        currentVideo = output;
    }

    const subtitleClips = getOrderedSubtitleClips(timeline);
    if (cfg.burnSubtitles && subtitleClips.some((clip) => clip.text)) {
        steps.push({ kind: "subtitle", output: SUBTITLE_FILE, args: [], description: "生成字幕 SRT" });
    }

    const finalOutput = cfg.outputName;
    if (steps.some((step) => step.kind === "subtitle")) {
        steps.push({
            kind: "burn",
            output: finalOutput,
            args: ["-i", currentVideo, "-vf", `subtitles=${SUBTITLE_FILE}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", finalOutput],
            description: "烧录字幕并输出",
            requiresLibass: true,
        });
    } else {
        steps.push({ kind: "output", output: finalOutput, args: ["-i", currentVideo, "-c", "copy", finalOutput], description: "输出成片" });
    }

    return { steps, finalOutput, concatEntries };
}

export function describeRenderPlan(plan: TimelineRenderPlan): string {
    return plan.steps.map((step) => `# ${step.description}\nffmpeg -y ${step.args.join(" ")}`).join("\n\n");
}
