import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Pause, Play } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";
import { createDefaultSubtitleStyle } from "@/types/timeline";
import type { TimelineClip } from "@/types/timeline";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasSubtitleOverlay } from "./canvas-subtitle-overlay";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasTimelinePreviewProps = {
    clips: TimelineClip[];
    nodes: CanvasNodeData[];
    playheadMs: number;
    playing: boolean;
    theme: CanvasTheme;
    onTogglePlay: () => void;
    onPlayheadChange: (ms: number) => void;
};

const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 168;
const AUTO_ADVANCE_GAP_MS = 500;

function isClipActive(clip: TimelineClip, playheadMs: number) {
    return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs;
}

function useTimelineMediaUrl(clip: TimelineClip | null, node: CanvasNodeData | null) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        setUrl("");
        if (!clip || (!node && !clip.directMedia)) return;
        let cancelled = false;
        const storageKey = node?.metadata?.storageKey || clip.directMedia?.storageKey || "";
        const fallback = node?.metadata?.content || clip.directMedia?.url || clip.directMedia?.dataUrl || "";
        const applyUrl = (next: string) => {
            if (!cancelled) setUrl(next);
        };
        if (resourceIdFromStorageKey(storageKey)) {
            void cacheResourceObjectUrl(storageKey)
                .then((cached) => cached ? applyUrl(cached) : resolveMediaUrl(storageKey, fallback).then(applyUrl))
                .catch(() => resolveMediaUrl(storageKey, fallback).then(applyUrl));
        } else {
            void resolveMediaUrl(storageKey, fallback).then(applyUrl);
        }
        return () => {
            cancelled = true;
        };
    }, [clip, node]);
    return url;
}

function TimelinePreviewVideo({ clip, node, playheadMs, playing, clock, onClockUpdate }: { clip: TimelineClip; node: CanvasNodeData | null; playheadMs: number; playing: boolean; clock: boolean; onClockUpdate: (clip: TimelineClip, currentTime: number) => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const targetSeekSecRef = useRef<number | null>(null);
    const url = useTimelineMediaUrl(clip, node);
    const rate = Math.max(0.25, Math.min(4, clip.playbackRate || 1));

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !url) return;
        const target = (clip.sourceStartMs || 0) / 1_000 + Math.max(0, playheadMs - clip.startMs) * rate / 1_000;
        targetSeekSecRef.current = target;
        video.playbackRate = rate;
        video.volume = Math.max(0, Math.min(1, clip.volume ?? 1));
        // 画中画导出链路会移除叠加视频音轨，预览保持相同语义，避免重复播放原声。
        video.muted = Boolean(clip.muted || clip.pictureInPicture?.enabled);
        if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.08) video.currentTime = target;
        if (playing) void video.play().catch(() => undefined);
        else video.pause();
    }, [clip, playheadMs, playing, rate, url]);

    const pip = clip.pictureInPicture?.enabled ? clip.pictureInPicture : null;
    const style: CSSProperties = pip
        ? { left: `${pip.x * 100}%`, top: `${pip.y * 100}%`, width: `${pip.width * 100}%`, height: `${pip.height * 100}%`, zIndex: Math.max(1, clip.layer || 1) }
        : { inset: 0, zIndex: Math.max(0, clip.layer || 0) };

    if (!url) return null;
    return (
        <video
            ref={videoRef}
            className={`absolute block ${pip ? "rounded-md border object-cover shadow-lg" : "size-full object-contain"}`}
            style={style}
            src={url}
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
                if (targetSeekSecRef.current == null) return;
                event.currentTarget.currentTime = Math.min(targetSeekSecRef.current, Math.max(0, event.currentTarget.duration - 0.05));
            }}
            onTimeUpdate={(event) => {
                if (clock && playing) onClockUpdate(clip, event.currentTarget.currentTime);
            }}
        />
    );
}

function TimelinePreviewAudio({ clip, node, playheadMs, playing }: { clip: TimelineClip; node: CanvasNodeData | null; playheadMs: number; playing: boolean }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const url = useTimelineMediaUrl(clip, node);
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !url) return;
        const rate = Math.max(0.25, Math.min(4, clip.playbackRate || 1));
        const target = (clip.sourceStartMs || 0) / 1_000 + Math.max(0, playheadMs - clip.startMs) * rate / 1_000;
        audio.playbackRate = rate;
        audio.volume = Math.max(0, Math.min(1, clip.volume ?? 1));
        audio.muted = Boolean(clip.muted);
        if (audio.readyState >= 1 && Math.abs(audio.currentTime - target) > 0.08) audio.currentTime = target;
        if (playing) void audio.play().catch(() => undefined);
        else audio.pause();
    }, [clip, playheadMs, playing, url]);
    return url ? <audio ref={audioRef} src={url} preload="metadata" /> : null;
}

/** 多轨所见即所得预览：主画面、画中画、字幕和独立音轨共享同一播放头。 */
export function CanvasTimelinePreview({ clips, nodes, playheadMs, playing, theme, onTogglePlay, onPlayheadChange }: CanvasTimelinePreviewProps) {
    const videoClips = useMemo(() => clips.filter((clip) => clip.kind === "video").sort((a, b) => a.startMs - b.startMs || (a.layer || 0) - (b.layer || 0)), [clips]);
    const activeVideoClips = useMemo(() => videoClips.filter((clip) => isClipActive(clip, playheadMs)).sort((a, b) => (a.layer || 0) - (b.layer || 0)), [playheadMs, videoClips]);
    const primaryVideoClip = activeVideoClips.find((clip) => !clip.pictureInPicture?.enabled) || activeVideoClips[0] || null;
    const activeAudioClips = useMemo(() => clips.filter((clip) => clip.kind === "audio" && isClipActive(clip, playheadMs)), [clips, playheadMs]);
    const activeSubtitleClip = useMemo(() => clips.find((clip) => clip.kind === "subtitle" && isClipActive(clip, playheadMs) && Boolean(clip.text?.trim())) || null, [clips, playheadMs]);
    const activeNode = useMemo(() => (primaryVideoClip ? nodes.find((node) => node.id === primaryVideoClip.nodeId) || null : null), [nodes, primaryVideoClip]);
    const subtitleStyle = activeNode?.metadata?.subtitleStyle || createDefaultSubtitleStyle();
    const activeHighlight = useMemo(() => {
        if (!activeSubtitleClip || activeSubtitleClip.subtitleEntryIndex === undefined || activeSubtitleClip.subtitleEntryIndex < 0 || !activeNode) return undefined;
        return (activeNode.metadata?.subtitleHighlights || []).find((item) => item.entryIndex === activeSubtitleClip.subtitleEntryIndex);
    }, [activeNode, activeSubtitleClip]);

    const handleClockUpdate = (clip: TimelineClip, currentTime: number) => {
        const rate = Math.max(0.25, Math.min(4, clip.playbackRate || 1));
        const sourceStartSec = (clip.sourceStartMs || 0) / 1_000;
        const timelineMs = clip.startMs + Math.round(((currentTime - sourceStartSec) / rate) * 1_000);
        const clipEndMs = clip.startMs + clip.durationMs;
        if (timelineMs >= clipEndMs - 20) {
            const next = videoClips.find((item) => item.startMs >= clipEndMs - AUTO_ADVANCE_GAP_MS && item.id !== clip.id && !item.pictureInPicture?.enabled);
            if (next) onPlayheadChange(next.startMs);
            else onTogglePlay();
            return;
        }
        onPlayheadChange(Math.max(0, timelineMs));
    };

    return (
        <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <div className="relative grid shrink-0 place-items-center overflow-hidden rounded-lg bg-black" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} data-canvas-no-zoom>
                {activeVideoClips.length ? activeVideoClips.map((clip) => (
                    <TimelinePreviewVideo key={clip.id} clip={clip} node={nodes.find((node) => node.id === clip.nodeId) || null} playheadMs={playheadMs} playing={playing} clock={clip.id === primaryVideoClip?.id} onClockUpdate={handleClockUpdate} />
                )) : <div className="px-4 text-center text-xs opacity-55">该位置无视频片段</div>}
                {activeSubtitleClip ? <div className="pointer-events-none absolute inset-0 z-30"><CanvasSubtitleOverlay text={activeSubtitleClip.text || ""} highlight={activeHighlight} style={subtitleStyle} /></div> : null}
                {activeAudioClips.map((clip) => <TimelinePreviewAudio key={clip.id} clip={clip} node={nodes.find((node) => node.id === clip.nodeId) || null} playheadMs={playheadMs} playing={playing} />)}
                <button type="button" className="absolute inset-0 z-40 grid place-items-center" aria-label={playing ? "暂停预览" : "播放预览"} onClick={(event) => { event.stopPropagation(); onTogglePlay(); }}>
                    <span className="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:scale-105 hover:bg-black/60">
                        {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
                    </span>
                </button>
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                    <span className="truncate font-semibold" style={{ color: theme.accent.primary }}>{primaryVideoClip?.title || "无视频片段"}</span>
                    <span className="opacity-45 tabular-nums">{primaryVideoClip ? `${formatTimelineTime(primaryVideoClip.startMs)} ~ ${formatTimelineTime(primaryVideoClip.startMs + primaryVideoClip.durationMs)}` : ""}</span>
                    {activeVideoClips.length > 1 ? <span className="rounded border px-1.5 py-0.5 opacity-55" style={{ borderColor: theme.toolbar.border }}>{activeVideoClips.length} 层画面</span> : null}
                </div>
                <div className="mt-1.5 max-h-16 min-h-10 overflow-y-auto rounded-lg border px-2.5 py-1.5 text-xs leading-5" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    {activeSubtitleClip ? activeSubtitleClip.text : <span className="opacity-40">此处无字幕，点选字幕片段后在下方编辑</span>}
                </div>
            </div>
        </div>
    );
}
