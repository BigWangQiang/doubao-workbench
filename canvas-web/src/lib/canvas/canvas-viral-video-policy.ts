import { encodeChannelModel, type AiConfig } from "@/stores/use-config-store";

export const VIRAL_VIDEO_ANALYSIS_MODEL = "deepseek-v4.1-flash";
export const VIRAL_VIDEO_ANALYSIS_MODEL_LABEL = "DeepSeek V4.1 Flash";
export const VIRAL_VIDEO_ANALYSIS_CREDITS = 10;

// 只使用管理员提供的同名系统模型，不回退到用户当前选中的模型或个人渠道。
export function resolveViralVideoAnalysisModel(config: AiConfig): string | null {
    const channel = config.channels.find((item) => item.scope === "system" && item.enabled !== false
        && item.type !== "local_manager" && item.models.includes(VIRAL_VIDEO_ANALYSIS_MODEL)
        && item.modelCosts?.some((cost) => cost.model === VIRAL_VIDEO_ANALYSIS_MODEL && cost.capability === "text"));
    return channel ? encodeChannelModel(channel.id, VIRAL_VIDEO_ANALYSIS_MODEL) : null;
}
