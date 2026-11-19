import { requestCreditEstimate, type RequestCreditEstimate } from "@/constant/credits";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { VIRAL_VIDEO_ANALYSIS_CREDITS } from "@/lib/canvas/canvas-viral-video-policy";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

// 与实际生成共用参数归一化，避免参考片 2 秒镜头被模型调整到 5 秒后仍按 2 秒显示费用。
export function estimateViralVideoGeneration(config: AiConfig, mode: "text" | "image" | "video", rows: StoryboardRow[], script?: CanvasNodeData): RequestCreditEstimate {
    if (mode === "text") return { kind: "exact", credits: VIRAL_VIDEO_ANALYSIS_CREDITS };
    if (!rows.length) return { kind: "exact", credits: 0 };
    const estimates = rows.map((row) => {
        const model = mode === "image" ? config.imageModel : config.videoModel;
        const target: CanvasNodeData = { id: "estimate", title: "", type: mode === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 0, height: 0, metadata: { model, seconds: String(row.durationSeconds || config.videoSeconds), size: script?.metadata?.size, count: 1 } };
        const normalized = buildGenerationConfig(config, target, mode);
        const channel = resolveModelChannel(config, normalized.model);
        return requestCreditEstimate({ channelMode: channel.scope === "system" ? "remote" : "local", modelCosts: channel.modelCosts, model: modelOptionName(normalized.model), count: 1, seconds: normalized.videoSeconds, resolution: mode === "video" ? normalized.vquality : mode === "image" ? normalized.quality : undefined });
    });
    return estimates.find((estimate) => estimate.kind !== "exact") || { kind: "exact", credits: estimates.reduce((sum, estimate) => sum + (estimate.kind === "exact" ? estimate.credits : 0), 0) };
}

export function viralVideoEstimateText(estimate: RequestCreditEstimate) {
    if (estimate.kind === "exact") return `预计 ${estimate.credits.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分，最终按服务端计价结算`;
    if (estimate.kind === "usage") return "按当前后台模型配置和实际用量结算";
    if (estimate.kind === "not_applicable") return "自定义渠道，平台不扣积分";
    return "当前模型计价不可用，请先检查模型配置";
}
