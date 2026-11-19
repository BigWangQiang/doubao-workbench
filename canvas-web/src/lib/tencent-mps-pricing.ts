import type { VideoResolutionProfile } from "@/lib/model-capabilities";

// 中国大陆 H.264 超分加普通转码，按 1 积分 = 0.1 元、成本两倍填入。
// 仅供管理员显式应用，已有售价不会被前端自动覆盖；COS 浮动费用不含在内。
export function tencentMPSCostDoubleProfiles(): VideoResolutionProfile[] {
    const rows = [
        { resolution: "720p", prices: [6.65, 10.65, 22.65] },
        { resolution: "1080p", prices: [13.26, 25.26, 49.26] },
        { resolution: "1440p", prices: [24.72, 44.72, 88.72] },
        { resolution: "2160p", prices: [53.56, 101.56, 197.56] },
    ];
    return rows.map(({ resolution, prices }) => ({
        resolution,
        unitPriceMicrocredits: Math.round(prices[0] * 1_000_000),
        frameRatePrices: [30, 60, 120].map((maxFps, index) => ({ maxFps, unitPriceMicrocredits: Math.round(prices[index] * 1_000_000) })),
    }));
}
