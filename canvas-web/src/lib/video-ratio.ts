const VIDEO_RATIO_PIXEL_SIZES: Record<string, string> = {
    "21:9": "1344x576",
    "16:9": "1280x720",
    "4:3": "960x720",
    "3:2": "1080x720",
    "1:1": "720x720",
    "5:4": "900x720",
    "4:5": "720x900",
    "3:4": "720x960",
    "2:3": "720x1080",
    "9:16": "720x1280",
};

const KNOWN_VIDEO_RATIOS = Object.keys(VIDEO_RATIO_PIXEL_SIZES).map((value) => {
    const [width, height] = value.split(":").map(Number);
    return { value, aspect: width / height };
});

function normalizedVideoRatioToken(value: string | undefined) {
    return String(value || "").trim().toLowerCase().replace(/[×脳]/g, "x");
}

function formatRatioNumber(value: number) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, "");
}

function ratioFromPixels(width: number, height: number) {
    const aspect = width / height;
    const closest = KNOWN_VIDEO_RATIOS.reduce<{ value: string; distance: number } | null>((best, candidate) => {
        const distance = Math.abs(aspect - candidate.aspect);
        return !best || distance < best.distance ? { value: candidate.value, distance } : best;
    }, null);
    if (closest && closest.distance <= 0.02) return closest.value;
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
    return right ? greatestCommonDivisor(right, left % right) : Math.max(1, left);
}

/** Converts a canvas size into the ratio string expected by aspect-ratio fields. */
export function normalizeVideoAspectRatio(value: string | undefined) {
    const token = normalizedVideoRatioToken(value);
    if (!token || token === "auto" || token === "adaptive") return null;
    const ratioMatch = token.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (ratioMatch) {
        const width = Number(ratioMatch[1]);
        const height = Number(ratioMatch[2]);
        if (width > 0 && height > 0) return `${formatRatioNumber(width)}:${formatRatioNumber(height)}`;
        return null;
    }
    const sizeMatch = token.match(/^(\d+)\s*x\s*(\d+)$/);
    if (!sizeMatch) return null;
    const width = Number(sizeMatch[1]);
    const height = Number(sizeMatch[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
    return ratioFromPixels(width, height);
}

/** Converts a canvas ratio/size into a pixel size for APIs whose field is named `size`. */
export function normalizeVideoPixelSize(value: string | undefined) {
    const token = normalizedVideoRatioToken(value);
    if (!token || token === "auto" || token === "adaptive") return null;
    const sizeMatch = token.match(/^(\d+)\s*x\s*(\d+)$/);
    if (sizeMatch) {
        const width = Number(sizeMatch[1]);
        const height = Number(sizeMatch[2]);
        if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) return `${width}x${height}`;
        return null;
    }
    const ratio = normalizeVideoAspectRatio(token);
    if (!ratio) return null;
    const knownSize = VIDEO_RATIO_PIXEL_SIZES[ratio];
    if (knownSize) return knownSize;
    const [widthRatio, heightRatio] = ratio.split(":").map(Number);
    if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) return null;
    const shortSide = 720;
    if (widthRatio >= heightRatio) {
        return `${roundEven(shortSide * widthRatio / heightRatio)}x${shortSide}`;
    }
    return `${shortSide}x${roundEven(shortSide * heightRatio / widthRatio)}`;
}

function roundEven(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}
