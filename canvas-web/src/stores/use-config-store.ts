import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { scopedLocalStorage } from "@/lib/user-scope";
import { isMiniMaxH3ModelName, modelProtocolCapability, normalizeModelProtocol, type ModelProtocol } from "@/lib/model-protocols";
import { normalizeVideoDuration, normalizeVideoResolution } from "@/lib/video-generation-options";
import type { ModelCapabilityConfig } from "@/lib/model-capabilities";

export type ApiCallFormat = "openai" | "gemini";
export type ChannelInterfaceType = ModelProtocol;
export type ChannelHeader = { name: string; value: string };

export type ModelChannel = {
    id: string;
    name: string;
    type?: "api" | "local_manager" | "kling_cli";
    baseUrl: string;
    apiKey: string;
    secretKey?: string;
    headers?: ChannelHeader[];
    apiFormat: ApiCallFormat;
    interfaceType?: ChannelInterfaceType;
    models: string[];
    scope?: "system" | "user";
    enabled?: boolean;
    hasApiKey?: boolean;
    hasSecretKey?: boolean;
    supportsMoziaApiKeyPool?: boolean;
    concurrencyLimit?: number;
    userConcurrencyLimit?: number;
    modelCosts?: Array<{
        model: string;
        logicalModelId?: string;
        displayName?: string;
        description?: string;
        categoryId?: string;
        categorySortOrder?: number;
        categoryBadgeText?: string;
        categoryBadgeTone?: "neutral" | "warning" | "success" | "info";
        familyName?: string;
        variantName?: string;
        sortOrder?: number;
        iconResourceId?: string;
        capability: ModelCapability;
        protocol?: ModelProtocol;
        billingMode: "fixed_request" | "per_second" | "per_minute" | "token";
        unitPriceMicrocredits: number;
        inputTokenPriceMicrocredits?: number;
        outputTokenPriceMicrocredits?: number;
        cachedTokenPriceMicrocredits?: number;
        referenceVideoMultiplierBasisPoints?: number;
        requiresMembership?: boolean;
        capabilityConfig?: ModelCapabilityConfig;
    }>;
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    audioReferenceStorageKey?: string;
    audioReferenceName?: string;
    audioReferenceMimeType?: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    transparentBackground: string;
    count: string;
    canvasImageCount: string;
};

export const CONFIG_STORE_KEY = "open_ai_canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

// 系统管理的公共模型目录使用固定 ID，供模型选择器区分公共目录和用户渠道。
export const PUBLIC_MODEL_CATALOG_ID = "managed";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: "默认渠道",
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: ["gpt-image-2", "grok-imagine-video", "gpt-5.5", "gpt-4o-mini-tts"],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    imageModels: ["default::gpt-image-2"],
    videoModels: ["default::grok-imagine-video"],
    textModels: ["default::gpt-5.5"],
    audioModels: ["default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "1:1",
    transparentBackground: "false",
    count: "1",
    canvasImageCount: "1",
};

type ConfigStore = {
    config: AiConfig;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    replaceConfig: (config: AiConfig) => void;
    mergeSystemChannels: (channels: ModelChannel[]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
};

export type ConfigStoreSnapshot = {
    config?: Partial<AiConfig>;
};

function isVideoModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return (
        value.includes("seedance") ||
        value.includes("video") ||
        value.includes("sora") ||
        value.includes("veo") ||
        value.includes("kling") ||
        value.includes("wan") ||
        value.includes("hailuo") ||
        value.includes("pika") ||
        value.includes("runway") ||
        value.includes("gen-3") ||
        value.includes("gen3") ||
        value.includes("hunyuan-video") ||
        value.includes("hunyuanvideo") ||
        value.includes("cogvideo") ||
        value.includes("mochi") ||
        value.includes("latte") ||
        value.includes("stable-video") ||
        value.includes("svd") ||
        value.includes("animatediff") ||
        value.includes("ltx-video") ||
        value.includes("ltxvideo") ||
        value.includes("minimax-video") ||
        value.includes("abab-video") ||
        isMiniMaxH3ModelName(value)
    );
}

function isImageModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return (
        !isVideoModelName(model) &&
        !isAudioModelName(model) &&
        (value.includes("seedream") ||
            value.includes("gpt-image") ||
            value.includes("image") ||
            value.includes("dall-e") ||
            value.includes("dalle") ||
            value.includes("imagen") ||
            value.includes("flux") ||
            value.includes("sdxl") ||
            value.includes("stable-diffusion") ||
            value.includes("midjourney") ||
            value.includes("nano-banana") ||
            value.includes("nanobanana") ||
            value.includes("ideogram") ||
            value.includes("recraft") ||
            value.includes("playground") ||
            value.includes("leonardo"))
    );
}

function isAudioModelName(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    if (!capability) return true;
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability, channels?: ModelChannel[]) {
    if (!capability) return models;
    return models.filter((model) => {
        const decoded = decodeChannelModel(model);
        const channel = decoded ? channels?.find((item) => item.id === decoded.channelId) : undefined;
        const modelName = decoded?.model || modelOptionName(model);
        const costEntry = channel?.modelCosts?.find((item) => item.model === modelName);
        // 协议层优先级最高：协议决定 API 端点，明确属于其他能力时直接排除，
        // 防止用户将 video/image/audio 协议的模型误标为 text 后混入文本下拉。
        const protocolCapability = modelProtocolCapability(costEntry?.protocol);
        if (protocolCapability) return protocolCapability === capability;
        // 渠道接口层：渠道级协议推断能力
        const channelCapability = capabilityForChannelInterface(channel?.interfaceType);
        if (channelCapability) return channelCapability === capability;
        // 配置能力层：用户显式标记的 capability
        const configuredCapability = costEntry?.capability;
        if (configuredCapability) return configuredCapability === capability;
        // 模型名启发式：最后回退
        return modelMatchesCapability(model, capability);
    });
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return filterModelsByCapability(config.models, capability, config.channels);
}

export function configuredModelMatchesCapability(config: AiConfig, model: string, capability?: ModelCapability) {
    const normalized = normalizeModelOptionValue(model, config.channels);
    if (!normalized || !config.models.includes(normalized)) return false;
    return capability ? selectableModelsByCapability(config, capability).includes(normalized) : true;
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    if (channel.id.startsWith("desktop-")) return Boolean(model.trim());
    if (channel.id === "lalor-api") return Boolean(model.trim() && channel.hasApiKey);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set) => ({
            config: defaultConfig,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            replaceConfig: (config) => set({ config }),
            mergeSystemChannels: (channels) =>
                set((state) => {
                    const systemChannels = channels.map((channel, index) =>
                        createModelChannel({
                            ...channel,
                            id: channel.id || `system-${index + 1}`,
                            name: channel.name || `系统渠道 ${index + 1}`,
                            scope: "system",
                            apiKey: channel.apiKey || "system",
                        }),
                    );
                    const userChannels = state.config.channels.filter((channel) => channel.scope !== "system");
                    return normalizeConfigSnapshot({ config: { ...state.config, channels: [...systemChannels, ...userChannels] } });
                }),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
        }),
        {
            name: CONFIG_STORE_KEY,
            storage: createJSONStorage(() => scopedLocalStorage),
            partialize: (state) => ({ config: state.config }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                return {
                    ...current,
                    ...normalizeConfigSnapshot({ config: persistedState.config }),
                };
            },
        },
    ),
);

export function normalizeConfigSnapshot(snapshot: ConfigStoreSnapshot | undefined = {}) {
    // 坏存储/旧版本快照可能是 undefined 或缺 config，兜底为 defaultConfig，保证渲染不崩溃
    const persistedConfig = (snapshot?.config || {}) as Partial<AiConfig>;
    const config = { ...defaultConfig, ...persistedConfig };
    const hasPersistedChannels = Array.isArray(persistedConfig.channels);
    if (!hasPersistedChannels) config.channels = [];
    const channels = normalizeChannels(config, !hasPersistedChannels);
    const models = modelOptionsFromChannels(channels);
    const imageModels = filterModelsByCapability(models, "image", channels);
    const videoModels = filterModelsByCapability(models, "video", channels);
    const textModels = filterModelsByCapability(models, "text", channels);
    const audioModels = filterModelsByCapability(models, "audio", channels);
    const model = normalizeSelectedModel(config.model || config.imageModel || config.textModel, channels, models);
    return {
        config: {
            ...config,
            channelMode: "local" as const,
            apiFormat: normalizeApiFormat(config.apiFormat),
            channels,
            models,
            model,
            imageModel: normalizeSelectedModel(config.imageModel || model, channels, imageModels),
            videoModel: normalizeSelectedModel(config.videoModel || "grok-imagine-video", channels, videoModels),
            textModel: normalizeSelectedModel(config.textModel || model, channels, textModels),
            audioModel: normalizeSelectedModel(config.audioModel || defaultConfig.audioModel, channels, audioModels),
            audioVoice: config.audioVoice || defaultConfig.audioVoice,
            audioFormat: config.audioFormat || defaultConfig.audioFormat,
            audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
            audioInstructions: config.audioInstructions || "",
            // 旧版全局 systemPrompt 会跨任务污染请求；提示词定制现已按 operation 由服务端编译。
            systemPrompt: "",
            videoSeconds: normalizeVideoDuration(config.videoSeconds),
            vquality: normalizeVideoResolution(config.vquality),
            videoGenerateAudio: config.videoGenerateAudio || "true",
            videoWatermark: config.videoWatermark || "false",
            transparentBackground: config.transparentBackground === "true" ? "true" : "false",
            canvasImageCount: config.canvasImageCount || defaultConfig.canvasImageCount,
            imageModels,
            videoModels,
            textModels,
            audioModels,
        },
    };
}

function normalizeSelectedModel(value: string, channels: ModelChannel[], options: string[]) {
    const model = normalizeModelOptionValue(value, channels);
    return model && options.includes(model) ? model : options[0] || "";
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const interfaceType = normalizeChannelInterfaceType(channel?.interfaceType);
    const providedBaseUrl = channel?.baseUrl?.trim();
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || "新渠道",
        baseUrl: providedBaseUrl || (interfaceType ? defaultBaseUrlForChannelInterface(interfaceType) : defaultBaseUrlForApiFormat(apiFormat)),
        apiKey: channel?.apiKey || "",
        secretKey: channel?.secretKey || "",
        headers: Array.isArray(channel?.headers) ? channel.headers.map((header) => ({ name: String(header.name || ""), value: String(header.value || "") })) : [],
        apiFormat,
        interfaceType,
        models: uniqueRawModels(channel?.models || []),
        scope: channel?.scope === "system" ? "system" : "user",
        enabled: channel?.enabled !== false,
        hasApiKey: channel?.hasApiKey,
        hasSecretKey: channel?.hasSecretKey,
        modelCosts: channel?.modelCosts?.map((item) => ({ ...item, protocol: normalizeModelProtocol(item.protocol) })),
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelDisplayName(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === model);
    const displayName = cost?.displayName?.trim();
    if (displayName) return publicModelLabel(displayName, model);
    return channel.scope === "system" ? "系统模型" : friendlyModelName(model);
}

export function modelDescription(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    return channel.modelCosts?.find((item) => item.model === model)?.description?.trim() || "";
}

export function modelFamilyName(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === model);
    const display = publicModelLabel(cost?.familyName?.trim() || cost?.displayName?.trim() || model, model);
    // Older channel snapshots may have stored the resolution suffix in
    // familyName (for example "gpt-image-2-4k"). Always normalize the
    // configured family through the same compatibility path so those legacy
    // entries still collapse into one main model in the picker.
    return deriveModelFamilyName(publicModelLabel(cost?.familyName?.trim() || display, model), model);
}

export function modelVariantName(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === model);
    if (cost?.variantName?.trim()) return publicModelLabel(cost.variantName.trim(), model);
    const display = modelDisplayName(config, value);
    const family = modelFamilyName(config, value);
    if (display !== family) return display;
    if (model !== family) return friendlyModelName(model);
    return "默认型号";
}

export function modelCategoryId(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    return channel.modelCosts?.find((item) => item.model === model)?.categoryId || "";
}

export type ModelCategoryBadge = {
    text: string;
    tone: "neutral" | "warning" | "success" | "info";
};

export function modelCategoryBadge(config: AiConfig, value: string): ModelCategoryBadge | null {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === model);
    const text = cost?.categoryBadgeText?.trim() || "";
    if (!text) return null;
    const tone = cost?.categoryBadgeTone;
    return {
        text,
        tone: tone === "warning" || tone === "success" || tone === "info" ? tone : "neutral",
    };
}

export function modelRequiresMembership(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    if (channel.scope !== "system") return false;
    return channel.modelCosts?.find((item) => item.model === model)?.requiresMembership === true;
}

function deriveModelFamilyName(displayName: string, modelName: string) {
    const model = modelName.trim();
    const display = displayName.trim();
    const suffix = /(?:[-_\s])(?:1k|2k|4k)$/i;
    const base = suffix.test(model) ? display.replace(suffix, "").trim() || model.replace(suffix, "").trim() : display || model;
    const normalized = base
        .toLowerCase()
        .replace(/[_.-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (normalized === "gpt image 2") return "GPT Image 2";
    if (normalized === "nano banana 2" || normalized === "nanobanana 2") return "Nano Banana 2";
    if (normalized === "seedream 5" || normalized === "seedream 5 0") return "Seedream 5.0";
    if (normalized === "seedance 2" || normalized === "seedance 2 5") return "Seedance 2.5";
    return base;
}

/**
 * 模型标识只用于路由和计费；下拉菜单、任务记录等用户界面统一使用友好名称。
 * 后台未配置 displayName 时也不能把带连字符的 API slug 原样泄露给用户。
 */
export function friendlyModelName(value: string) {
    const raw = modelOptionName(value).trim();
    if (!raw) return "未命名模型";
    const withoutResolution = raw.replace(/(?:[-_\s])(?:1k|2k|4k)$/i, "");
    const normalized = withoutResolution
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const compact = normalized.toLowerCase();
    if (compact === "gpt image 2") return "GPT Image 2";
    if (compact === "nano banana 2" || compact === "nanobanana 2") return "Nano Banana 2";
    if (compact === "seedream 5" || compact === "seedream 5 0") return "Seedream 5.0";
    if (compact === "seedance 2" || compact === "seedance 2 5") return "Seedance 2.5";
    if (/[\u3400-\u9fff]/.test(raw)) return raw;
    const withVersionDots = normalized.replace(/\b(\d+)\s+(\d+)\b/g, "$1.$2");
    const tokenMap: Record<string, string> = {
        ai: "AI",
        api: "API",
        claude: "Claude",
        deepseek: "DeepSeek",
        dall: "DALL",
        dalle: "DALL-E",
        flux: "FLUX",
        gemini: "Gemini",
        glm: "GLM",
        gpt: "GPT",
        grok: "Grok",
        h3: "H3",
        imagen: "Imagen",
        kling: "Kling",
        midjourney: "Midjourney",
        nano: "Nano",
        openai: "OpenAI",
        pika: "Pika",
        runway: "Runway",
        sd: "SD",
        seedance: "Seedance",
        seedream: "Seedream",
        sora: "Sora",
        veo: "Veo",
        wan: "Wan",
    };
    return (
        withVersionDots
            .split(" ")
            .map((token) => tokenMap[token.toLowerCase()] || (/^[a-z]/i.test(token) ? `${token.charAt(0).toUpperCase()}${token.slice(1)}` : token))
            .join(" ") || raw
    );
}

function publicModelLabel(value: string, model: string) {
    const label = value.trim();
    if (!label) return friendlyModelName(model);
    const normalizedLabel = label.toLowerCase().replace(/[._\-\s]+/g, "");
    const normalizedModel = model.toLowerCase().replace(/[._\-\s]+/g, "");
    return normalizedLabel === normalizedModel ? friendlyModelName(model) : friendlyModelName(label);
}

export function modelIconResourceId(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    return channel.modelCosts?.find((item) => item.model === model)?.iconResourceId?.trim() || "";
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return modelDisplayName(config, value);
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    const displayName = modelDisplayName(config, value);
    return channel ? `${displayName}（${channel.name}）` : displayName;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(
        channels.flatMap((channel) =>
            channel.models
                .map(normalizeRawModelName)
                .filter(Boolean)
                .filter((model) => channel.scope !== "system" || hasSystemModelPrice(channel, model))
                .map((model) => encodeChannelModel(channel.id, model)),
        ),
    );
}

export function hasSystemModelPrice(channel: ModelChannel, model: string) {
    if (channel.scope !== "system") return true;
    return channel.modelCosts?.some((item) => item.model === model && Number.isFinite(item.unitPriceMicrocredits) && item.unitPriceMicrocredits >= 0) === true;
}

export function normalizeModelOptionValue(value: unknown, channels: ModelChannel[]) {
    const model = typeof value === "string" ? value.trim() : "";
    if (!normalizeRawModelName(model)) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.includes(decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.includes(model)) || channels[0];
    return channel && channel.models.includes(model) ? encodeChannelModel(channel.id, model) : "";
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.includes(model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: "默认渠道", baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName) });
}

export function logicalModelIDForConfig(config: AiConfig) {
    const channel = resolveModelChannel(config, config.model);
    return channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.logicalModelId || "";
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    const model = modelOptionName(value || config.model);
    const modelProtocol = channel.modelCosts?.find((item) => item.model === model)?.protocol;
    const interfaceType = modelProtocol || channel.interfaceType;
    return {
        ...config,
        model,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        secretKey: channel.secretKey,
        headers: channel.headers,
        apiFormat: interfaceType ? (interfaceType === "gemini-veo" || interfaceType === "gemini-image" ? ("gemini" as const) : ("openai" as const)) : channel.apiFormat,
        interfaceType,
        channelId: channel.id,
    };
}

function normalizeChannels(config: AiConfig, ensureDefault = true) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels
        .map((channel, index) =>
            createModelChannel({
                ...channel,
                id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
                name: channel.name || (index === 0 ? "默认渠道" : `渠道 ${index + 1}`),
                models: uniqueRawModels(channel.models || []),
            }),
        )
        .filter((channel) => !isEmptyDefaultChannel(channel));
    if (!channels.length && ensureDefault && config.apiKey.trim()) {
        channels.push(
            createModelChannel({
                id: "default",
                name: "默认渠道",
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: uniqueRawModels([...(config.models || []), config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel]),
            }),
        );
    }
    return channels.map((channel) => ({ ...channel, models: uniqueRawModels(channel.models) }));
}

function isEmptyDefaultChannel(channel: ModelChannel) {
    if (channel.scope === "system") return false;
    if (channel.id !== "default" || channel.name.trim() !== "默认渠道" || channel.apiKey.trim()) return false;
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const defaultBaseUrl = defaultConfig.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl && baseUrl !== defaultBaseUrl) return false;
    const defaultModels = new Set((defaultConfig.channels[0]?.models || []).map(modelOptionName));
    return !channel.models.length || channel.models.every((model) => defaultModels.has(modelOptionName(model)));
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    return apiFormat === "gemini" ? GEMINI_BASE_URL : OPENAI_BASE_URL;
}

export function defaultBaseUrlForChannelInterface(interfaceType?: ChannelInterfaceType) {
    if (interfaceType === "local-manager") return "";
    if (interfaceType === "gemini-veo" || interfaceType === "gemini-image") return GEMINI_BASE_URL;
    if (interfaceType === "volcengine-ark-image" || interfaceType === "volcengine-ark-video") return "https://ark.cn-beijing.volces.com/api/v3";
    if (interfaceType === "volcengine-jimeng-image" || interfaceType === "volcengine-jimeng-video") return "https://visual.volcengineapi.com";
    if (interfaceType === "index-tts-v2") return "https://mzsjai.com";
    if (interfaceType === "grok-image" || interfaceType === "newapi" || interfaceType === "newapi-channel-1" || interfaceType === "newapi-channel-2" || interfaceType === "xai-video") return "";
    return OPENAI_BASE_URL;
}

function capabilityForChannelInterface(interfaceType?: ChannelInterfaceType): ModelCapability | undefined {
    return modelProtocolCapability(interfaceType);
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? "gemini" : "openai";
}

function normalizeChannelInterfaceType(value: unknown): ChannelInterfaceType | undefined {
    return normalizeModelProtocol(value);
}

function uniqueRawModels(models: string[]) {
    return Array.from(new Set((models || []).map(normalizeRawModelName).filter(Boolean)));
}

function uniqueModelOptions(models: string[]) {
    return Array.from(
        new Set(
            (models || [])
                .filter((model): model is string => typeof model === "string")
                .map((model) => model.trim())
                .filter(Boolean),
        ),
    );
}

function normalizeRawModelName(value: unknown) {
    if (typeof value !== "string") return "";
    const model = modelOptionName(value).trim();
    return model && model !== "undefined" && model !== "null" ? model : "";
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = resolveBackendApiUrl(baseUrl).replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = isSystemProxyBaseUrl(normalizedBaseUrl) || lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

export function resolveBackendApiUrl(value: string) {
    const url = value.trim();
    if (!url.startsWith("/api/")) return url;
    const backendBaseUrl = String(import.meta.env.VITE_CANVAS_BACKEND_URL || "/api")
        .trim()
        .replace(/\/+$/, "");
    return backendBaseUrl === "/api" ? url : `${backendBaseUrl}${url.slice("/api".length)}`;
}

export function isSystemProxyBaseUrl(baseUrl: string) {
    const marker = "/api/ai/system/";
    const index = baseUrl.toLowerCase().indexOf(marker);
    if (index < 0) return false;
    const channelId = baseUrl.slice(index + marker.length);
    return Boolean(channelId && !channelId.includes("/") && !channelId.includes("?") && !channelId.includes("#"));
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
