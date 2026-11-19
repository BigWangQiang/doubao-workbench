import { isMiniMaxH3MaxModelName, type ModelProtocol } from "@/lib/model-protocols";
import { tencentMPSCostDoubleProfiles } from "@/lib/tencent-mps-pricing";

export type ModelCapabilityConfig = {
    version: number;
    image?: ImageCapabilityConfig;
    video?: VideoCapabilityConfig;
};

export type LocalManagerExecutionPlatform = "doubao" | "dola";

export type ImageSizeParameter = "none" | "size" | "aspect_ratio";

export type ImageCapabilityConfig = {
    requestFormat?: "openai" | "generations-json";
    references: {
        promptMaxChars: number;
        maxImages: number;
        maxImageBytes: number;
        maskSupported: boolean;
    };
    size: {
        parameter: ImageSizeParameter;
        values: string[];
        default: string;
        allowCustom: boolean;
    };
    quality: {
        supported: boolean;
        values: string[];
        default: string;
        resolutionProfiles?: ImageResolutionProfile[];
    };
    transparentBackground: { supported: boolean; default: boolean };
    responseFormat: { supported: boolean };
    outputFormat: { supported: boolean };
    maxOutputs: number;
};

export type ImageResolutionProfile = {
    resolution: string;
    unitPriceMicrocredits: number;
    upstreamModel?: string;
    channelId?: string;
    enabled?: boolean;
    default?: boolean;
    sortOrder?: number;
};

export type VideoCapabilityConfig = {
    executionPlatform?: LocalManagerExecutionPlatform;
    coloredPencilEnabled?: boolean;
    references: {
        promptMaxChars: number;
        maxImages: number;
        maxImageBytes: number;
        maxVideos: number;
        maxVideoBytes: number;
        maxVideoDurationSeconds: number;
        maxAudios: number;
        maxAudioBytes: number;
        maxAudioDurationSeconds: number;
    };
    duration: {
        selection: "range" | "enum";
        min?: number;
        max?: number;
        step?: number;
        values?: number[];
        default: number;
    };
    ratios: string[];
    defaultRatio: string;
    resolutions: string[];
    defaultResolution: string;
    resolutionProfiles?: VideoResolutionProfile[];
    generateAudio: { supported: boolean; default: boolean };
    watermark: { supported: boolean; default: boolean };
    operations: string[];
    defaultOperation: string;
};

/** 同一模型不同输出分辨率的计费与上游路由配置。为空时沿用模型级默认价格。 */
export type VideoResolutionProfile = {
    resolution: string;
    unitPriceMicrocredits: number;
    upstreamModel?: string;
    frameRatePrices?: VideoFrameRatePrice[];
};

export type VideoFrameRatePrice = {
    maxFps: number;
    unitPriceMicrocredits: number;
};

const defaultImageSizes = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "21:9", "9:16", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840"];

export function defaultImageCapabilityConfig(protocol?: ModelProtocol, model = ""): ImageCapabilityConfig {
    const image: ImageCapabilityConfig = {
        references: { promptMaxChars: 32000, maxImages: 16, maxImageBytes: 30 * 1024 * 1024, maskSupported: true },
        size: { parameter: "size", values: [...defaultImageSizes], default: "1:1", allowCustom: true },
        quality: { supported: true, values: ["auto", "1k", "2k", "4k"], default: "auto", resolutionProfiles: [] },
        transparentBackground: { supported: true, default: false },
        responseFormat: { supported: true },
        outputFormat: { supported: true },
        maxOutputs: 15,
    };
    if (protocol === "grok-image") {
        image.references.maxImages = 1;
        image.references.maskSupported = false;
        // grok2api / xAI Imagine：size→aspect_ratio，quality→resolution(1k/2k)。
        image.size = {
            parameter: "aspect_ratio",
            values: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"],
            default: "1:1",
            allowCustom: false,
        };
        image.quality = { supported: true, values: ["1k", "2k"], default: "2k" };
        image.transparentBackground = { supported: false, default: false };
        image.responseFormat = { supported: true };
        image.outputFormat = { supported: false };
        image.maxOutputs = 1;
    } else if (protocol === "gemini-image") {
        // Gemini 图片模型使用 generateContent；比例和分辨率通过 imageConfig 传递。
        image.references.maxImages = 14;
        image.references.maskSupported = false;
        image.size = {
            parameter: "aspect_ratio",
            values: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
            default: "1:1",
            allowCustom: false,
        };
        image.quality = { supported: true, values: ["1k", "2k", "4k"], default: "2k" };
        image.transparentBackground = { supported: false, default: false };
        image.responseFormat = { supported: false };
        image.outputFormat = { supported: false };
        image.maxOutputs = 1;
    } else if (protocol === "volcengine-ark-image") {
        image.references.maskSupported = false;
        image.quality.supported = false;
        image.transparentBackground.supported = false;
        image.responseFormat.supported = false;
        image.outputFormat.supported = false;
    }
    if (protocol === "volcengine-jimeng-image") {
        image.references.maxImages = 14;
        image.references.maskSupported = false;
        image.quality.supported = false;
        image.transparentBackground.supported = false;
        image.responseFormat.supported = false;
        image.outputFormat.supported = false;
    }
    if (protocol !== "grok-image" && model.trim().toLowerCase().startsWith("grok-imagine-image")) {
        image.references.maxImages = 0;
        image.references.maskSupported = false;
        image.size = {
            parameter: "aspect_ratio",
            values: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"],
            default: "1:1",
            allowCustom: false,
        };
        image.quality = { supported: true, values: ["1k", "2k"], default: "2k" };
        image.transparentBackground = { supported: false, default: false };
        image.responseFormat = { supported: true };
        image.outputFormat = { supported: false };
        image.maxOutputs = 1;
    }
    return image;
}

export function defaultModelCapabilityConfig(protocol?: ModelProtocol, model = ""): ModelCapabilityConfig {
    const video: VideoCapabilityConfig = {
        references: {
            promptMaxChars: 1000,
            maxImages: 9,
            maxImageBytes: 30 * 1024 * 1024,
            maxVideos: 0,
            maxVideoBytes: 0,
            maxVideoDurationSeconds: 0,
            maxAudios: 0,
            maxAudioBytes: 0,
            maxAudioDurationSeconds: 0,
        },
        duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p", "1080p", "2160p"],
        defaultResolution: "720p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
    };
    if (protocol === "volcengine-jimeng-video") video.duration = { selection: "enum", values: [5, 10], default: 5 };
    if (protocol === "local-manager") video.executionPlatform = "dola";
    if (protocol === "kling-cli-video") {
        // 后台填写模板，不代表账号已开通；提交由服务器按实时声明再次校验。
        const isV4 = model === "kling-video-v4_0";
        video.duration = { selection: "range", min: 3, max: isV4 ? 30 : 15, step: 1, default: isV4 ? 10 : 5 };
        video.ratios = isV4 ? ["16:9", "9:16", "1:1", "21:9"] : ["16:9", "9:16", "1:1"];
        video.resolutions = isV4 ? ["720p", "1080p"] : ["720p", "1080p", "2160p"];
        video.references.maxImages = isV4 ? 10 : 7;
        video.references.maxVideos = isV4 ? 5 : 1;
        video.references.maxAudios = isV4 ? 3 : 0;
        video.references.maxVideoBytes = 200 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = isV4 ? 15 : 10;
        video.references.maxAudioBytes = isV4 ? 15 * 1024 * 1024 : 0;
        video.references.maxAudioDurationSeconds = isV4 ? 15 : 0;
        video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    }
    if (protocol === "tencent-mps-video") {
        video.references = {
            ...video.references,
            maxImages: 0,
            maxVideos: 1,
            maxVideoBytes: 1024 * 1024 * 1024,
            maxVideoDurationSeconds: 3600,
            maxAudios: 0,
        };
        video.duration = { selection: "range", min: 1, max: 3600, step: 1, default: 60 };
        video.ratios = ["adaptive"];
        video.defaultRatio = "adaptive";
        video.resolutions = ["720p", "1080p", "1440p", "2160p"];
        video.resolutionProfiles = tencentMPSCostDoubleProfiles();
        video.defaultResolution = "720p";
        video.operations = ["reference_to_video"];
        video.defaultOperation = "reference_to_video";
    }
    if (protocol === "gemini-veo") {
        video.duration = { selection: "enum", values: [4, 6, 8], default: 6 };
        video.resolutions = ["720p", "1080p"];
    }
    if (protocol === "yuxibox-video") {
        video.references.promptMaxChars = 8000;
        video.references.maxImages = 30;
        video.references.maxVideos = 10;
        video.references.maxAudios = 10;
        video.references.maxVideoBytes = 20 * 1024 * 1024;
        video.references.maxAudioBytes = 20 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 30;
        video.references.maxAudioDurationSeconds = 15;
        video.duration = { selection: "range", min: 4, max: 30, step: 1, default: 30 };
        video.ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
        video.resolutions = ["720p", "1080p"];
        video.defaultResolution = "720p";
        video.generateAudio = { supported: false, default: true };
        video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
        video.defaultOperation = "text_to_video";
        const modelName = model.trim().split("/").pop()?.toLowerCase();
        if (modelName === "seedance-2.5（yx）-按次") {
            video.duration = { selection: "enum", values: [30], default: 30 };
            video.resolutions = ["720p"];
            video.references.promptMaxChars = 16000;
            video.ratios.push("adaptive");
        } else if (modelName === "seedance2.5-yx-count") {
            video.resolutions = ["720p"];
            video.references.promptMaxChars = 16000;
            video.ratios.push("adaptive");
        } else if (modelName === "seedance2.5-yx-stable") {
            video.resolutions = ["480p", "720p", "1080p"];
            video.references.promptMaxChars = 16000;
            video.ratios.push("adaptive");
            video.generateAudio.supported = true;
        }
    }
    if (protocol === "ljvideo-video") {
        video.references.promptMaxChars = 4000;
        video.references.maxImages = 9;
        video.references.maxImageBytes = 100 * 1024 * 1024;
        video.references.maxVideos = 0;
        video.references.maxAudios = 3;
        video.references.maxAudioBytes = 100 * 1024 * 1024;
        video.duration = { selection: "range", min: 5, max: 30, step: 1, default: 5 };
        video.resolutions = ["1080p"];
        video.defaultResolution = "1080p";
        video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    }
    if (protocol === "volcengine-ark-video" || protocol === "newapi-channel-1" || protocol === "newapi-channel-2") {
        video.references.maxVideos = 3;
        video.references.maxAudios = 3;
        video.references.maxVideoBytes = 200 * 1024 * 1024;
        video.references.maxAudioBytes = 15 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 15;
        video.references.maxAudioDurationSeconds = 15;
        video.generateAudio = { supported: true, default: true };
    }
    if (protocol === "mddkeji-video") {
        video.references.maxImages = 30;
        video.references.maxVideos = 10;
        video.references.maxAudios = 10;
        video.references.maxVideoBytes = 200 * 1024 * 1024;
        video.references.maxAudioBytes = 15 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 15;
        video.references.maxAudioDurationSeconds = 15;
        video.generateAudio = { supported: true, default: true };
        video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    }
    if (protocol === "volcengine-ark-video") video.watermark = { supported: true, default: false };
    if (protocol === "moziaverse-hailuo-video") {
        video.references.maxVideos = 1;
        video.references.maxAudios = 1;
        video.references.maxVideoBytes = 200 * 1024 * 1024;
        video.references.maxAudioBytes = 15 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 15;
        video.references.maxAudioDurationSeconds = 15;
        video.duration = { selection: "range", min: 4, max: 15, step: 1, default: 5 };
        video.ratios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
        video.resolutions = ["768p"];
        video.defaultResolution = "768p";
    }
	if (protocol === "minimax-v2-video") {
		video.references.promptMaxChars = 40000;
		video.references.maxImages = 9;
		video.references.maxVideos = 3;
		video.references.maxVideoBytes = 50 * 1024 * 1024;
		video.references.maxVideoDurationSeconds = 15;
		video.references.maxAudios = 3;
		video.references.maxAudioBytes = 15 * 1024 * 1024;
		video.references.maxAudioDurationSeconds = 15;
		video.duration = { selection: "range", min: 4, max: 15, step: 1, default: 5 };
		video.ratios = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
		video.defaultRatio = "16:9";
		video.resolutions = ["768p", "2K"];
		video.defaultResolution = "768p";
		video.watermark = { supported: true, default: false };
		video.operations = ["text_to_video", "image_to_video", "reference_to_video", "h3_context_ir_text", "h3_context_ir_image", "h3_context_ir_reference", "video_regeneration_task", "video_regeneration_text", "video_regeneration_image", "video_regeneration_reference"];
		video.defaultOperation = "text_to_video";
	}
	if (protocol === "minimax-v2-video" && isMiniMaxH3MaxModelName(model)) {
		video.duration = { selection: "range", min: 5, max: 15, step: 1, default: 5 };
		video.resolutions = ["480p", "768p"];
		video.defaultResolution = "768p";
	}
    return { version: 1, image: defaultImageCapabilityConfig(protocol, model), video };
}

export function modelCapabilityConfigFor(config: { channels: Array<{ id: string; models: string[]; modelCosts?: Array<{ model: string; capabilityConfig?: ModelCapabilityConfig; protocol?: ModelProtocol }> }> }, model: string) {
    const separator = model.indexOf("::");
    const channelId = separator >= 0 ? model.slice(0, separator) : "";
    const modelName = separator >= 0 ? model.slice(separator + 2) : model;
    const channel = config.channels.find((item) => item.id === channelId) || config.channels.find((item) => item.models.includes(modelName));
    const cost = channel?.modelCosts?.find((item) => item.model === modelName);
    const fallback = defaultModelCapabilityConfig(cost?.protocol, modelName);
    const resolved = cost?.capabilityConfig
        ? {
              ...fallback,
              ...cost.capabilityConfig,
              image: cost.capabilityConfig.image ? mergeImageCapabilityConfig(fallback.image!, cost.capabilityConfig.image) : fallback.image,
              video: cost.capabilityConfig.video ? mergeVideoCapabilityConfig(fallback.video!, cost.capabilityConfig.video) : fallback.video,
          }
        : fallback;
    if (cost?.protocol === "mddkeji-video" && resolved.video) {
        resolved.video = {
            ...resolved.video,
            references: {
                ...resolved.video.references,
                maxImages: 30,
                maxVideos: 10,
                maxAudios: 10,
            },
        };
    }
    if (resolved.image) {
        const image = resolved.image;
        const values = Array.from(new Set((image.quality.values || []).map(normalizeImageQuality).filter(Boolean)));
        if (image.quality.supported && values.length === 0) values.push("auto", "1k", "2k", "4k");
        const defaultQuality = normalizeImageQuality(image.quality.default) || values[0] || "auto";
        resolved.image = {
            ...image,
            quality: {
                ...image.quality,
                values,
                default: values.includes(defaultQuality) ? defaultQuality : values[0] || "auto",
                resolutionProfiles: (image.quality.resolutionProfiles || []).map((item) => ({ ...item, resolution: normalizeImageQuality(item.resolution), enabled: item.enabled !== false })),
            },
        };
    }
    const video = resolved.video;
    if (!video) return resolved;
    const canonicalResolutions = Array.from(
        new Set(
            video.resolutions
                .map((value) => canonicalVideoResolution(video.resolutions, value))
                .filter((value): value is string => Boolean(value)),
        ),
    );
    const resolutionValues = canonicalResolutions.length ? canonicalResolutions : video.resolutions;
    const canonicalDefaultResolution = canonicalVideoResolution(resolutionValues, video.defaultResolution) || resolutionValues[0] || video.defaultResolution;
    const canonicalProfiles = (video.resolutionProfiles || [])
        .map((item) => {
            const resolution = canonicalVideoResolution(resolutionValues, item.resolution);
            return resolution ? { ...item, resolution } : null;
        })
        .filter((item): item is VideoResolutionProfile => Boolean(item));
    const normalizedVideo = {
        ...video,
        resolutions: resolutionValues,
        defaultResolution: canonicalDefaultResolution,
        resolutionProfiles: canonicalProfiles,
    };
    if (!canonicalProfiles.length) return { ...resolved, video: normalizedVideo };
    const routedResolutions = canonicalProfiles.map((item) => item.resolution).filter((item) => resolutionValues.includes(item));
    if (routedResolutions.length === 0) return { ...resolved, video: normalizedVideo };
    return {
        ...resolved,
        video: {
            ...normalizedVideo,
            resolutions: routedResolutions,
            defaultResolution: routedResolutions.includes(canonicalDefaultResolution) ? canonicalDefaultResolution : routedResolutions[0],
        },
    };
}

function mergeImageCapabilityConfig(base: ImageCapabilityConfig, override: ImageCapabilityConfig): ImageCapabilityConfig {
    return {
        ...base,
        ...override,
        references: { ...base.references, ...override.references },
        size: { ...base.size, ...override.size, values: override.size?.values || base.size.values },
        quality: {
            ...base.quality,
            ...override.quality,
            values: override.quality?.values || base.quality.values,
            resolutionProfiles: override.quality?.resolutionProfiles || base.quality.resolutionProfiles,
        },
        transparentBackground: { ...base.transparentBackground, ...override.transparentBackground },
        responseFormat: { ...base.responseFormat, ...override.responseFormat },
        outputFormat: { ...base.outputFormat, ...override.outputFormat },
    };
}

function mergeVideoCapabilityConfig(base: VideoCapabilityConfig, override: VideoCapabilityConfig): VideoCapabilityConfig {
    return {
        ...base,
        ...override,
        references: { ...base.references, ...override.references },
        duration: { ...base.duration, ...override.duration, values: override.duration?.values || base.duration.values },
        ratios: override.ratios || base.ratios,
        resolutions: override.resolutions || base.resolutions,
        resolutionProfiles: override.resolutionProfiles || base.resolutionProfiles,
        generateAudio: { ...base.generateAudio, ...override.generateAudio },
        watermark: { ...base.watermark, ...override.watermark },
    };
}

export function normalizeImageValue(profile: ImageCapabilityConfig, value: { size?: string; quality?: string; count?: string; transparentBackground?: string }) {
    const size = normalizeImageSizeSetting(profile, value.size);
    const requestedQuality = normalizeImageQuality(value.quality);
    const quality = profile.quality.supported
        ? requestedQuality && profile.quality.values.includes(requestedQuality)
            ? requestedQuality
            : normalizeImageQuality(profile.quality.default) || "auto"
        : normalizeImageQuality(profile.quality.default) || "auto";
    const count = String(Math.max(1, Math.min(profile.maxOutputs, Math.floor(Math.abs(Number(value.count)) || 1))));
    const transparentBackground = profile.transparentBackground.supported && value.transparentBackground === "true" ? "true" : "false";
    return { size, quality, count, transparentBackground };
}

export function normalizeImageQuality(value?: string) {
    switch (
        String(value || "")
            .trim()
            .toLowerCase()
    ) {
        case "auto":
        case "automatic":
            return "auto";
        case "1k":
        case "low":
        case "standard":
            return "1k";
        case "2k":
        case "medium":
        case "hd":
            return "2k";
        case "4k":
        case "high":
        case "ultra":
            return "4k";
        default:
            return "";
    }
}

export function normalizeImageSizeSetting(profile: ImageCapabilityConfig, value?: string) {
    if (profile.size.parameter === "none") return "auto";
    const candidate = value?.trim() || profile.size.default;
    if (profile.size.allowCustom || profile.size.values.includes(candidate)) return candidate;
    return profile.size.default || profile.size.values[0] || "auto";
}

export function imageSizeRequest(profile: ImageCapabilityConfig, value?: string) {
    const parameter = profile.size.parameter;
    if (parameter === "none") return undefined;
    const normalized = normalizeImageSizeSetting(profile, value);
    if (!normalized || normalized === "auto") return undefined;
    return { parameter, value: normalized };
}

export function normalizeVideoValue(profile: VideoCapabilityConfig, value: { seconds?: string; ratio?: string; resolution?: string }) {
    const duration = profile.duration.selection === "enum" ? ((profile.duration.values || []).includes(Number(value.seconds)) ? Number(value.seconds) : profile.duration.default) : normalizeRangeDuration(profile, Number(value.seconds));
    const requestedRatio = normalizeVideoRatio(value.ratio);
    const matchedRatio = profile.ratios.find((item) => normalizeVideoRatio(item) === requestedRatio);
    const ratio = matchedRatio ? normalizeVideoRatio(matchedRatio) : normalizeVideoRatio(profile.defaultRatio) || profile.defaultRatio;
    const resolution = normalizeVideoResolutionForProfile(profile, value.resolution);
    return { seconds: String(duration), ratio, resolution };
}

export function normalizeVideoRatio(value: string | undefined) {
    const token = String(value || "").trim().toLowerCase().replace(/\u00d7/g, "x");
    if (!token || token === "auto") return token === "auto" ? "adaptive" : "";
    const ratioMatch = token.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (ratioMatch) {
        const width = Number(ratioMatch[1]);
        const height = Number(ratioMatch[2]);
        return width > 0 && height > 0 ? `${width}:${height}` : token;
    }
    const sizeMatch = token.match(/^(\d+)x(\d+)$/);
    if (!sizeMatch) return token;
    const width = Number(sizeMatch[1]);
    const height = Number(sizeMatch[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return token;
    const aspect = width / height;
    const knownRatios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "2:3"];
    const closest = knownRatios.reduce<{ value: string; distance: number } | null>((best, candidate) => {
        const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
        const distance = Math.abs(aspect - candidateWidth / candidateHeight);
        return !best || distance < best.distance ? { value: candidate, distance } : best;
    }, null);
    if (closest && closest.distance <= 0.02) return closest.value;
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
    return right ? greatestCommonDivisor(right, left % right) : Math.max(1, left);
}

export function normalizeVideoResolutionForProfile(profile: VideoCapabilityConfig, value?: string) {
    return canonicalVideoResolution(profile.resolutions, value) || profile.defaultResolution || profile.resolutions[0] || "";
}

function canonicalVideoResolution(values: string[], value?: string) {
    const key = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/p$/i, "");
    if (!key) return "";
    const candidates = key === "2k" || key === "2160" ? ["2k", "2160", key] : key === "720" || key === "768" ? ["768", "720", key] : [key];
    for (const candidate of candidates) {
        const match = values.find((item) => String(item).trim().toLowerCase().replace(/\s+/g, "").replace(/p$/i, "") === candidate);
        if (match) return match;
    }
    return "";
}

function normalizeRangeDuration(profile: VideoCapabilityConfig, value: number) {
    const min = profile.duration.min || 1;
    const max = profile.duration.max || min;
    const step = profile.duration.step || 1;
    const candidate = Number.isFinite(value) ? Math.floor(value) : profile.duration.default;
    const clamped = Math.min(max, Math.max(min, candidate));
    const maxStep = Math.max(0, Math.floor((max - min) / step));
    return min + Math.min(maxStep, Math.max(0, Math.round((clamped - min) / step))) * step;
}

export function videoDurationOptions(profile: VideoCapabilityConfig) {
    if (profile.duration.selection === "enum") return profile.duration.values || [];
    const min = profile.duration.min || 1;
    const max = profile.duration.max || min;
    const step = profile.duration.step || 1;
    return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, index) => min + index * step);
}

export function videoDurationAllowed(profile: VideoCapabilityConfig, value: number) {
    if (profile.duration.selection === "enum") return (profile.duration.values || []).includes(value);
    const min = profile.duration.min || 1;
    const max = profile.duration.max || min;
    const step = profile.duration.step || 1;
    return value >= min && value <= max && (value - min) % step === 0;
}
