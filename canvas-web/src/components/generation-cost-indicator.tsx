import { Zap } from "lucide-react";
import type { RequestCreditEstimate } from "@/constant/credits";

type GenerationCostIndicatorProps = {
    estimate: RequestCreditEstimate;
    compact?: boolean;
};

export function GenerationCostIndicator({ estimate, compact = false }: GenerationCostIndicatorProps) {
    const content = estimateContent(estimate);
    return (
        <span className={`studio-generation-cost is-${estimate.kind}${compact ? " is-compact" : ""}`} data-credit-kind={estimate.kind} title={content.title} aria-label={content.title}>
            <span className="studio-generation-cost-symbol" aria-hidden="true"><Zap /></span>
            <span className="studio-generation-cost-value">{content.label}</span>
        </span>
    );
}

function estimateContent(estimate: RequestCreditEstimate) {
    if (estimate.kind === "exact") {
        const credits = estimate.credits.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
        const referenceNote = estimate.referenceVideoMultiplier ? `，含参考视频 ${estimate.referenceVideoMultiplier.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 倍计费` : "";
        return { label: credits, title: `生成时自动扣除 ${credits} 积分${referenceNote}` };
    }
    if (estimate.kind === "usage") return { label: "按量", title: "生成完成后按后台模型计费和实际用量扣除积分" };
    if (estimate.kind === "unconfigured") return { label: "未配置", title: "当前系统模型尚未配置计费，暂时无法确定扣除积分" };
    if (estimate.kind === "unavailable") return { label: "不可用", title: `${estimate.resolution || "当前"} 分辨率未配置接口或计费，无法生成` };
    return { label: "0", title: "当前使用自定义渠道，不扣除平台积分" };
}
