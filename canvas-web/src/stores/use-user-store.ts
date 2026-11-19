import { create } from "zustand";

import { DEFAULT_DRAWING_ENGINE, type CanvasDrawingEngineSetting } from "@/lib/canvas/canvas-drawing-engine";
import type { MembershipView } from "@/types/membership";
import type { EntitlementBadge } from "@/services/api/entitlements";

export type LocalUser = {
    id: string;
    username: string;
    email?: string;
    phone?: string;
    displayName: string;
    bio?: string;
    avatarUrl?: string;
    identityProvider?: string;
    identityId?: string;
    identityUsername?: string;
    inviteCode?: string;
    role: "admin" | "user";
    status: "active" | "disabled";
    lastLoginAt?: string;
    createdAt?: string;
    updatedAt?: string;
    membership?: MembershipView | null;
    entitlementBadges?: EntitlementBadge[];
    agency?: AgencyAccess | null;
};

export type AgencyAccess = {
    enabled: boolean;
    accountId?: string;
    role?: "master" | "secondary";
    parentAgencyId?: string;
    status?: "active" | "disabled";
    displayName?: string;
    productCommissionRateBasisPoints?: number;
    subscriptionCommissionRateBasisPoints?: number;
};

export type RuntimeLimits = {
    activeTaskLimit: number;
    resourceUploadMB: number;
    sessionUploadMB: number;
};

export type FeatureAvailability = {
    shortDramaEnabled: boolean;
    agentBetaEnabled: boolean;
    taskCenterEnabled: boolean;
    creditsEnabled: boolean;
    configured?: boolean;
    updatedBy?: string;
    updatedAt?: string;
};

export const defaultFeatureAvailability: FeatureAvailability = {
    shortDramaEnabled: true,
    agentBetaEnabled: false,
    taskCenterEnabled: true,
    creditsEnabled: true,
};

type UserStore = {
    hydrated: boolean;
    user: LocalUser | null;
    runtimeLimits: RuntimeLimits;
    drawingEngine: CanvasDrawingEngineSetting;
    features: FeatureAvailability;
    setUser: (user: LocalUser | null) => void;
    setRuntimeLimits: (limits?: RuntimeLimits) => void;
    setDrawingEngine: (setting?: CanvasDrawingEngineSetting) => void;
    setFeatures: (features?: FeatureAvailability) => void;
    setHydrated: (hydrated: boolean) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    hydrated: false,
    user: null,
    runtimeLimits: { activeTaskLimit: 5, resourceUploadMB: 50, sessionUploadMB: 32 },
    drawingEngine: { defaultEngine: DEFAULT_DRAWING_ENGINE },
    features: defaultFeatureAvailability,
    setUser: (user) => set({ user }),
    setRuntimeLimits: (runtimeLimits) => set({ runtimeLimits: runtimeLimits || { activeTaskLimit: 5, resourceUploadMB: 50, sessionUploadMB: 32 } }),
    setDrawingEngine: (drawingEngine) => set({ drawingEngine: drawingEngine || { defaultEngine: DEFAULT_DRAWING_ENGINE } }),
    setFeatures: (features) => set({ features: features || defaultFeatureAvailability }),
    setHydrated: (hydrated) => set({ hydrated }),
    clearSession: () => set({ user: null, runtimeLimits: { activeTaskLimit: 5, resourceUploadMB: 50, sessionUploadMB: 32 }, drawingEngine: { defaultEngine: DEFAULT_DRAWING_ENGINE }, features: defaultFeatureAvailability }),
}));
