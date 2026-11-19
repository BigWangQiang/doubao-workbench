export type MembershipTier = "trial" | "explore" | "creator" | "enterprise" | "supreme";

export type MembershipView = {
    tier: MembershipTier;
    tierLabel: string;
    planId?: string;
    planName?: string;
    source: "payment" | "admin" | string;
    active: boolean;
    startsAt: string;
    expiresAt: string;
};

export const membershipTierLabels: Record<MembershipTier, string> = {
    trial: "体验版",
    explore: "探索版",
    creator: "创作版",
    enterprise: "企业版",
    supreme: "至尊版",
};
