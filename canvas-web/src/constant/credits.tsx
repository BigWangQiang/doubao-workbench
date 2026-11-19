import type { ComponentProps } from "react";
import { Coins } from "lucide-react";
import type { ModelCapabilityConfig } from "@/lib/model-capabilities";

export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return (
        <span {...props} className={`inline-flex items-center justify-center ${className || ""}`}>
            <Coins className="size-[1em]" strokeWidth={2.2} />
        </span>
    );
}

export type ModelCreditCost = {
    model: string;
    billingMode: "fixed_request" | "per_second" | "per_minute" | "token";
    unitPriceMicrocredits: number;
    referenceVideoMultiplierBasisPoints?: number;
    capabilityConfig?: ModelCapabilityConfig;
};

export type RequestCreditEstimate = { kind: "exact"; credits: number; referenceVideoMultiplier?: number } | { kind: "usage" } | { kind: "unconfigured" } | { kind: "unavailable"; resolution?: string } | { kind: "not_applicable" };

function modelCreditCost(modelCosts: ModelCreditCost[] | undefined, model: string) {
    return modelCosts?.find((item) => item.model === model) || null;
}

export function formatCredits(value: number, maximumFractionDigits = 6) {
    return (value / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits });
}

export function requestCreditEstimate(options: { channelMode: string; modelCosts?: ModelCreditCost[]; model: string; count?: string | number; seconds?: string | number; resolution?: string; referenceVideoCount?: number; frameRate?: number }): RequestCreditEstimate {
    if (options.channelMode !== "remote") return { kind: "not_applicable" };
    const cost = modelCreditCost(options.modelCosts, options.model);
    if (!cost) return { kind: "unconfigured" };
    const profiles = cost.capabilityConfig?.video?.resolutionProfiles || cost.capabilityConfig?.image?.quality?.resolutionProfiles || [];
    let unitPriceMicrocredits = cost.unitPriceMicrocredits;
    if (profiles.length > 0) {
        const imageProfiles = cost.capabilityConfig?.image?.quality?.resolutionProfiles || [];
        const defaultImageResolution = cost.capabilityConfig?.image?.quality?.default || "auto";
        const requestedResolution = options.resolution || (imageProfiles.length > 0 ? defaultImageResolution : cost.capabilityConfig?.video?.defaultResolution || "");
        const normalizedRequestedResolution = normalizeResolutionToken(String(requestedResolution));
        const profile = profiles.find((item) => normalizeResolutionToken(item.resolution) === normalizedRequestedResolution && (!("enabled" in item) || item.enabled !== false))
            || (imageProfiles.length > 0 && normalizedRequestedResolution === "auto" ? imageProfiles.find((item) => item.default !== false && item.enabled !== false) || imageProfiles.find((item) => item.enabled !== false) : undefined);
        if (!profile) return { kind: "unavailable", resolution: options.resolution };
        unitPriceMicrocredits = profile.unitPriceMicrocredits;
    }
    if (options.frameRate !== undefined) {
        const frameRate = options.frameRate;
        if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 120) return { kind: "unavailable" };
        const profile = cost.capabilityConfig?.video?.resolutionProfiles?.find((item) => normalizeResolutionToken(item.resolution) === normalizeResolutionToken(options.resolution || ""));
        const price = profile?.frameRatePrices?.slice().sort((a, b) => a.maxFps - b.maxFps).find((item) => item.maxFps >= frameRate);
        if (!price || !Number.isSafeInteger(price.unitPriceMicrocredits) || price.unitPriceMicrocredits < 0) return { kind: "unconfigured" };
        unitPriceMicrocredits = price.unitPriceMicrocredits;
    }
    // Token 订单由服务端按请求体预授权并在 usage 返回后结算，前端不展示无依据的固定价格。
    if (cost.billingMode === "token") return { kind: "usage" };
    const seconds = Math.max(1, Math.floor(Math.abs(Number(options.seconds)) || 1));
    const quantity = cost.billingMode === "per_second" ? seconds : cost.billingMode === "per_minute" ? Math.max(1, Math.ceil(seconds / 60)) : Math.max(1, Math.floor(Math.abs(Number(options.count)) || 1));
    const referenceVideoCount = Math.max(0, Math.floor(Number(options.referenceVideoCount) || 0));
    const referenceVideoMultiplier = referenceVideoCount > 0 ? (cost.referenceVideoMultiplierBasisPoints || 10_000) / 10_000 : 1;
    return { kind: "exact", credits: (unitPriceMicrocredits / 1_000_000) * quantity * referenceVideoMultiplier, referenceVideoMultiplier: referenceVideoMultiplier > 1 ? referenceVideoMultiplier : undefined };
}

function normalizeResolutionToken(value: string) {
    return value.trim().toLowerCase().replace(/p$/i, "");
}

export function requestCreditCost(options: { channelMode: string; modelCosts?: ModelCreditCost[]; model: string; count?: string | number; seconds?: string | number; resolution?: string; referenceVideoCount?: number }) {
    const estimate = requestCreditEstimate(options);
    return estimate.kind === "exact" ? estimate.credits : null;
}
