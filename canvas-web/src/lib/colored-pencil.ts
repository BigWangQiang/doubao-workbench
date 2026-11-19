import { requestCreditEstimate } from "@/constant/credits";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelOptionName, resolveModelChannel, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export const COLORED_PENCIL_TRANSFORM = "colored_pencil";

export function supportsColoredPencil(config: AiConfig, model: string) {
    const profile = modelCapabilityConfigFor(config, model).video;
    return resolveModelChannel(config, model).scope === "system" && profile?.coloredPencilEnabled === true && profile.references.maxImages > 0 && profile.operations.some((operation) => operation === "image_to_video" || operation === "reference_to_video");
}

export function coloredPencilModelConfig(config: AiConfig) {
    const model = selectableModelsByCapability(config, "image").find((value) => {
        const channel = resolveModelChannel(config, value);
        return modelOptionName(value) === "gpt-image-2" && channel.scope === "system" && channel.enabled !== false && channel.type !== "local_manager";
    });
    if (!model) throw new Error("后台尚未启用 GPT Image 2，暂时无法转彩铅");
    const profile = modelCapabilityConfigFor(config, model).image!;
    if (profile.references.maxImages < 1 || profile.size.parameter === "none") throw new Error("后台 GPT Image 2 未启用参考图或尺寸设置");
    // 选择器使用 channel::model 复合值；后端任务协议只能接收裸模型名，
    // 同时保留系统渠道 ID 让服务端解析真实上游凭据和协议。
    const requestConfig = resolveModelRequestConfig(config, model);
    // 下游会再次按裸模型名解析渠道；执行配置只携带选中的渠道，防止同名自定义渠道抢先匹配。
    const channel = resolveModelChannel(config, model);
    return { ...requestConfig, channels: [channel], model: modelOptionName(model), imageModel: modelOptionName(model), quality: profile.quality.default, count: "1", transparentBackground: "false", systemPrompt: "" };
}

export function coloredPencilEstimate(config: AiConfig, count: number) {
    const imageConfig = coloredPencilModelConfig(config);
    const channel = resolveModelChannel(imageConfig, imageConfig.model);
    return requestCreditEstimate({ channelMode: "remote", modelCosts: channel.modelCosts, model: modelOptionName(imageConfig.model), resolution: imageConfig.quality, count: Math.max(1, count) });
}

export function coloredPencilSourceKey(image: ReferenceImage) {
    return `${image.id}:${image.storageKey || "local"}`;
}

export function coloredPencilRatioMatches(originalWidth: number, originalHeight: number, width: number, height: number) {
    return originalWidth > 0 && originalHeight > 0 && width > 0 && height > 0 && Math.abs((width / height) / (originalWidth / originalHeight) - 1) <= 0.01;
}

