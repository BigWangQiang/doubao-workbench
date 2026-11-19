import { useMemo, useRef } from "react";
import type { ComponentProps } from "react";
import { Controls, FullscreenButton, MediaPlayer, MediaProvider, MuteButton, PlayButton, Time, TimeSlider, useMediaState, type MediaPlayerInstance, type VideoMimeType } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons, type DefaultLayoutTranslations } from "@vidstack/react/player/layouts/default";
import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import "@vidstack/react/player/styles/base.css";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./video-player.css";

type MediaPlayerProps = ComponentProps<typeof MediaPlayer>;

type VideoPlayerProps = {
    src: string;
    mimeType?: string;
    title?: string;
    className?: string;
    brandColor?: string;
    preload?: MediaPlayerProps["preload"];
    autoPlay?: boolean;
    dataCanvasNoZoom?: boolean;
    compactControls?: boolean;
    playOnHover?: boolean;
    onCanPlay?: MediaPlayerProps["onCanPlay"];
    onLoadedData?: MediaPlayerProps["onLoadedData"];
    onError?: MediaPlayerProps["onError"];
};

const zhCNTranslations = {
    Accessibility: "辅助功能",
    AirPlay: "隔空播放",
    Audio: "音频",
    Auto: "自动",
    Boost: "音量增强",
    Captions: "字幕",
    "Caption Styles": "字幕样式",
    Chapters: "章节",
    "Closed-Captions Off": "关闭字幕",
    "Closed-Captions On": "开启字幕",
    Connected: "已连接",
    Connecting: "连接中",
    Default: "默认",
    Disabled: "已禁用",
    Disconnected: "已断开",
    Download: "下载",
    "Enter Fullscreen": "进入全屏",
    "Enter PiP": "进入画中画",
    "Exit Fullscreen": "退出全屏",
    "Exit PiP": "退出画中画",
    Fullscreen: "全屏",
    Loop: "循环播放",
    Mute: "静音",
    Normal: "正常",
    Off: "关闭",
    Pause: "暂停",
    Play: "播放",
    Playback: "播放",
    PiP: "画中画",
    Quality: "画质",
    Replay: "重新播放",
    Reset: "重置",
    Seek: "跳转",
    "Seek Backward": "快退",
    "Seek Forward": "快进",
    Settings: "设置",
    Speed: "倍速",
    Unmute: "取消静音",
    Volume: "音量",
} satisfies Partial<DefaultLayoutTranslations>;

const supportedVideoMimeTypes = new Set<VideoMimeType>(["video/mp4", "video/webm", "video/3gp", "video/ogg", "video/avi", "video/mpeg", "video/object"]);

function CompactVideoControls() {
    const paused = useMediaState("paused");
    const muted = useMediaState("muted");
    const volume = useMediaState("volume");
    const fullscreen = useMediaState("fullscreen");
    const playLabel = paused ? "播放" : "暂停";
    const muteLabel = muted || volume === 0 ? "取消静音" : "静音";
    const fullscreenLabel = fullscreen ? "退出全屏" : "进入全屏";

    return (
        <Controls.Root className="vds-controls canvas-video-compact-controls">
            <Controls.Group className="vds-controls-group canvas-video-compact-controls-row">
                <PlayButton className="canvas-video-compact-button" aria-label={playLabel} title={playLabel}>
                    {paused ? <Play aria-hidden="true" className="canvas-video-compact-icon canvas-video-compact-play-icon" /> : <Pause aria-hidden="true" className="canvas-video-compact-icon" />}
                </PlayButton>
                <Time className="canvas-video-compact-time" type="current" />
                <TimeSlider.Root className="vds-slider vds-time-slider canvas-video-compact-slider" aria-label="视频进度">
                    <TimeSlider.Track className="vds-slider-track">
                        <TimeSlider.Progress className="vds-slider-progress" />
                        <TimeSlider.TrackFill className="vds-slider-track-fill" />
                    </TimeSlider.Track>
                    <TimeSlider.Thumb className="vds-slider-thumb" />
                </TimeSlider.Root>
                <Time className="canvas-video-compact-time" type="duration" />
                <MuteButton className="canvas-video-compact-button" aria-label={muteLabel} title={muteLabel}>
                    {muted || volume === 0 ? <VolumeX aria-hidden="true" className="canvas-video-compact-icon" /> : <Volume2 aria-hidden="true" className="canvas-video-compact-icon" />}
                </MuteButton>
                <FullscreenButton className="canvas-video-compact-button" aria-label={fullscreenLabel} title={fullscreenLabel} data-video-action="fullscreen">
                    {fullscreen ? <Minimize2 aria-hidden="true" className="canvas-video-compact-icon" /> : <Maximize2 aria-hidden="true" className="canvas-video-compact-icon" />}
                </FullscreenButton>
            </Controls.Group>
        </Controls.Root>
    );
}

/**
 * 统一视频播放表面，保留原生媒体 URL 契约，同时提供可访问的完整控件布局。
 * 画布节点需要隔离播放器手势，避免拖动进度条时被误判为拖动画布。
 */
export function VideoPlayer({ src, mimeType, title = "视频", className, brandColor = "#f5f5f5", preload = "metadata", autoPlay = false, dataCanvasNoZoom = false, compactControls = false, playOnHover, onCanPlay, onLoadedData, onError }: VideoPlayerProps) {
    const playerRef = useRef<MediaPlayerInstance>(null);
    const hoveringRef = useRef(false);
    const hoverPlaybackEnabled = playOnHover ?? compactControls;
    const stopCanvasControlInteraction = (event: { target: EventTarget | null; stopPropagation: () => void }) => {
        if (!dataCanvasNoZoom || !(event.target instanceof Element)) return;
        if (event.target.closest(".vds-controls,.vds-menu-items")) event.stopPropagation();
    };
    const startHoverPlayback = async () => {
        const player = playerRef.current;
        if (!hoveringRef.current || !player) return;
        try {
            await player.play();
        } catch {
            // Browsers can reject audible autoplay. Keep hover preview reliable without changing click playback.
            if (!hoveringRef.current) return;
            player.muted = true;
            try {
                await player.play();
            } catch {
                // The media may still be loading; onCanPlay retries while the pointer remains over it.
            }
        }
    };
    const stopHoverPlayback = async () => {
        const player = playerRef.current;
        if (!player) return;
        try {
            await player.pause();
        } catch {
            // Ignore a leave event that races with provider setup.
        }
    };
    const handleCanPlay: NonNullable<MediaPlayerProps["onCanPlay"]> = (...args) => {
        onCanPlay?.(...args);
        if (hoveringRef.current) void startHoverPlayback();
    };
    const isHlsSource = /\.m3u8(?:$|[?#])/i.test(src);
    const type = isHlsSource ? ("application/x-mpegurl" as unknown as VideoMimeType) : mimeType && supportedVideoMimeTypes.has(mimeType as VideoMimeType) ? (mimeType as VideoMimeType) : "video/mp4";
    const mediaSource = useMemo(() => ({ src, type }), [src, type]);

    return (
        <MediaPlayer
            ref={playerRef}
            className={`canvas-video-player ${compactControls ? "canvas-video-player-compact" : ""} ${className || ""}`}
            src={mediaSource}
            title={title}
            viewType="video"
            streamType="on-demand"
            playsInline
            autoPlay={autoPlay}
            load={preload === "none" ? "idle" : "eager"}
            preload={preload}
            data-canvas-no-zoom={dataCanvasNoZoom ? "true" : undefined}
            style={{ "--video-brand": brandColor }}
            onCanPlay={handleCanPlay}
            onLoadedData={onLoadedData}
            onError={onError}
            onPointerEnter={(event) => {
                if (!hoverPlaybackEnabled || event.pointerType !== "mouse") return;
                hoveringRef.current = true;
                void startHoverPlayback();
            }}
            onPointerLeave={(event) => {
                if (!hoverPlaybackEnabled || event.pointerType !== "mouse") return;
                hoveringRef.current = false;
                void stopHoverPlayback();
            }}
            onPointerDown={stopCanvasControlInteraction}
            onMouseDown={stopCanvasControlInteraction}
        >
            <MediaProvider />
            {compactControls ? <CompactVideoControls /> : <DefaultVideoLayout icons={defaultLayoutIcons} translations={zhCNTranslations} />}
        </MediaPlayer>
    );
}
