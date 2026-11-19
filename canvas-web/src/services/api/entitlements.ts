import { apiClient, request } from "./request";

export type EntitlementBadgeKey = "creator" | "official" | "promoter";

export type EntitlementBadge = {
    key: EntitlementBadgeKey;
    label: string;
    icon: "sparkles" | "badge-check" | "megaphone" | string;
    tone: "amber" | "green" | "pink" | string;
    grantedAt: string;
};

export type EntitlementBadgeDefinition = {
    key: EntitlementBadgeKey;
    label: string;
    icon: EntitlementBadge["icon"];
    tone: EntitlementBadge["tone"];
    description: string;
    evidenceTip: string;
};

export type EntitlementApplicationStatus = "pending" | "approved" | "rejected";

export type EntitlementApplication = {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    badgeKey: EntitlementBadgeKey;
    badgeLabel: string;
    note: string;
    evidenceUrl?: string;
    status: EntitlementApplicationStatus;
    reviewNote?: string;
    reviewedBy?: string;
    reviewedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminEntitlementBadge = {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    badgeKey: EntitlementBadgeKey;
    badgeLabel: string;
    icon: string;
    tone: string;
    source: string;
    grantedBy?: string;
    grantedAt: string;
};

export function getEntitlementCatalog() {
    return request<{ badges: EntitlementBadgeDefinition[] }>(apiClient.get("/entitlements/catalog"));
}

export function submitEntitlementApplication(input: { badgeKey: EntitlementBadgeKey; note: string; evidenceUrl?: string }) {
    return request<{ application: EntitlementApplication }>(apiClient.post("/entitlements/applications", input));
}

export function listMyEntitlementApplications() {
    return request<{ applications: EntitlementApplication[] }>(apiClient.get("/entitlements/applications/mine"));
}

export function listAdminEntitlementApplications(params: { status?: "all" | EntitlementApplicationStatus; page?: number; limit?: number } = {}) {
    return request<{ applications: EntitlementApplication[]; total: number; page: number; limit: number }>(apiClient.get("/admin/entitlements/applications", { params }));
}

export function listAdminEntitlementBadges(params: { page?: number; limit?: number } = {}) {
    return request<{ badges: AdminEntitlementBadge[]; total: number; page: number; limit: number }>(apiClient.get("/admin/entitlements/badges", { params }));
}

export function reviewAdminEntitlementApplication(id: string, input: { status: "approved" | "rejected"; note?: string }) {
    return request<{ application: EntitlementApplication }>(apiClient.patch(`/admin/entitlements/applications/${encodeURIComponent(id)}`, input));
}

export function grantAdminEntitlementBadge(userId: string, badgeKey: EntitlementBadgeKey) {
    return request<{ badge: EntitlementBadge }>(apiClient.post(`/admin/users/${encodeURIComponent(userId)}/entitlement-badges`, { badgeKey }));
}
