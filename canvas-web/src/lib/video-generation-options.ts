export const VIDEO_DURATION_OPTIONS = [6, 9, 10, 15] as const;
export const VIDEO_RESOLUTION_OPTIONS = [480, 720, 768, 1080, 2160] as const;
export const VIDEO_DURATION_MIN = 1;

export function normalizeVideoDuration(value: string | number | undefined) {
    const seconds = Math.floor(Number(value) || VIDEO_DURATION_OPTIONS[0]);
    return String(Math.max(VIDEO_DURATION_MIN, seconds));
}

export function normalizeVideoResolution(value: string | number | undefined) {
    const token = String(value || "").trim().toLowerCase();
    if (token === "low") return "480";
    if (token === "auto" || token === "medium" || token === "high") return "720";
    const normalized = token.replace(/p$/i, "");
    if (normalized === "2k") return "2K";
    if (normalized === "4k") return "2160";
    const resolution = Number(normalized) || 720;
    return String(nearestOption(resolution, VIDEO_RESOLUTION_OPTIONS));
}

export function videoResolutionLabel(value: string | number | undefined) {
    const normalized = normalizeVideoResolution(value);
    if (normalized === "2K") return "2K";
    if (normalized === "2160") return "4K";
    return `${normalized}P`;
}

function nearestOption(value: number, options: readonly number[]) {
    return options.reduce((nearest, option) => Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest, options[0]);
}
