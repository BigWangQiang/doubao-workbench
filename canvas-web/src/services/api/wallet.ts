import { apiClient, request } from "@/services/api/request";

const api = apiClient;

export type CreditAccount = {
    userId: string;
    availableMicrocredits: number;
    reservedMicrocredits: number;
    version: number;
    createdAt: string;
    updatedAt: string;
};

export type CreditLedgerEntry = {
    id: string;
    userId: string;
    type: "redeem" | "admin_grant" | "reserve" | "consume" | "refund" | "admin_adjustment" | "signup_bonus" | "checkin_bonus" | "campaign_reward" | "payment_recharge" | "subscription_bonus" | "storage_purchase" | "card_purchase" | "invitation_reward" | "invitation_commission" | "agency_commission";
    amountMicrocredits: number;
    availableAfterMicrocredits: number;
    reservedAfterMicrocredits: number;
    billingOrderId?: string;
    model?: string;
    channelId?: string;
    scene?: string;
    note?: string;
    createdAt: string;
};

export type WalletSummary = {
    account: CreditAccount;
    entries: CreditLedgerEntry[];
    total: number;
    page: number;
    limit: number;
    policy: {
        signupBonusMicrocredits: number;
        checkinBonusMicrocredits: number;
        checkedInToday: boolean;
    };
};

export type PaymentOptions = {
    enabled: boolean;
    creditsPerYuan: number;
    minimumAmountFen: number;
    maximumAmountFen: number;
    orderExpireMinutes: number;
    allowCustomAmount: boolean;
    packages: PaymentPackage[];
    wechatEnabled: boolean;
    alipayEnabled: boolean;
};

export type PaymentPackage = {
    id: string;
    name: string;
    amountFen: number;
    baseCredits: number;
    bonusCredits: number;
    badge: string;
    enabled: boolean;
    sortWeight: number;
};

export type PaymentOrder = {
    id: string;
    provider: "wechat" | "alipay";
    status: "pending" | "paid" | "closed" | "failed";
    amountFen: number;
    originalAmountFen?: number;
    discountFen?: number;
    couponId?: string;
    creditsMicrocredits: number;
    qrCodeUrl?: string;
    paymentUrl?: string;
    expiresAt?: string;
    paidAt?: string;
    createdAt: string;
};

export type PaymentProviderSetting = {
    enabled: boolean;
    appId: string;
    mchId?: string;
    merchantCertificateSerial?: string;
    wechatPayPublicKeyId?: string;
    platformCertificateSerial?: string;
    gateway?: string;
    notifyUrl: string;
    returnUrl: string;
    hasMerchantPrivateKey: boolean;
    hasApiV3Key: boolean;
    hasWechatPayPublicKey: boolean;
    hasPlatformCertificate: boolean;
    hasAppPrivateKey: boolean;
    hasAlipayPublicKey: boolean;
};

export type PaymentSetting = {
    enabled: boolean;
    creditsPerYuan: number;
    minimumAmountFen: number;
    maximumAmountFen: number;
    orderExpireMinutes: number;
    allowCustomAmount: boolean;
    packages: PaymentPackage[];
    wechat: PaymentProviderSetting;
    alipay: PaymentProviderSetting;
    updatedBy?: string;
    updatedAt?: string;
};

export type CreditPolicy = {
    signupBonusMicrocredits: number;
    checkinBonusMicrocredits: number;
    defaultMultiplierBasisPoints: number;
    modelMultiplierBasisPoints: Record<string, number>;
};

export type ChannelModel = {
    id: string;
    channelId: string;
    modelKey: string;
    displayName: string;
    description?: string;
    categoryId?: string;
    familyName?: string;
    variantName?: string;
    sortOrder?: number;
    iconResourceId?: string;
    capability: "text" | "image" | "video" | "audio" | "";
    protocol?: import("@/lib/model-protocols").ModelProtocol;
    billingMode: "fixed_request" | "per_second" | "per_minute" | "token";
    unitPriceMicrocredits: number;
    inputTokenPriceMicrocredits: number;
    outputTokenPriceMicrocredits: number;
    cachedTokenPriceMicrocredits: number;
    referenceVideoMultiplierBasisPoints?: number;
    requiresMembership: boolean;
    priceConfigured: boolean;
    enabled: boolean;
    priceVersion: number;
    capabilityVersion?: number;
    capabilityConfig?: import("@/lib/model-capabilities").ModelCapabilityConfig;
    createdAt: string;
    updatedAt: string;
};

export type ModelCategory = {
    id: string;
    name: string;
    capability: "text" | "image" | "video" | "audio";
    description?: string;
    badgeText?: string;
    badgeTone?: "neutral" | "warning" | "success" | "info";
    iconResourceId?: string;
    sortOrder: number;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type RegistrationSetting = {
    enabled: boolean;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
};

export type EmailSetting = {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    password?: string;
    encryption: "starttls" | "tls" | "none";
    fromEmail: string;
    fromName: string;
    hasPassword: boolean;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
};

export type SMSSetting = {
    enabled: boolean;
    accessKeyId: string;
    accessKeySecret?: string;
    hasAccessKeySecret: boolean;
    regionId: string;
    signature: string;
    registrationTemplateCode: string;
    loginTemplateCode: string;
    codeTTLMinutes: number;
    sendCooldownSeconds: number;
    perPhoneDailyLimit: number;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
};

export type RedeemBatch = {
    id: string;
    amountMicrocredits: number;
    count: number;
    membershipOnly: boolean;
    note?: string;
    createdBy: string;
    expiresAt?: string;
    createdAt: string;
    availableCount: number;
    redeemedCount: number;
    disabledCount: number;
    expiredCount: number;
};

export type AdminRedeemCode = {
    id: string;
    code?: string;
    codeSuffix: string;
    status: "unused" | "redeemed" | "disabled" | "expired";
    redeemedBy?: string;
    redeemedUsername?: string;
    redeemedDisplayName?: string;
    redeemedAt?: string;
    redeemedIp?: string;
    expiresAt?: string;
    amountMicrocredits: number;
};

export type AdminRedeemCodePage = {
    batch: RedeemBatch;
    codes: AdminRedeemCode[];
    plaintextAvailable: boolean;
    total: number;
    page: number;
    limit: number;
};

export type BillingOrder = {
    id: string;
    userId: string;
    taskId?: string;
    channelId: string;
    model: string;
    capability: string;
    scene: string;
    billingMode: "fixed_request" | "per_second" | "per_minute" | "token";
    unitPriceMicrocredits: number;
    multiplierBasisPoints: number;
    quantity: number;
    amountMicrocredits: number;
    reservedAmountMicrocredits: number;
    actualAmountMicrocredits: number;
    refundedAmountMicrocredits: number;
    inputTokenPriceMicrocredits: number;
    outputTokenPriceMicrocredits: number;
    cachedTokenPriceMicrocredits: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    usageAvailable: boolean;
    status: "reserved" | "running" | "settled" | "refunded" | "uncertain";
    refundPolicy?: string;
    refundPending?: boolean;
    providerRequestId?: string;
    error?: string;
    resolvedBy?: string;
    resolutionNote?: string;
    createdAt: string;
    updatedAt: string;
};

export function getWallet(page = 1, limit = 30, type = "all") {
    return request<WalletSummary>(api.get("/wallet", { params: { type, page, limit } }));
}

export function redeemCredits(code: string) {
    return request<{ account: CreditAccount }>(api.post("/wallet/redeem", { code }));
}

export function checkinCredits() {
    return request<{ account: CreditAccount; granted: boolean }>(api.post("/wallet/checkin"));
}

export function getPaymentOptions() {
    return request<PaymentOptions>(api.get("/wallet/payment-options"));
}

export function createPaymentOrder(input: { provider: "wechat" | "alipay"; amountFen: number; packageId?: string; couponId?: string; idempotencyKey: string; agreementAccepted: boolean; agreementVersion: string }) {
    return request<{ order: PaymentOrder }>(api.post("/wallet/payment-orders", input));
}

export function getPaymentOrder(id: string) {
    return request<{ order: PaymentOrder }>(api.get(`/wallet/payment-orders/${encodeURIComponent(id)}`));
}

export function getAdminPaymentSetting() {
    return request<{ setting: PaymentSetting }>(api.get("/admin/settings/payment"));
}

export function updateAdminPaymentSetting(input: unknown) {
    return request<{ setting: PaymentSetting }>(api.patch("/admin/settings/payment", input));
}

export function getAdminCreditPolicy() {
    return request<{ policy: CreditPolicy }>(api.get("/admin/settings/credits"));
}

export function updateAdminCreditPolicy(policy: CreditPolicy) {
    return request<{ policy: CreditPolicy }>(api.patch("/admin/settings/credits", policy));
}

export function getAdminRegistrationSetting() {
    return request<{ setting: RegistrationSetting }>(api.get("/admin/settings/registration"));
}

export function updateAdminRegistrationSetting(enabled: boolean) {
    return request<{ setting: RegistrationSetting }>(api.patch("/admin/settings/registration", { enabled }));
}

export function getAdminEmailSetting() {
    return request<{ setting: EmailSetting }>(api.get("/admin/settings/email"));
}

export function updateAdminEmailSetting(input: Partial<EmailSetting>) {
    return request<{ setting: EmailSetting }>(api.patch("/admin/settings/email", input));
}

export function testAdminEmailSetting(recipient: string) {
    return request<{ sent: boolean }>(api.post("/admin/settings/email/test", { recipient }));
}

export function getAdminSMSSetting() {
    return request<{ setting: SMSSetting }>(api.get("/admin/settings/sms"));
}

export function updateAdminSMSSetting(input: Partial<SMSSetting>) {
    return request<{ setting: SMSSetting }>(api.patch("/admin/settings/sms", input));
}

export function listAdminChannelModels(channelId: string) {
    return request<{ models: ChannelModel[] }>(api.get(`/admin/channels/${encodeURIComponent(channelId)}/models`));
}

// 管理员从上游拉取模型目录；服务端只导入缺失项，价格和启用仍需人工确认。
export function fetchAdminChannelModels(channelId: string) {
    return request<{ models: string[]; added: number }>(api.post(`/admin/channels/${encodeURIComponent(channelId)}/models/fetch`));
}

export function testAdminChannelModel(channelId: string, input: Pick<ChannelModel, "modelKey" | "capability" | "protocol"> & { capabilityConfig?: ChannelModel["capabilityConfig"] }) {
    return request<{ durationMs: number }>(api.post(`/admin/channels/${encodeURIComponent(channelId)}/models/test`, input, { timeout: 10 * 60 * 1000 }));
}

export function createAdminChannelModel(channelId: string, input: Omit<ChannelModel, "id" | "channelId" | "priceVersion" | "createdAt" | "updatedAt">) {
    return request<{ model: ChannelModel }>(api.post(`/admin/channels/${encodeURIComponent(channelId)}/models`, input));
}

export function updateAdminChannelModel(channelId: string, id: string, input: Omit<ChannelModel, "id" | "channelId" | "priceVersion" | "createdAt" | "updatedAt">) {
    return request<{ model: ChannelModel }>(api.patch(`/admin/channels/${encodeURIComponent(channelId)}/models/${encodeURIComponent(id)}`, input));
}

export function deleteAdminChannelModel(channelId: string, id: string) {
	return request<{ ok: boolean }>(api.delete(`/admin/channels/${encodeURIComponent(channelId)}/models/${encodeURIComponent(id)}`));
}

export function listAdminModelCategories() {
    return request<{ categories: ModelCategory[] }>(api.get("/admin/model-categories"));
}

export function createAdminModelCategory(input: Omit<ModelCategory, "id" | "createdAt" | "updatedAt">) {
    return request<{ category: ModelCategory }>(api.post("/admin/model-categories", input));
}

export function updateAdminModelCategory(id: string, input: Omit<ModelCategory, "id" | "createdAt" | "updatedAt">) {
    return request<{ category: ModelCategory }>(api.patch(`/admin/model-categories/${encodeURIComponent(id)}`, input));
}

export function deleteAdminModelCategory(id: string) {
    return request<{ ok: boolean }>(api.delete(`/admin/model-categories/${encodeURIComponent(id)}`));
}

export type AdminFinanceListParams = { keyword?: string; status?: string; validity?: string; page?: number; limit?: number };

export function listAdminRedeemBatches(params: AdminFinanceListParams = {}) {
    return request<{ batches: RedeemBatch[]; total: number; page: number; limit: number }>(api.get("/admin/redeem-batches", { params }));
}

export function createAdminRedeemBatch(input: { amountMicrocredits: number; count: number; membershipOnly: boolean; note?: string; expiresAt?: string }) {
    return request<{ batch: RedeemBatch; codes: string[] }>(api.post("/admin/redeem-batches", input, { timeout: 30_000 }));
}

export function listAdminRedeemBatchCodes(batchId: string, params: { status?: string; page?: number; limit?: number } = {}) {
    return request<AdminRedeemCodePage>(api.get(`/admin/redeem-batches/${encodeURIComponent(batchId)}/codes`, { params }));
}

export function disableAdminRedeemBatch(batchId: string) {
    return request<{ disabledCount: number }>(api.post(`/admin/redeem-batches/${encodeURIComponent(batchId)}/disable`));
}

export function disableAdminRedeemCode(batchId: string, codeId: string) {
    return request<{ ok: boolean }>(api.post(`/admin/redeem-batches/${encodeURIComponent(batchId)}/codes/${encodeURIComponent(codeId)}/disable`));
}

export function adjustAdminUserCredits(userId: string, input: { amountMicrocredits: number; note: string }) {
    return request<{ account: CreditAccount }>(api.post(`/admin/users/${encodeURIComponent(userId)}/credits/adjust`, input));
}

export function listAdminBillingOrders(params: AdminFinanceListParams = {}) {
    return request<{ orders: BillingOrder[]; total: number; page: number; limit: number }>(api.get("/admin/billing-orders", { params }));
}

export function resolveAdminBillingOrder(id: string, input: { action: "settle" | "refund"; note: string }) {
    return request<{ order: BillingOrder }>(api.post(`/admin/billing-orders/${encodeURIComponent(id)}/resolve`, input));
}

export function resolveAdminBillingOrders(input: { ids: string[]; action: "settle" | "refund"; note: string }) {
    return request<{ resolvedCount: number; failed: Array<{ id: string; message: string }> }>(api.post("/admin/billing-orders/batch-resolve", input));
}
