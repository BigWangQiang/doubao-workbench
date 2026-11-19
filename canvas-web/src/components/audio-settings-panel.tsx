import { useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button } from "antd";
import { LoaderCircle, Play, Trash2, UploadCloud } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptionsForInterface, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, normalizeIndexTTS2VoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { requestAudioGeneration } from "@/services/api/audio";
import { resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

export type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions" | "audioReferenceStorageKey" | "audioReferenceName" | "audioReferenceMimeType";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[var(--panel-width-compact)] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const requestConfig = resolveModelRequestConfig(config, config.audioModel || config.model);
    const isIndexTTS2 = requestConfig.interfaceType === "index-tts-v2";
    const voiceOptions = audioVoiceOptionsForInterface(requestConfig.interfaceType);
    const voice = isIndexTTS2 ? normalizeIndexTTS2VoiceValue(config.audioVoice) : normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);
    const { message } = App.useApp();
    const [uploadingReference, setUploadingReference] = useState(false);

    const uploadReference = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("audio/")) {
            message.error("请选择音频文件");
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            message.error("参考音频不能超过 20 MB");
            return;
        }
        setUploadingReference(true);
        try {
            const resource = await uploadResourceFile(file, "audio", { fileName: file.name });
            onConfigChange("audioReferenceStorageKey", resourceStorageKey(resource.id));
            onConfigChange("audioReferenceName", file.name);
            onConfigChange("audioReferenceMimeType", resource.mimeType || file.type);
            message.success("参考音色已上传");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "参考音色上传失败");
        } finally {
            setUploadingReference(false);
        }
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                <SettingGroup title="声音" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {voiceOptions.map((item) => (
                            <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="格式" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {audioFormatOptions.map((item) => (
                            <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="语速" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {speedOptions.map((value) => (
                            <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                {audioSpeedLabel(value)}
                            </OptionPill>
                        ))}
                    </div>
                    <input
                        type="number"
                        min={0.25}
                        max={4}
                        step={0.05}
                        className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                        value={config.audioSpeed || "1"}
                        onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                        onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
                {isIndexTTS2 ? (
                    <SettingGroup title="参考音色" color={theme.node.muted}>
                        <div className="space-y-2">
                            {config.audioReferenceStorageKey ? (
                                <div className="flex items-center gap-2 rounded-xl border px-2.5 py-2 text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                                    <span className="min-w-0 flex-1 truncate">{config.audioReferenceName || "已上传参考音色"}</span>
                                    <button
                                        type="button"
                                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full transition hover:opacity-75"
                                        title="移除参考音色"
                                        aria-label="移除参考音色"
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={() => {
                                            onConfigChange("audioReferenceStorageKey", "");
                                            onConfigChange("audioReferenceName", "");
                                            onConfigChange("audioReferenceMimeType", "");
                                        }}
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </div>
                            ) : null}
                            <label
                                className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 text-sm transition hover:opacity-80"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                {uploadingReference ? <LoaderCircle className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}
                                {uploadingReference ? "上传中..." : config.audioReferenceStorageKey ? "更换参考音色" : "上传参考音色"}
                                <input className="hidden" type="file" accept="audio/*" disabled={uploadingReference} onChange={(event) => { void uploadReference(event.target.files?.[0]); event.target.value = ""; }} />
                            </label>
                            <div className="text-xs leading-5" style={{ color: theme.node.muted }}>上传一段清晰的人声，IndexTTS2 将按本次请求克隆音色。</div>
                        </div>
                    </SettingGroup>
                ) : null}
                <SettingGroup title="声音指令" color={theme.node.muted}>
                    <textarea
                        value={config.audioInstructions || ""}
                        placeholder="例如：自然、温暖、适合旁白。"
                        className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

export function AudioPreviewButton({ config, prompt, theme, compact = false }: { config: AiConfig; prompt: string; theme?: CanvasTheme; compact?: boolean }) {
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);
    const canPreview = Boolean(prompt.trim()) && !loading;

    useEffect(() => () => {
        audioRef.current?.pause();
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    }, []);

    const preview = async () => {
        const text = prompt.trim();
        if (!text || loading) return;
        setLoading(true);
        audioRef.current?.pause();
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        try {
            const blob = await requestAudioGeneration({ ...config, model: config.audioModel || config.model }, text);
            const objectUrl = URL.createObjectURL(blob);
            objectUrlRef.current = objectUrl;
            const audio = new Audio(objectUrl);
            audioRef.current = audio;
            audio.onended = () => setLoading(false);
            audio.onerror = () => {
                setLoading(false);
                message.error("试听播放失败");
            };
            await audio.play();
        } catch (error) {
            setLoading(false);
            message.error(error instanceof Error ? error.message : "音色试听失败");
        }
    };

    return (
        <Button
            type="text"
            size="small"
            className={compact ? "!h-8 !rounded-full !px-2.5" : undefined}
            icon={loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            disabled={!canPreview}
            title={canPreview ? "试听当前音色" : "先输入试听文本"}
            aria-label={canPreview ? "试听当前音色" : "先输入试听文本"}
            style={theme ? { color: theme.node.text, background: theme.node.fill } : undefined}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void preview()}
        >
            试听音色
        </Button>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
