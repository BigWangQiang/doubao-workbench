export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
];

/** IndexTTS2 keeps protocol IDs as values while exposing readable labels. */
export const indexTTS2VoiceOptions = [
    { value: "voice_01", label: "温柔小姐姐音" },
    { value: "voice_02", label: "阳光少年音" },
    { value: "voice_03", label: "清晰播报音" },
    { value: "voice_04", label: "知性女声" },
    { value: "voice_05", label: "温暖女声" },
    { value: "voice_06", label: "活力少女音" },
    { value: "voice_07", label: "沉稳叔叔音" },
    { value: "voice_08", label: "磁性男声" },
    { value: "voice_09", label: "甜美女声" },
    { value: "voice_10", label: "浑厚男声" },
];

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export function audioVoiceOptionsForInterface(interfaceType?: string) {
    return interfaceType === "index-tts-v2" ? indexTTS2VoiceOptions : audioVoiceOptions;
}

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeIndexTTS2VoiceValue(value: string) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return indexTTS2VoiceOptions.some((item) => item.value === normalized) ? normalized : "voice_01";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string, interfaceType?: string) {
    const isIndexTTS2 = interfaceType === "index-tts-v2";
    const voice = isIndexTTS2 ? normalizeIndexTTS2VoiceValue(value) : normalizeAudioVoiceValue(value);
    const options = audioVoiceOptionsForInterface(interfaceType);
    return options.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "ogg") return "audio/ogg";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
