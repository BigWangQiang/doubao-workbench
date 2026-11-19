import type { ModelChannel } from "@/stores/use-config-store";
import type { CreditLedgerEntry } from "@/services/api/wallet";
import type { GenerationTask, TaskStatus } from "@/services/api/task-center";
import type { VoiceProfile } from "@/services/api/projects";
import type { CanvasDrawingEngineSetting } from "@/lib/canvas/canvas-drawing-engine";
import type { FeatureAvailability } from "@/stores/use-user-store";
import type { MembershipView, MembershipTier } from "@/types/membership";
import type { EntitlementBadge } from "@/services/api/entitlements";
import { apiBaseURL, apiClient, compactApiParams, request } from "@/services/api/request";

const api = apiClient;

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
    role: "admin" | "user";
    status: "active" | "disabled";
    lastLoginAt?: string;
    createdAt: string;
    updatedAt: string;
    inviteCode?: string;
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

export type AdminUser = LocalUser & {
    availableMicrocredits: number;
    reservedMicrocredits: number;
    registrationIp: string;
    lastLoginIp: string;
    registrationIpExempt: boolean;
};

export type AdminUserSummary = {
    totalUsers: number;
    membershipCounts: Record<MembershipTier, number>;
};

export type AdminContentType = "canvas" | "image" | "video";

export type AdminContentItem = {
    id: string;
    type: AdminContentType;
    user: { id: string; username: string; displayName: string };
    title: string;
    status?: "pending" | "ready" | "failed" | "deleted" | string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    previewUrl?: string;
    thumbnailUrl?: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminContentPage = {
    items: AdminContentItem[];
    total: number;
    page: number;
    limit: number;
};

export type AdminCanvasPreview = {
    id: string;
    title: string;
    nodes: Array<{
        id: string;
        type: string;
        title: string;
        position: { x: number; y: number };
        width: number;
        height: number;
    }>;
    connections: Array<{ id: string; fromNodeId: string; toNodeId: string }>;
    nodeCount: number;
    connectionCount: number;
    truncated: boolean;
    createdAt: string;
    updatedAt: string;
};

export type AdminCanvasDocument = {
    id: string;
    title: string;
    nodes: unknown[];
    connections: unknown[];
    backgroundMode?: string;
    viewport?: { x: number; y: number; k: number };
    createdAt: string;
    updatedAt: string;
};

export type AdminCanvasShare = {
    enabled: boolean;
    token?: string;
    expiresAt?: string;
    createdAt?: string;
};

export type AuthSessionPayload = {
    user: LocalUser | null;
    systemChannels?: ModelChannel[];
    runtimeLimits?: RuntimeLimits;
    drawingEngine?: CanvasDrawingEngineSetting;
    features?: FeatureAvailability;
};

export type RuntimeLimits = {
    activeTaskLimit: number;
    resourceUploadMB: number;
    sessionUploadMB: number;
};

export type AdminChannelAPIKey = {
    id: string;
    channelId: string;
    name: string;
    keyHint: string;
    priority: number;
    enabled: boolean;
    status: "active" | "exhausted" | "invalid";
    lastUsedAt?: string;
    lastFailedAt?: string;
    lastErrorCode?: string;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
};

export type ApiCallLog = {
    id: string;
    userId: string;
    userDisplayName?: string;
    userAccount?: string;
    channelId: string;
    channelName: string;
    taskId?: string;
    taskStatus?: TaskStatus;
    taskStage?: string;
    taskError?: string;
    source: string;
    capability: "text" | "image" | "video" | "audio" | "";
    operation?: string;
    requestKind: "create" | "poll" | "download" | "repair" | "";
    billable: boolean;
    apiFormat: string;
    method: string;
    path: string;
    model: string;
    status: "succeeded" | "failed";
    statusCode: number;
    durationMs: number;
    pollCount: number;
    providerStatus?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    usageAvailable: boolean;
    mediaCount: number;
    mediaPreviewUrl?: string;
    mediaPreviewKind?: "image" | "video";
    videoSeconds: number;
    providerRequestId?: string;
    estimatedCostMicros: number;
    costAvailable: boolean;
    currency?: string;
    errorCode?: string;
    error?: string;
    concurrencyLimit: number;
    upstreamUrl: string;
    requestContentType?: string;
    requestBody?: string;
    responseBody?: string;
    startedAt?: string;
    createdAt: string;
};

export type AdminProviderTaskQueryResult = {
    task: GenerationTask;
    providerStatus: string;
    recovered: boolean;
    billingSettled: boolean;
};

export type AdminAuditEvent = {
    id: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    summary: string;
    metadataJson?: string;
    createdAt: string;
};

export type AdminUserDetail = {
    user: LocalUser;
    registrationIp: string;
    lastLoginIp: string;
    registrationIpExempt: boolean;
    account: { userId: string; availableMicrocredits: number; reservedMicrocredits: number; version: number };
    counts: { ledgerEntries: number; tasks: number; apiCalls: number; auditEvents: number };
    storageUsage: {
        assetCount: number;
        assetBytes: number;
        canvasCount: number;
        canvasBytes: number;
        sessionCount: number;
        sessionBytes: number;
        taskCount: number;
        taskBytes: number;
        apiCallCount: number;
    };
    storedFileBytes: number;
    dailyUploadBytes: number;
    quota: RuntimeResourcePolicy;
};

export type AdminUserTask = {
    id: string;
    type: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    stage: string;
    progress: number;
    model?: string;
    providerRequestId?: string;
    createdAt: string;
};

export type AnalyticsFilters = {
    from?: string;
    to?: string;
    userId?: string;
    model?: string;
    channelId?: string;
    capability?: string;
};

export type AdminReferenceData = {
    users: Array<{ id: string; username: string; displayName: string }>;
    channels: Array<{ id: string; name: string; models: string[] }>;
};

export type AdminAnalytics = {
    from: string;
    to: string;
    kpi: {
        activeUsers: number;
        dau: number;
        wau: number;
        mau: number;
        generationTasks: number;
        upstreamRequests: number;
        successRate: number;
        p95DurationMs: number;
        currentQueuedTasks: number;
        estimatedCostMicros: number;
        costAvailable: boolean;
        currency?: string;
    };
    trend: Array<{ day: string; tasks: number; requests: number; activeUsers: number; requestSuccessRate: number }>;
    models: Array<{
        model: string;
        capability: string;
        tasks: number;
        requests: number;
        uniqueUsers: number;
        taskSuccessRate: number;
        requestSuccessRate: number;
        p50DurationMs: number;
        p95DurationMs: number;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        usageAvailable: boolean;
        mediaCount: number;
        videoSeconds: number;
        estimatedCostMicros: number;
        costAvailable: boolean;
        currency?: string;
    }>;
    users: Array<{ userId: string; name: string; activeDays: number; tasks: number; agentMessages: number; canvasDays: number; assets: number; resources: number; commonModel?: string }>;
    failures: Array<{ type: string; model: string; count: number; lastError?: string; lastSeenAt: string }>;
};

export type ModelPricing = {
    id: string;
    channelId?: string;
    model: string;
    capability: "text" | "image" | "video" | "audio";
    currency: string;
    inputPerMillionMicros: number;
    outputPerMillionMicros: number;
    cachedPerMillionMicros: number;
    perRequestMicros: number;
    perMediaMicros: number;
    perVideoSecondMicros: number;
    createdAt: string;
    updatedAt: string;
};

export type PromptTemplate = {
    id: string;
    operation: string;
    name: string;
    version: number;
    content: string;
    outputType: "json" | "text";
    enabled: boolean;
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
};

export type PromptTemplateVariable = {
    label: string;
    placeholder: string;
};

export type PromptOperationDefinition = {
    operation: string;
    label: string;
    category: string;
    description: string;
    outputType: "json" | "text";
    schemaKey?: string;
    variables: PromptTemplateVariable[];
    outputContract: string;
};

export type UserPromptCustomization = {
    id: string;
    operation: string;
    mode: "inherit" | "append" | "rewrite";
    content: string;
    baseTemplateId: string;
    updatedAt: string;
};

export type UserPromptPreference = {
    definition: PromptOperationDefinition;
    template: PromptTemplate | null;
    customization?: UserPromptCustomization;
    outdated: boolean;
};

export type AdminOSSSetting = {
    enabled: boolean;
    provider: "aliyun" | "s3";
    region: string;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    hasAccessKeyId: boolean;
    accessKeySecret?: string;
    hasAccessKeySecret: boolean;
    publicBaseUrl: string;
    pathPrefix: string;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
};

export type RuntimeResourcePolicy = {
    resourceUploadMB: number;
    sessionUploadMB: number;
    generatedFileMB: number;
    dailyUploadMB: number;
    storedFileGB: number;
    structuredDataMB: number;
    taskDataGB: number;
    assetCount: number;
    canvasCount: number;
    sessionCount: number;
    taskCount: number;
    apiCallLogCount: number;
};

export type RuntimeTaskPolicy = {
    workerConcurrency: number;
    channelConcurrency: number;
    activeTaskLimit: number;
    imageTimeoutMinutes: number;
    textTimeoutMinutes: number;
    audioTimeoutMinutes: number;
    videoTimeoutMinutes: number;
    storyboardTimeoutMinutes: number;
    defaultTimeoutMinutes: number;
};

export type RuntimeRequestPolicy = {
    taskCreatePerMinute: number;
    sessionCreatePerMinute: number;
    resourceUploadPerMinute: number;
    resourceImportPerMinute: number;
    sessionFilePerMinute: number;
    assetWritePerMinute: number;
    canvasWritePerMinute: number;
    registerPerHour: number;
    emailCodePerHour: number;
    loginIPPerTenMinutes: number;
    loginAccountPerTenMinutes: number;
    systemRelayPerMinute: number;
    customRelayPerMinute: number;
    customRelayConcurrency: number;
    customRelayRequestMB: number;
    customRelayResponseMB: number;
    customRelayTimeoutMinutes: number;
    systemRelayRequestMB: number;
    systemRelayResponseMB: number;
    channelCircuitFailureCount: number;
    channelCircuitOpenSeconds: number;
};

export type RuntimePolicySetting = {
    resource: RuntimeResourcePolicy;
    task: RuntimeTaskPolicy;
    request: RuntimeRequestPolicy;
    configured?: boolean;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
};

export function getAuthSettings() {
    return request<{
        firstUser: boolean;
        registrationEnabled: boolean;
        emailEnabled: boolean;
        emailCodeRequired: boolean;
        smsEnabled: boolean;
        aliyunCaptchaEnabled: boolean;
        aliyunCaptchaRegion?: string;
        aliyunCaptchaPrefix?: string;
        aliyunCaptchaSceneId?: string;
    }>(api.get("/auth/settings"));
}

export function getAuthSession() {
    return request<AuthSessionPayload>(api.get("/auth/session", { timeout: 15_000 }));
}

export function getSystemChannels(options?: { signal?: AbortSignal; timeout?: number }) {
    return request<{ channels: ModelChannel[] }>(api.get("/channels/system", options));
}

export function getFeatureAvailability() {
    return request<{ features: FeatureAvailability }>(api.get("/features"));
}

export function getAdminFeatureAvailability() {
    return request<{ features: FeatureAvailability }>(api.get("/admin/settings/features"));
}

export function updateAdminFeatureAvailability(features: Pick<FeatureAvailability, "shortDramaEnabled" | "taskCenterEnabled" | "creditsEnabled">) {
    return request<{ features: FeatureAvailability }>(api.patch("/admin/settings/features", features));
}

export function login(input: { username: string; password: string }) {
    return request<{ user: LocalUser }>(api.post("/auth/login", input));
}

export function smsLogin(input: { phone: string; smsCode: string }) {
    return request<{ user: LocalUser }>(api.post("/auth/sms-login", input));
}

export function getSMSSliderChallenge() {
    return request<EmailSliderChallenge>(api.post("/auth/sms-slider-challenge"));
}

export function getSMSNumericCaptcha() {
    return request<{ challengeId: string; imageDataUrl: string; expiresIn: number }>(api.post("/auth/numeric-captcha"));
}

export function sendSMSCode(input: { phone: string; purpose: "registration" | "login"; challengeId?: string; trackWidth?: number; samples?: EmailSliderSample[]; captchaChallengeId?: string; captchaCode?: string; captchaVerifyParam?: string }) {
    return request<{ sent: boolean }>(api.post("/auth/sms-code", input));
}

export type EmailSliderSample = { x: number; t: number; pieceX: number; pieceY: number };

export type EmailSliderChallenge = {
    challengeId: string;
    expiresIn: number;
    imageUrl: string;
    pieceImageUrl: string;
    imageWidth: number;
    imageHeight: number;
    pieceSize: number;
};

export function getEmailSliderChallenge() {
    return request<EmailSliderChallenge>(api.post("/auth/email-slider-challenge"));
}

export function sendRegistrationEmailCode(input: { email: string; challengeId?: string; trackWidth?: number; samples?: EmailSliderSample[]; captchaChallengeId?: string; captchaCode?: string; captchaVerifyParam?: string }) {
    return request<{ sent: boolean }>(api.post("/auth/email-code", input));
}

export function register(input: {
    username: string;
    email?: string;
    emailCode?: string;
    phone?: string;
    smsCode?: string;
    verificationMethod?: "email" | "sms";
    displayName?: string;
    password: string;
    inviteCode?: string;
    agreementAccepted: boolean;
    agreementVersion: string;
}) {
    return request<{ user: LocalUser }>(api.post("/auth/register", input));
}

export function updateProfile(input: { displayName: string; bio?: string; avatarResourceId?: string; resetAvatar?: boolean }) {
    return request<{ user: LocalUser }>(api.patch("/auth/profile", input));
}

export function logout() {
    return request<{ ok: boolean }>(api.post("/auth/logout"));
}

export type AdminListParams = { keyword?: string; status?: string; role?: string; page?: number; limit?: number };

export type AdminContentListParams = { keyword?: string; type: AdminContentType; page?: number; limit?: number };

export function listAdminContent(params: AdminContentListParams, options: { signal?: AbortSignal } = {}) {
    return request<AdminContentPage>(api.get("/admin/content", { params: compactApiParams(params), signal: options.signal }));
}

export function getAdminCanvasPreview(id: string, options: { signal?: AbortSignal } = {}) {
    return request<{ project: AdminCanvasPreview }>(api.get(`/admin/content/canvases/${encodeURIComponent(id)}`, { signal: options.signal }));
}

export function getAdminCanvasDocument(id: string, options: { signal?: AbortSignal } = {}) {
    return request<{ project: AdminCanvasDocument }>(api.get(`/admin/content/canvases/${encodeURIComponent(id)}/document`, { signal: options.signal }));
}

export function getAdminCanvasShare(id: string) {
    return request<{ share: AdminCanvasShare }>(api.get(`/admin/content/canvases/${encodeURIComponent(id)}/share`));
}

export function resolveAdminContentURL(value?: string) {
    const path = String(value || "").trim();
    if (!path || /^(?:https?:|blob:|data:)/i.test(path)) return path;
    const base = String(apiBaseURL).replace(/\/+$/, "");
    if (path.startsWith("/api/")) return `${base}${path.slice(4)}`;
    return `${base}/${path.replace(/^\/+/, "")}`;
}

export function listAdminUsers(params: AdminListParams = {}) {
    return request<{ users: AdminUser[]; total: number; page: number; limit: number }>(api.get("/admin/users", { params }));
}

export function listAdminUserSummary() {
    return request<AdminUserSummary>(api.get("/admin/users/summary"));
}

export function createAdminUser(input: { username: string; displayName: string; email?: string; password: string; role: LocalUser["role"]; status: LocalUser["status"] }) {
    return request<{ user: AdminUser }>(api.post("/admin/users", input));
}

export function getAdminReferences() {
    return request<AdminReferenceData>(api.get("/admin/references"));
}

export function getAdminUserDetail(id: string) {
    return request<AdminUserDetail>(api.get(`/admin/users/${encodeURIComponent(id)}/detail`));
}

export function listAdminUserLedger(id: string, params: { page?: number; limit?: number; type?: string } = {}) {
    return request<{ entries: CreditLedgerEntry[]; total: number; page: number; limit: number }>(api.get(`/admin/users/${encodeURIComponent(id)}/ledger`, { params }));
}

export function listAdminUserTasks(id: string, params: { page?: number; limit?: number } = {}) {
    return request<{ tasks: AdminUserTask[]; total: number; page: number; limit: number }>(api.get(`/admin/users/${encodeURIComponent(id)}/tasks`, { params }));
}

export function listAdminUserAuditEvents(id: string, params: { page?: number; limit?: number } = {}) {
    return request<{ events: AdminAuditEvent[]; total: number; page: number; limit: number }>(api.get(`/admin/users/${encodeURIComponent(id)}/audit-events`, { params }));
}

export type AdminAuditEventListParams = {
    actor?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    keyword?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
};

export function listAdminAuditEvents(params: AdminAuditEventListParams = {}) {
    return request<{ events: AdminAuditEvent[]; total: number; page: number; limit: number }>(api.get("/admin/audit-events", { params: compactApiParams(params) }));
}

export function updateAdminUser(id: string, input: Partial<Pick<LocalUser, "displayName" | "email" | "role" | "status">> & { password?: string }) {
    return request<{ user: LocalUser }>(api.patch(`/admin/users/${encodeURIComponent(id)}`, input));
}

export type AgencyAssignmentInput = {
    enabled: boolean;
    role?: "master" | "secondary";
    parentAgencyId?: string;
    productCommissionRateBasisPoints?: number | null;
    subscriptionCommissionRateBasisPoints?: number | null;
    resetProductCommissionRate?: boolean;
    resetSubscriptionCommissionRate?: boolean;
};

export function setAdminUserAgency(id: string, input: AgencyAssignmentInput) {
    return request<{
        agency?: AgencyAccess & { id: string; userId?: string; parentId?: string; role: "master" | "secondary"; username: string; displayName: string; phone?: string; status: "active" | "disabled"; createdAt: string };
        enabled: boolean;
        syncedInvitations: number;
    }>(api.patch(`/admin/users/${encodeURIComponent(id)}/agency`, input));
}

export function deleteAdminUser(id: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/users/${encodeURIComponent(id)}`));
}

export function bulkDisableAdminUsers(userIds: string[]) {
    return request<{ users: LocalUser[]; disabledCount: number }>(api.post("/admin/users/bulk-disable", { userIds }));
}

export function grantAdminUserMembership(id: string, input: { tier: MembershipTier; days: number; note?: string }) {
    return request<{ membership: MembershipView }>(api.post(`/admin/users/${encodeURIComponent(id)}/membership`, input));
}

export function grantAllAdminUserMembership(input: { tier: MembershipTier; days: number; note?: string }) {
    return request<{ count: number }>(api.post("/admin/users/membership/grant-all", input));
}

export function setRegistrationIPExemption(ip: string, enabled: boolean) {
    return request<{ ip: string; enabled: boolean }>(api.patch("/admin/registration-ip-exemption", { ip, enabled }));
}

export type AdminVoiceProfileInput = Omit<VoiceProfile, "id"> & { compatibleModels: string[] };

export function listAdminVoiceProfiles() {
    return request<{ profiles: VoiceProfile[] }>(api.get("/admin/voice-profiles"));
}

export function createAdminVoiceProfile(input: AdminVoiceProfileInput) {
    return request<{ profile: VoiceProfile }>(api.post("/admin/voice-profiles", input));
}

export function updateAdminVoiceProfile(id: string, input: AdminVoiceProfileInput) {
    return request<{ profile: VoiceProfile }>(api.patch(`/admin/voice-profiles/${encodeURIComponent(id)}`, input));
}

export function deleteAdminVoiceProfile(id: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/voice-profiles/${encodeURIComponent(id)}`));
}

export function listAdminChannels(params: AdminListParams = {}) {
    return request<{ channels: ModelChannel[]; total: number; page: number; limit: number }>(api.get("/admin/channels", { params }));
}

export function createAdminChannel(input: Partial<ModelChannel> & { useGlobalConcurrency?: boolean }) {
    return request<{ channel: ModelChannel }>(api.post("/admin/channels", input));
}

export function updateAdminChannel(id: string, input: Partial<ModelChannel> & { useGlobalConcurrency?: boolean }) {
    return request<{ channel: ModelChannel }>(api.patch(`/admin/channels/${encodeURIComponent(id)}`, input));
}

export function deleteAdminChannel(id: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/channels/${encodeURIComponent(id)}`));
}

export function listAdminChannelAPIKeys(channelId: string) {
    return request<{ keys: AdminChannelAPIKey[] }>(api.get(`/admin/channels/${encodeURIComponent(channelId)}/api-keys`));
}

export function createAdminChannelAPIKey(channelId: string, input: { name: string; apiKey: string; priority?: number; enabled?: boolean }) {
    return request<{ key: AdminChannelAPIKey }>(api.post(`/admin/channels/${encodeURIComponent(channelId)}/api-keys`, input));
}

export function updateAdminChannelAPIKey(channelId: string, keyId: string, input: { name?: string; priority?: number; enabled?: boolean }) {
    return request<{ key: AdminChannelAPIKey }>(api.patch(`/admin/channels/${encodeURIComponent(channelId)}/api-keys/${encodeURIComponent(keyId)}`, input));
}

export function deleteAdminChannelAPIKey(channelId: string, keyId: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/channels/${encodeURIComponent(channelId)}/api-keys/${encodeURIComponent(keyId)}`));
}

export function resetAdminChannelAPIKey(channelId: string, keyId: string) {
    return request<{ key: AdminChannelAPIKey }>(api.post(`/admin/channels/${encodeURIComponent(channelId)}/api-keys/${encodeURIComponent(keyId)}/reset`));
}

export function listAdminPromptTemplates() {
    return request<{ templates: PromptTemplate[]; definitions: PromptOperationDefinition[] }>(api.get("/admin/prompt-templates"));
}

export function createAdminPromptTemplate(input: Pick<PromptTemplate, "operation" | "name" | "content"> & { enabled?: boolean }) {
    return request<{ template: PromptTemplate }>(api.post("/admin/prompt-templates", input));
}

export function updateAdminPromptTemplate(id: string, input: Pick<PromptTemplate, "operation" | "name" | "content"> & { enabled?: boolean }) {
    return request<{ template: PromptTemplate }>(api.patch(`/admin/prompt-templates/${encodeURIComponent(id)}`, input));
}

export function deleteAdminPromptTemplate(id: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/prompt-templates/${encodeURIComponent(id)}`));
}

export function listUserPromptPreferences() {
    return request<{ preferences: UserPromptPreference[] }>(api.get("/settings/prompt-templates"));
}

export function updateUserPromptCustomization(operation: string, input: Pick<UserPromptCustomization, "mode" | "content">) {
    return request<{ customization: UserPromptCustomization }>(api.patch(`/settings/prompt-templates/${encodeURIComponent(operation)}`, input));
}

export function resetUserPromptCustomization(operation: string) {
    return request<{ ok: boolean }>(api.delete(`/settings/prompt-templates/${encodeURIComponent(operation)}`));
}

export function getAdminOSSSetting() {
    return request<{ setting: AdminOSSSetting }>(api.get("/admin/settings/oss"));
}

export function updateAdminOSSSetting(input: Partial<AdminOSSSetting>) {
    return request<{ setting: AdminOSSSetting }>(api.patch("/admin/settings/oss", input));
}

export function getAdminRuntimePolicySetting() {
    return request<{ setting: RuntimePolicySetting }>(api.get("/admin/settings/runtime-policy"));
}

export function getAdminSelfUseRuntimePolicy() {
    return request<{ setting: RuntimePolicySetting }>(api.get("/admin/settings/runtime-policy/self-use"));
}

export function updateAdminRuntimePolicySetting(input: Pick<RuntimePolicySetting, "resource" | "task" | "request">) {
    return request<{ setting: RuntimePolicySetting }>(api.put("/admin/settings/runtime-policy", input));
}

export function resetAdminRuntimePolicySetting() {
    return request<{ setting: RuntimePolicySetting }>(api.delete("/admin/settings/runtime-policy"));
}

export function getAdminDrawingEngineSetting() {
    return request<{ setting: CanvasDrawingEngineSetting }>(api.get("/admin/settings/drawing-engine"));
}

export function updateAdminDrawingEngineSetting(input: Pick<CanvasDrawingEngineSetting, "defaultEngine" | "tldrawLicenseKey">) {
    return request<{ setting: CanvasDrawingEngineSetting }>(api.patch("/admin/settings/drawing-engine", input));
}

export function listAdminApiLogs(params: AdminListParams = {}) {
    return request<{ logs: ApiCallLog[]; total: number; page: number; limit: number }>(api.get("/admin/api-logs", { params }));
}

export function getAdminApiLog(id: string, options: { signal?: AbortSignal; timeout?: number } = {}) {
    return request<{ log: ApiCallLog }>(
        api.get(`/admin/api-logs/${encodeURIComponent(id)}`, {
            signal: options.signal,
            timeout: options.timeout,
        }),
    );
}

export function queryAdminApiLogTask(id: string) {
    return request<AdminProviderTaskQueryResult>(api.post(`/admin/api-logs/${encodeURIComponent(id)}/query-task`));
}

export async function exportAdminApiLogs(params: AdminListParams & { ids?: string[] } = {}) {
    const response = await api.get<Blob>("/admin/api-logs-export.csv", { params: { ...params, ids: params.ids?.join(",") }, responseType: "blob" });
    return response.data;
}

export function getAdminAnalytics(params: AnalyticsFilters) {
    return request<AdminAnalytics>(api.get("/admin/analytics/overview", { params }));
}

export async function exportAdminAnalytics(params: AnalyticsFilters) {
    const response = await api.get<Blob>("/admin/analytics/export.csv", { params, responseType: "blob" });
    return response.data;
}

export function listAdminModelPricings() {
    return request<{ pricings: ModelPricing[] }>(api.get("/admin/model-pricings"));
}

export function createAdminModelPricing(input: Omit<ModelPricing, "id" | "createdAt" | "updatedAt">) {
    return request<{ pricing: ModelPricing }>(api.post("/admin/model-pricings", input));
}

export function updateAdminModelPricing(id: string, input: Omit<ModelPricing, "id" | "createdAt" | "updatedAt">) {
    return request<{ pricing: ModelPricing }>(api.patch(`/admin/model-pricings/${encodeURIComponent(id)}`, input));
}

export function deleteAdminModelPricing(id: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/model-pricings/${encodeURIComponent(id)}`));
}
