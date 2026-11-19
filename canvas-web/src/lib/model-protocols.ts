export type ModelProtocol =
    | "chat-completion"
    | "openai-response"
    | "openai-image"
    | "gemini-image"
    | "grok-image"
    | "volcengine-ark-image"
    | "volcengine-jimeng-image"
    | "openai-audio"
    | "async-audio"
    | "index-tts-v2"
    | "suno-music"
    | "newapi"
    | "aione-video"
    | "newapi-channel-1"
    | "newapi-channel-2"
    | "yuxibox-video"
    | "ljvideo-video"
    | "mddkeji-video"
    | "moziaverse-hailuo-video"
    | "minimax-v2-video"
    | "kling-cli-video"
    | "tencent-mps-video"
    | "xai-video"
    | "volcengine-ark-video"
    | "volcengine-jimeng-video"
    | "gemini-veo"
    | "local-manager";

export type ProtocolCapability = "text" | "image" | "video" | "audio";

export type ModelProtocolDefinition = {
    value: ModelProtocol;
    label: string;
    capability: ProtocolCapability;
    create: string;
    contentType: string;
    poll?: string;
    media: string;
};

export const MODEL_PROTOCOLS: ModelProtocolDefinition[] = [
    { value: "chat-completion", label: "OpenAI Chat Completions", capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "文本与多模态消息" },
    { value: "openai-response", label: "OpenAI Responses", capability: "text", create: "POST /v1/responses", contentType: "application/json", media: "文本与多模态输入" },
    { value: "openai-image", label: "OpenAI Images", capability: "image", create: "POST /v1/images/generations", contentType: "application/json / multipart", media: "生成、编辑与参考图" },
    { value: "gemini-image", label: "Gemini 图片 / Nano Banana", capability: "image", create: "POST /v1beta/models/{model}:generateContent", contentType: "application/json", media: "文生图与多张 inlineData 参考图" },
    { value: "grok-image", label: "Grok Images", capability: "image", create: "POST /v1/images/generations / edits", contentType: "application/json", media: "文生图与单张 URL 参考图，不支持蒙版" },
    { value: "volcengine-ark-image", label: "火山方舟图片", capability: "image", create: "POST /api/v3/images/generations", contentType: "application/json", media: "文生图与 image 参考图，不支持蒙版" },
    { value: "volcengine-jimeng-image", label: "即梦官方图片", capability: "image", create: "POST CVSync2AsyncSubmitTask", poll: "POST CVSync2AsyncGetResult", contentType: "application/json + AK/SK 签名", media: "0-14 张参考图，模型标识填写 req_key" },
    { value: "openai-audio", label: "OpenAI Audio", capability: "audio", create: "POST /v1/audio/speech", contentType: "application/json", media: "文本转语音" },
    { value: "async-audio", label: "异步音频任务", capability: "audio", create: "POST /v1/audio/tasks", poll: "GET /v1/audio/tasks/{task_id}", contentType: "application/json", media: "语音、音效与音乐生成" },
    { value: "index-tts-v2", label: "IndexTTS2 专用音频", capability: "audio", create: "POST /v1/audio/speech", contentType: "application/json", media: "voice_01-voice_10，WAV / FLAC / OGG / Opus，支持情感 instructions" },
    { value: "suno-music", label: "Suno 音乐", capability: "audio", create: "POST /v1/music", contentType: "application/json", media: "messages 文本提示词，返回音频地址或音频文件" },
    { value: "newapi", label: "OpenAI / NewAPI Videos", capability: "video", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "application/json", media: "input_reference 单首帧；extra.reference_images 多参考图" },
    {
        value: "aione-video",
        label: "Aione 统一视频",
        capability: "video",
        create: "POST /v1/videos",
        poll: "GET /v1/videos/{task_id} · GET /v1/videos/{task_id}/content",
        contentType: "application/json",
        media: "文生、首帧、首尾帧、多参考图、参考视频与音频",
    },
    { value: "newapi-channel-1", label: "NewAPI 媒体任务", capability: "video", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "application/json", media: "图片、视频、音频公网 URL" },
    {
        value: "newapi-channel-2",
        label: "NewAPI Video Generations",
        capability: "video",
        create: "POST /v1/video/generations",
        poll: "GET /v1/video/generations/{task_id}",
        contentType: "application/json",
        media: "image_urls（首帧、尾帧、其他参考图） / video_urls / audio_urls",
    },
    {
        value: "ljvideo-video",
        label: "灵境视频",
        capability: "video",
        create: "POST /api/open/v1/videos/generations",
        poll: "GET /api/open/v1/runs/{id}",
        contentType: "application/json · X-API-Key",
        media: "Seedance 2.5 特价-Y：1080P、5–30 秒、9 张参考图与 3 段音频，不支持参考视频",
    },
    {
        value: "yuxibox-video",
        label: "YuxiBox Seedance 视频",
        capability: "video",
        create: "POST /v1/videos",
        poll: "GET /v1/videos/{task_id} · GET /v1/videos/{task_id}/content",
        contentType: "application/json",
        media: "公网 HTTPS 图片、视频、音频参考素材，保持数组顺序",
    },
    {
        value: "mddkeji-video",
        label: "MDD 创AI 视频",
        capability: "video",
        create: "POST /api/v1/video/generations",
        poll: "GET /api/v1/video/generations/{task_id}",
        contentType: "application/json",
        media: "images / metadata.content（图片、视频、音频）",
    },
    {
        value: "moziaverse-hailuo-video",
        label: "MoziaVerse 海螺接口",
        capability: "video",
        create: "POST /v1/video/generations",
        poll: "GET /v1/video/generations/{task_id} · GET /v1/video/generations/{task_id}/content",
        contentType: "application/json",
        media: "Base URL: https://mzsjai.com；H3 文生、首帧、首尾帧及参考素材",
    },
    {
        value: "minimax-v2-video",
        label: "MiniMax V2 / H3",
        capability: "video",
        create: "POST /v2/video_generation / /v2/h3_context_ir / /v2/video_regeneration",
        poll: "GET /v2/query/video_generation/{task_id}",
        contentType: "application/json",
        media: "MiniMax-H3 / H3-Max：文生、首尾帧、多模态参考、Context-IR 与视频再生成",
    },
    { value: "xai-video", label: "xAI 官方视频", capability: "video", create: "POST /v1/videos/generations", poll: "GET /v1/videos/{request_id}", contentType: "application/json", media: "单张起始图" },
    {
        value: "volcengine-ark-video",
        label: "火山方舟视频",
        capability: "video",
        create: "POST /api/v3/contents/generations/tasks",
        poll: "GET /api/v3/contents/generations/tasks/{task_id}",
        contentType: "application/json",
        media: "图片、视频、音频参考素材",
    },
    { value: "volcengine-jimeng-video", label: "即梦官方视频", capability: "video", create: "POST CVSync2AsyncSubmitTask", poll: "POST CVSync2AsyncGetResult", contentType: "application/json + AK/SK 签名", media: "文本或一张首帧图，模型标识填写 req_key" },
    { value: "gemini-veo", label: "Gemini Veo", capability: "video", create: "POST /v1beta/models/{model}:predictLongRunning", poll: "GET /v1beta/{operation_name}", contentType: "application/json", media: "文本与单张起始图" },
    { value: "kling-cli-video", label: "可灵官方 CLI", capability: "video", create: "服务器 Kling CLI", poll: "query_tasks", contentType: "官方 CLI JSON", media: "文生、图生、Omni 参考；素材及参数以服务器官方账号声明为准" },
    { value: "tencent-mps-video", label: "腾讯云 MPS 视频超分", capability: "video", create: "POST Tencent ProcessMedia", poll: "POST DescribeTaskDetail", contentType: "TC3-HMAC-SHA256 JSON", media: "单个公网参考视频，输出到配置的 COS" },
];

export const MODEL_PROTOCOL_OPTIONS = protocolGroups(MODEL_PROTOCOLS.filter((item) => item.value !== "tencent-mps-video" && item.value !== "kling-cli-video" && item.value !== "ljvideo-video" && !item.value.startsWith("volcengine-jimeng-")));

export const SYSTEM_MODEL_PROTOCOL_OPTIONS = protocolGroups(MODEL_PROTOCOLS);

function protocolGroups(protocols: ModelProtocolDefinition[]) {
    return [
        { label: "文本", options: protocolOptions("text") },
        { label: "图片", options: protocolOptions("image") },
        { label: "视频", options: protocolOptions("video") },
        { label: "音频", options: protocolOptions("audio") },
    ].map((group) => ({ ...group, options: group.options.filter((option) => protocols.some((protocol) => protocol.value === option.value)) }));
}

export function modelProtocolDefinition(value?: string) {
    return MODEL_PROTOCOLS.find((item) => item.value === value);
}

export function modelProtocolLabel(value?: string) {
    if (value === "local-manager") return "Lalor 本地管理器";
    return modelProtocolDefinition(value)?.label || "自动识别";
}

export function modelProtocolCapability(value?: string) {
    return modelProtocolDefinition(value)?.capability;
}

export function isMiniMaxH3ModelName(model: string) {
    const normalized = model.trim().toLowerCase().replace(/[_.\s]+/g, "-");
    const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
    return normalized.includes("minimax-h3") || leaf === "h3" || leaf === "h3-max" || leaf === "h3max";
}

export function isMiniMaxH3MaxModelName(model: string) {
    const normalized = model.trim().toLowerCase().replace(/[_.\s]+/g, "-");
    const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
    return leaf === "minimax-h3-max" || leaf === "h3-max" || leaf === "h3max";
}

export function protocolForModelCatalog(endpointTypes: string[] = []): ModelProtocol | undefined {
    const normalized = new Set(endpointTypes.map((value) => value.trim().toLowerCase()));
    if (normalized.has("openai-chat") || normalized.has("chat-completion") || normalized.has("chat")) return "chat-completion";
    if (normalized.has("openai-response") || normalized.has("responses")) return "openai-response";
    if (normalized.has("gemini-image") || normalized.has("gemini-image-generation")) return "gemini-image";
    if (normalized.has("openai-image") || normalized.has("image")) return "openai-image";
    if (normalized.has("openai-video") || normalized.has("video")) return "newapi-channel-2";
    if (normalized.has("index-tts-v2") || normalized.has("index-tts")) return "index-tts-v2";
    if (normalized.has("suno-music") || normalized.has("music")) return "suno-music";
    if (normalized.has("openai-audio") || normalized.has("audio")) return "openai-audio";
    if (normalized.has("grok-image")) return "grok-image";
    if (normalized.has("gemini-veo") || normalized.has("gemini-video") || normalized.has("veo")) return "gemini-veo";
    if (normalized.has("volcengine-ark-video") || normalized.has("volcengine-ark")) return "volcengine-ark-video";
    return undefined;
}

/** 对 Nano Banana 提供 OpenAI Images 兼容默认值；已有显式协议始终优先。 */
export function defaultProtocolForModelName(model: string, capability?: ProtocolCapability): ModelProtocol | undefined {
    const normalized = model.trim().toLowerCase().replace(/[_.\s]+/g, "-");
    if (isMiniMaxH3ModelName(normalized)) {
        return capability === undefined || capability === "video" ? "minimax-v2-video" : undefined;
    }
    if (capability === undefined || capability === "audio") {
        const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
        if (leaf === "suno") return "suno-music";
    }
    if (capability !== undefined && capability !== "image") return undefined;
    if (normalized.includes("nano-banana") || normalized.includes("nanobanana")) return "openai-image";
    return undefined;
}

export function modelProtocolSummary(value?: string) {
    const protocol = modelProtocolDefinition(value);
    if (!protocol) return "保存模型时选择协议后，将在这里显示实际请求方式。";
    return [protocol.create, protocol.contentType, protocol.poll, protocol.media].filter(Boolean).join(" · ");
}

export function normalizeModelProtocol(value: unknown): ModelProtocol | undefined {
    if (value === "local-manager") return value;
    return typeof value === "string" && MODEL_PROTOCOLS.some((item) => item.value === value) ? (value as ModelProtocol) : undefined;
}

function protocolOptions(capability: ProtocolCapability) {
    return MODEL_PROTOCOLS.filter((item) => item.capability === capability).map((item) => ({ label: `${item.label} · ${item.create.replace("POST ", "")}`, value: item.value }));
}
