import type { SrtEntry } from "@/types/timeline";

export type CanvasAudioRange = {
    id: string;
    startMs: number;
    endMs: number;
    label?: string;
};

export type SilenceDetectionOptions = {
    threshold?: number;
    minimumSilenceMs?: number;
    minimumSegmentMs?: number;
};

export function buildSubtitleAudioRanges(entries: SrtEntry[], durationMs: number): CanvasAudioRange[] {
    return entries
        .map((entry) => ({
            id: `subtitle-${entry.index}`,
            startMs: Math.max(0, Math.round(entry.startMs)),
            endMs: Math.min(durationMs, Math.max(entry.startMs, Math.round(entry.endMs))),
            label: entry.text.trim() || `字幕 ${entry.index}`,
        }))
        .filter((range) => range.endMs - range.startMs >= 100);
}

/** 对解码后的单声道采样做窗口 RMS 分析，返回非静音范围。 */
export function detectNonSilentRanges(samples: Float32Array, sampleRate: number, options: SilenceDetectionOptions = {}): CanvasAudioRange[] {
    const threshold = Math.max(0.001, options.threshold ?? 0.018);
    const minimumSilenceMs = Math.max(100, options.minimumSilenceMs ?? 600);
    const minimumSegmentMs = Math.max(100, options.minimumSegmentMs ?? 300);
    const windowMs = 50;
    const windowSize = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
    const silent: boolean[] = [];
    for (let offset = 0; offset < samples.length; offset += windowSize) {
        let sum = 0;
        const end = Math.min(samples.length, offset + windowSize);
        for (let index = offset; index < end; index += 1) sum += samples[index] * samples[index];
        silent.push(Math.sqrt(sum / Math.max(1, end - offset)) < threshold);
    }
    const minimumSilentWindows = Math.ceil(minimumSilenceMs / windowMs);
    const boundaries = [0];
    let runStart = -1;
    silent.forEach((isSilent, index) => {
        if (isSilent && runStart < 0) runStart = index;
        if ((!isSilent || index === silent.length - 1) && runStart >= 0) {
            const runEnd = isSilent && index === silent.length - 1 ? index + 1 : index;
            if (runEnd - runStart >= minimumSilentWindows) boundaries.push(Math.round(((runStart + runEnd) * windowMs) / 2));
            runStart = -1;
        }
    });
    const durationMs = Math.round((samples.length / Math.max(1, sampleRate)) * 1000);
    boundaries.push(durationMs);
    const sortedBoundaries = boundaries
        .sort((a, b) => a - b)
        .filter((value, index, values) => index === 0 || value > values[index - 1]);
    return sortedBoundaries
        .slice(0, -1)
        .map((startMs, index) => ({ id: `silence-${index + 1}`, startMs, endMs: sortedBoundaries[index + 1], label: `片段 ${index + 1}` }))
        .filter((range) => range.endMs - range.startMs >= minimumSegmentMs);
}

export async function detectAudioRangesFromUrl(url: string, options?: SilenceDetectionOptions) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取音频失败（${response.status}）`);
    const context = new AudioContext();
    try {
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const mono = new Float32Array(buffer.length);
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const source = buffer.getChannelData(channel);
            for (let index = 0; index < source.length; index += 1) mono[index] += source[index] / buffer.numberOfChannels;
        }
        return detectNonSilentRanges(mono, buffer.sampleRate, options);
    } finally {
        await context.close();
    }
}
