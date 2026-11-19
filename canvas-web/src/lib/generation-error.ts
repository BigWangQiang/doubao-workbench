export const CONTENT_MODERATION_ERROR_CODE = "sensitive_words_detected";

export const CONTENT_MODERATION_MESSAGE = "内容审核未通过，本次平台积分未扣除或已退还。请修改提示词后重新生成。";

const DEFAULT_GENERATION_ERROR_MESSAGE = "生成失败，请稍后重试。";
const NETWORK_ERROR_MESSAGE = "网络异常。";
const SERVER_BUSY_MESSAGE = "服务器繁忙，请稍后重试。";
const CONNECTION_INTERRUPTED_MESSAGE = "生成服务连接中断，未收到完整响应，请稍后重试。";
const WAN3_PROMPT_LIMIT_MESSAGE = "WAN3 最多 5000字提示词";
const WAN3_PROMPT_LIMIT_REFUNDED_MESSAGE = `${WAN3_PROMPT_LIMIT_MESSAGE}，积分已退回`;
const WAN3_PROMPT_LIMIT_PATTERN = /\bWAN3\s+(?:prompt\s+最多\s*5000\s*字符|最多\s*5000\s*字提示词)/i;
const CONNECTION_INTERRUPTED_PATTERN = /\b(?:unexpected\s+EOF|EOF|connection\s+(?:reset|closed)|socket\s+hang\s+up|broken\s+pipe|http2:\s+client\s+connection\s+lost)\b/i;
const SENSITIVE_ERROR_DETAIL_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|https?:|wss?:|https?%3a|(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]*:[0-9a-f:]*\]|\blocalhost\b|(?:api[_ -]?key|token|cookie|authorization|密钥|密码)\s*[:=：])/i;
const PROVIDER_BUSINESS_ERROR_PATTERN =
    /(?:版权|著作权|肖像权|肖像保护|肖像権|著作権|知的財産|知识产权|侵权|内容审核|安全策略|未认证人脸|未验证人脸|copyright|portrait\s+rights?|portrait\s+protection|right\s+of\s+publicity|intellectual\s+property|safety\s+policy|content\s+policy|face\s+(?:verification|authentication))/i;
const DOLA_TERMINAL_REPLY_PATTERN = /^Dola\s+未进入视频生成，任务已终止。上游回复[:：]\s*/i;
const LOCAL_MANAGER_ACCOUNT_UNAVAILABLE_PATTERN = /本机没有可用于该任务的\s*[^:：\r\n]{1,32}\s*账号(?:[:：][^\r\n]*)?/;
const PROVIDER_BUSINESS_REASON_PATTERN = /(?:生成失败|任务失败|请求失败|上传失败|下载失败|处理失败|没有返回|风控|封禁|账号受限|访问频繁|服务繁忙|超时|拒绝|不支持|不可用|已终止|失败|错误|异常|无法|未能)/;
const PROVIDER_TECHNICAL_DETAIL_PATTERN = /\b(?:timeout|timed\s+out|connection\s+(?:refused|reset)|failed\s+to\s+fetch|fetch\s+failed|socket\s+hang\s+up|signer|stack\s+trace|traceback|exception|status\s+code|upstream|gateway|dns|domain|resolution|disabled|not\s+found|unavailable|capability|protocol|authentication|unauthorized|forbidden|invalid|parameter|rate\s+limit|balance|quota|credits?)\b/i;

/**
 * 将上游、浏览器和后端返回的错误统一转换为用户可读的中文消息。
 * 不把渠道账号、余额、URL 或英文协议错误直接暴露给用户。
 */
export function localizeErrorMessage(error: unknown, fallback = "请求失败，请稍后重试。") {
    let raw = rawGenerationError(error);
    if (!raw) return fallback;
    if (isContentModerationError(raw)) return CONTENT_MODERATION_MESSAGE;
    if (WAN3_PROMPT_LIMIT_PATTERN.test(raw)) {
        // 只保留后端按本平台账单确认后的退款文案，不采信原始渠道 JSON 的退款声明。
        return raw === WAN3_PROMPT_LIMIT_REFUNDED_MESSAGE ? raw : WAN3_PROMPT_LIMIT_MESSAGE;
    }
    if (CONNECTION_INTERRUPTED_PATTERN.test(raw)) return CONNECTION_INTERRUPTED_MESSAGE;
    // 在任何保留业务文案的提前返回前拦截地址和凭据，也覆盖旧任务缓存。
    if (SENSITIVE_ERROR_DETAIL_PATTERN.test(raw)) {
        if (isNetworkFailure(raw) || /timeout|timed out|超时/i.test(raw)) return "网络连接或请求超时，请稍后重试。";
        return fallback;
    }
    if (/创\s*AI/i.test(raw)) {
        // 覆盖旧任务缓存；仅去掉供应商名称，保留其余错误内容。
        raw = raw.replace(/创\s*AI\s*/gi, "").trim();
        if (!raw) return fallback;
    }
    // 无可用账号提示可能同时包含“额度不足”，需先于通用余额规则保留完整原因。
    const localManagerAccountMessage = raw.match(LOCAL_MANAGER_ACCOUNT_UNAVAILABLE_PATTERN)?.[0]?.trim();
    if (localManagerAccountMessage) return localManagerAccountMessage;
    if (/存储空间不足/.test(raw)) {
        // 容量单位含英文，需在通用安全兜底前保留可操作的个人存储提示。
        const limit = raw.match(/当前上限\s*(\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB))\b/i)?.[1];
        return `个人存储空间不足${limit ? `（当前上限 ${limit}）` : ""}，请清理不需要的素材或扩容存储空间后重试。`;
    }

    const normalized = raw.toLowerCase();
    if (/activityerror|no available web account|no available account/.test(normalized)) {
        return "当前图片渠道暂无可用上游账号，请管理员检查账号池或稍后重试。";
    }
    if (/insufficient[_\s]+(?:user[_\s]+)?(?:balance|funds|credits?|quota)|user[_\s]+quota|(?:balance|quota|credits?|funds?).*(?:insufficient|exceeded|exhausted|depleted|not\s+enough|too\s+low)|余额不足|额度不足|账户余额|账户额度|上游余额|预扣费额度失败|剩余额度/.test(normalized) || /余额不足|额度不足|上游余额|预扣费额度失败|剩余额度/.test(raw)) {
        return SERVER_BUSY_MESSAGE;
    }
    if (/no available channels?|no available channel/.test(normalized)) {
        return "当前模型暂无可用渠道，请检查模型和渠道配置后重试。";
    }
    if (/系统渠道不存在或已停用|当前系统渠道模型未配置或已停用/.test(raw)) {
        return "当前图片渠道或模型已停用，请管理员在后台启用对应渠道和模型后重试。";
    }
    if (/external service domain resolution failed|no such host|dns|名前解決|getaddrinfo|域名解析失败/.test(normalized) || /域名解析失败/.test(raw)) {
        return "外部服务域名解析失败，请检查上游地址和 DNS 配置。";
    }
    if (/tool[_ -]?choice/.test(normalized) && /thinking|reasoning/.test(normalized)) {
        return "当前模型不兼容工具调用模式，请切换模型或关闭推理模式后重试。";
    }
    if (/request\s+parameters?\s+(?:are\s+)?invalid|parameters?\s+(?:are\s+)?invalid/.test(normalized)) {
        return "上游判定请求参数无效，请检查模型的请求参数配置后重试。";
    }
    if (/invalid\s+(?:parameter|request|argument)|parameter\s+error|参数有误|参数错误/.test(normalized) || /参数有误|参数错误/.test(raw)) {
        return "请求参数有误，请检查模型、比例和输入素材。";
    }
    if (/bad gateway|gateway timeout|service unavailable|upstream(?:_|\s+)error|\b(?:502|503|504)\b/.test(normalized)) {
        return SERVER_BUSY_MESSAGE;
    }
    if (/unauthori[sz]ed|invalid\s+(?:api\s*)?key|authentication|鉴权失败|认证失败/.test(normalized) || /鉴权失败|认证失败/.test(raw)) {
        return "鉴权失败，请检查 API Key、套餐权限或模型权限。";
    }
    if (/rate limit|too many requests|限流|请求过于频繁/.test(normalized) || /限流|请求过于频繁/.test(raw)) {
        return "请求过于频繁，请稍后重试。";
    }
    if (/本地管理器未在线/.test(raw) || /(?:local[-\s]?manager|desktop (?:manager|client|device)).*(?:offline|not online|not connected|unavailable)/.test(normalized)) {
        return "本地管理器未在线，请先打开并完成 Lalor 配对。";
    }
    if (/local[-\s]?manager.*(?:channel|model).*(?:disabled|not found|unavailable)/.test(normalized)) {
        return "本地管理器渠道或模型未启用，请联系管理员检查配置。";
    }
    if (/(?:model\s+capability|capability).*(?:mismatch|not supported)|does not support (?:the )?(?:requested )?capability/.test(normalized)) {
        return "所选模型不支持当前生成类型，请更换模型或联系管理员检查能力配置。";
    }
    if (/本地管理器.*local-manager.*协议|local-manager.*内部协议/.test(normalized) || /(?:protocol).*(?:mismatch|unsupported|invalid)/.test(normalized)) {
        return "生成渠道协议配置不匹配，请联系管理员检查模型协议。";
    }
    if (isNetworkFailure(raw) || /timeout|timed out|超时/.test(normalized)) {
        return "网络连接或请求超时，请稍后重试。";
    }
    if (/not found|无法访问|地址不可用/.test(normalized) || /\b404\b/.test(raw)) {
        return "生成服务地址不可用，请检查渠道配置。";
    }

    const providerBusinessMessage = preservedProviderBusinessMessage(raw);
    if (providerBusinessMessage) return providerBusinessMessage;

    // 已经是纯中文的业务提示可以保留；含有未识别英文或协议堆栈则统一降级。
    if (/^[^A-Za-z]*[\u4e00-\u9fff][^A-Za-z]*$/.test(raw)) return raw;
    return fallback;
}

export type GenerationFailureMetadata = {
    errorDetails: string;
    generationErrorCode?: string;
    failedPromptFingerprint?: string;
};

export function generationFailureMetadata(error: unknown, prompt: string): GenerationFailureMetadata {
    const raw = rawGenerationError(error);
    if (!isContentModerationError(raw)) return { errorDetails: generationErrorMessage(error) };
    return {
        errorDetails: CONTENT_MODERATION_MESSAGE,
        generationErrorCode: CONTENT_MODERATION_ERROR_CODE,
        failedPromptFingerprint: generationPromptFingerprint(prompt),
    };
}

export function generationErrorMessage(error: unknown) {
    const raw = rawGenerationError(error);
    if (isContentModerationError(raw)) return CONTENT_MODERATION_MESSAGE;
    if (WAN3_PROMPT_LIMIT_PATTERN.test(raw)) return localizeErrorMessage(raw, DEFAULT_GENERATION_ERROR_MESSAGE);
    if (CONNECTION_INTERRUPTED_PATTERN.test(raw)) return CONNECTION_INTERRUPTED_MESSAGE;

    const providerMessage = extractStructuredProviderMessage(raw) || extractWrappedProviderMessage(raw);
    const displayMessage = providerMessage || raw;
    if (isContentModerationError(displayMessage)) return CONTENT_MODERATION_MESSAGE;
    if (isNetworkFailure(displayMessage)) return NETWORK_ERROR_MESSAGE;
    if (!providerMessage) {
        if (hasHttpStatus(raw, 429)) return "服务当前繁忙，请稍后重试。";
        if (hasHttpStatus(raw, 401, 403)) return "生成服务鉴权失败，请检查渠道配置。";
        if (hasHttpStatus(raw, 404)) return "生成服务地址不可用，请检查渠道配置。";
        if (hasHttpStatus(raw, 500, 502, 503, 504) || containsInfrastructureDetails(raw)) return NETWORK_ERROR_MESSAGE;
    }
    return localizeErrorMessage(displayMessage || raw, DEFAULT_GENERATION_ERROR_MESSAGE);
}

export function isContentModerationError(value: unknown) {
    const text = value instanceof Error ? value.message : String(value || "");
    return text.toLowerCase().includes(CONTENT_MODERATION_ERROR_CODE) || text.includes("内容审核未通过");
}

export function unchangedModeratedPrompt(metadata: { errorDetails?: string; generationErrorCode?: string; failedPromptFingerprint?: string } | undefined, prompt: string) {
    const moderationFailure = metadata?.generationErrorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(metadata?.errorDetails);
    if (!moderationFailure) return false;
    if (!metadata?.failedPromptFingerprint) return true;
    return metadata.failedPromptFingerprint === generationPromptFingerprint(prompt);
}

// 指纹只用于识别“原样重试”，不是安全或鉴权用途。
export function generationPromptFingerprint(value: string) {
    const normalized = value.trim().replace(/\s+/g, " ");
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

function rawGenerationError(error: unknown) {
    if (error instanceof Error) return error.message.trim();
    if (typeof error === "string") return error.trim();
    return providerPayloadMessage(error);
}

function extractStructuredProviderMessage(raw: string) {
    for (let index = raw.indexOf("{"); index >= 0; index = raw.indexOf("{", index + 1)) {
        try {
            const message = providerPayloadMessage(JSON.parse(raw.slice(index).trim()));
            if (message) return message;
        } catch {
            // 上游常把 JSON 拼在 HTTP 状态后；不是完整 JSON 时继续尝试下一个对象起点。
        }
    }
    return "";
}

function extractWrappedProviderMessage(raw: string) {
    const interfaceFailure = raw.match(/^接口请求失败[:：]\s*(.*)$/s);
    const requestFailure = raw.match(/^Request failed with status code \d{3}\s*[:：-]?\s*(.+)$/is);
    const wrapped = interfaceFailure?.[1] ?? requestFailure?.[1];
    if (!wrapped) return "";
    const message = wrapped
        .replace(/^\d{3}(?:\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error|Not Found|Unauthorized|Forbidden|Too Many Requests))?\s*[:：-]?\s*/i, "")
        .trim();
    return message && !containsInfrastructureDetails(message) ? message : "";
}

function providerPayloadMessage(payload: unknown): string {
    if (typeof payload === "string") return payload.trim();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
        const nested = providerPayloadMessage(record.error);
        if (nested) return nested;
    }
    for (const key of ["message", "msg", "detail"] as const) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return typeof record.error === "string" ? record.error.trim() : "";
}

function isNetworkFailure(value: string) {
    return /\b(?:dial tcp|connection refused|connection reset|no such host|i\/o timeout|context deadline exceeded|network error|failed to fetch|fetch failed|socket hang up|econnrefused|econnreset|etimedout)\b/i.test(value);
}

function hasHttpStatus(value: string, ...statuses: number[]) {
    return statuses.some((status) => new RegExp(`\\b${status}\\b`).test(value));
}

function containsInfrastructureDetails(value: string) {
    return /(?:接口请求失败|Request failed with status code|https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+["']?|Bad Gateway|Service Unavailable|Gateway Timeout|upstream_error)/i.test(value);
}

function preservedProviderBusinessMessage(value: string) {
    const message = value.trim();
    if (!message || containsInfrastructureDetails(message)) return "";
    if (/\b(?:[a-z\d-]+\.)+[a-z]{2,}\b/i.test(message)) return "";
    if (/(?:域名解析|网络连接|连接超时|请求超时|dns|no such host|getaddrinfo)/i.test(message)) return "";
    if (PROVIDER_TECHNICAL_DETAIL_PATTERN.test(message)) return "";
    if (!/[\u4e00-\u9fff]/.test(message)) return "";
    if (!DOLA_TERMINAL_REPLY_PATTERN.test(message) && !PROVIDER_BUSINESS_ERROR_PATTERN.test(message) && !PROVIDER_BUSINESS_REASON_PATTERN.test(message)) return "";
    return message
        .replace(/\b\d{6,}\b/g, "已隐藏账号编号")
        .replace(/((?:api[_ -]?key|token|cookie|authorization|密钥|密码)\s*[:=：]\s*)[^\s,;，；]+/gi, "$1已隐藏")
        .trim();
}
