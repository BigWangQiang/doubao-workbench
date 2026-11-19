import { nanoid } from "nanoid";

import { videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { videoNodeSize } from "@/lib/canvas/canvas-node-size";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PROMPT = "参考白模视频的镜头运动、构图与主体位置，保持机位和动作节奏，补全人物外观、材质、光影与环境细节。";
export type BlenderConnection = { port: number; token: string };
export type BlenderDelivery = { id: string; canvasId: string; videoId: string };
export type BlenderTarget = { receiverId: string; canvasId: string; title: string };
export type BlenderPairMessage =
    | { type: "connect"; connection: BlenderConnection; requestId: string }
    | { type: "connected"; target: BlenderTarget; requestId: string }
    | { type: "error"; message: string; requestId: string };

export function blenderChannelName(userId: string) { return `lalor:blender:${userId}`; }
export type BlenderVideo = {
    id: string; name: string; file: File; width: number; height: number;
    duration: number; fps?: number; prompt: string;
};

export function parseBlenderConnection(hash: string): BlenderConnection | null {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const port = Number(params.get("port"));
    const token = params.get("token") || "";
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    return { port, token };
}

export async function blenderBridgeRequest(connection: BlenderConnection, path: "manifest" | "video" | "targets" | "delivery" | "receipt", signal: AbortSignal, options?: { query?: Record<string, string>; body?: object }) {
    // 仅本机 Agent 通道使用 fetch；不接受插件指定的任意 URL，也不携带站点 Cookie。
    const query = options?.query ? `?${new URLSearchParams(options.query)}` : "";
    const response = await fetch(`http://127.0.0.1:${connection.port}/${path}${query}`, {
        method: options?.body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${connection.token}`, ...(options?.body ? { "Content-Type": "application/json" } : {}) },
        body: options?.body ? JSON.stringify(options.body) : undefined, credentials: "omit",
        cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal,
    }).catch((error: unknown) => {
        if (signal.aborted) throw error;
        throw new Error("无法连接 Blender，请保持插件开启并允许浏览器访问本地网络，再同步目标画布。");
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 410
        ? "连接已过期，请在 Blender 重新同步目标画布"
        : "Blender 连接信息已变化，请重新同步目标画布后发送");
    return response;
}

export async function readBlenderVideo(connection: BlenderConnection, receiverId: string, delivery: BlenderDelivery, signal: AbortSignal, onProgress: (value: number) => void): Promise<BlenderVideo> {
    const options = { query: { receiverId, deliveryId: delivery.id } };
    const manifestResponse = await blenderBridgeRequest(connection, "manifest", signal, options);
    const manifestText = await manifestResponse.text();
    if (manifestText.length > 16_384) throw new Error("插件返回的白模信息过大");
    let manifest: unknown;
    try { manifest = JSON.parse(manifestText); }
    catch { throw new Error("插件返回的白模信息无法读取，请重新发送"); }
    if (!manifest || typeof manifest !== "object") throw new Error("插件返回的白模信息无效");
    const data = manifest as Record<string, unknown>;
    if (data.protocol !== "lalor-blender-v2" || data.id !== delivery.videoId || typeof data.id !== "string" || !/^[a-f0-9]{32}$/.test(data.id)
        || typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size <= 0 || data.size > MAX_BYTES) {
        throw new Error("白模文件信息无效，请更新插件；视频不能超过 256 MB");
    }
    const response = await blenderBridgeRequest(connection, "video", signal, options);
    const length = Number(response.headers.get("Content-Length"));
    if (length > MAX_BYTES || (length > 0 && length !== data.size) || !response.body) throw new Error("白模文件大小与插件信息不一致");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let loaded = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            if (loaded > MAX_BYTES || loaded > data.size) throw new Error("白模视频超过允许大小");
            chunks.push(new Uint8Array(value));
            onProgress(Math.round(loaded / data.size * 100));
        }
    } finally {
        // 清理流的错误不能遮住原始读取失败；业务错误仍由上层明确显示。
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    if (loaded !== data.size) throw new Error("白模视频未完整读取，请重新读取");
    const file = new File(chunks, "white-model.mp4", { type: "video/mp4" });
    const metadata = await inspectBlenderVideo(file, signal);
    return {
        ...metadata, id: data.id, file,
        name: typeof data.name === "string" ? data.name.slice(0, 120) : "Blender 白模",
        fps: typeof data.fps === "number" && data.fps > 0 && data.fps <= 240 ? data.fps : undefined,
        prompt: typeof data.prompt === "string" && data.prompt.trim() ? data.prompt.slice(0, 4000) : DEFAULT_PROMPT,
    };
}

async function inspectBlenderVideo(file: File, signal?: AbortSignal): Promise<Pick<BlenderVideo, "width" | "height" | "duration">> {
    if (!file.size || file.size > MAX_BYTES || !file.name.toLowerCase().endsWith(".mp4")) throw new Error("请选择不超过 256 MB 的 MP4 视频");
    if (signal?.aborted) throw new Error("读取已取消");
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (signal?.aborted) throw new Error("读取已取消");
    if (String.fromCharCode(...header.slice(4, 8)) !== "ftyp") throw new Error("文件不是有效 MP4");
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(file);
        const cleanup = () => {
            clearTimeout(timer); signal?.removeEventListener("abort", cancel);
            video.onloadedmetadata = null; video.onerror = null;
            video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
        };
        const fail = (reason: string) => { cleanup(); reject(new Error(reason)); };
        const cancel = () => fail("读取已取消");
        const timer = window.setTimeout(() => fail("视频无法读取，请使用 H.264 编码的 MP4"), 15_000);
        signal?.addEventListener("abort", cancel, { once: true });
        video.onloadedmetadata = () => {
            const width = video.videoWidth, height = video.videoHeight, duration = video.duration;
            if (!width || !height || !Number.isFinite(duration) || duration <= 0 || duration > 120.1) {
                fail("视频尺寸或时长无效，白模参考视频不能超过 120 秒"); return;
            }
            cleanup(); resolve({ width, height, duration });
        };
        video.onerror = () => fail("视频无法解码，请使用 H.264 编码的 MP4");
        video.preload = "metadata"; video.src = url;
    });
}

export async function prepareBlenderCanvasNodes(video: BlenderVideo, currentNodes: () => CanvasNodeData[], assertTarget: () => void, onProgress: (value: number) => void) {
    assertTarget();
    // 直接复用强校验资源上传，不用会静默降级到本地 Blob 的上传入口。
    const resource = await uploadResourceFile(video.file, "video", {
        fileName: video.file.name, width: video.width, height: video.height,
        durationMs: Math.round(video.duration * 1000), onProgress,
    });
    assertTarget();
    if (!resource.id || resource.status !== "ready") throw new Error("视频尚未保存成功，请稍后重新导入");
    // 上传期间用户仍可编辑，落点和插入内容都基于最新节点，不能覆盖旧快照。
    const nodes = currentNodes();
    const x = nodes.length ? Math.max(...nodes.map((node) => node.position.x + node.width)) + 120 : 400;
    const y = nodes.length ? Math.min(...nodes.map((node) => node.position.y)) : 380;
    const reference = createCanvasNode(CanvasNodeType.Video, { x, y }, {
        ...videoMetadata({ url: resourceFileUrl(resource.id), storageKey: resourceStorageKey(resource.id),
            bytes: resource.size, mimeType: "video/mp4", width: video.width, height: video.height, durationMs: Math.round(video.duration * 1000) }),
        workflowKind: "reference_video", assetTags: ["Blender 白模"], blenderImportId: video.id,
    });
    reference.title = `${video.name} · 白模参考`;
    Object.assign(reference, videoNodeSize(video.width, video.height));
    reference.position = { x, y };
    const generation = createCanvasNode(CanvasNodeType.Video, { x: x + reference.width + 120, y }, {
        generationMode: "video", status: "idle", workflowKind: "shot",
        prompt: video.prompt.trim() || DEFAULT_PROMPT, composerContent: video.prompt.trim() || DEFAULT_PROMPT,
        videoEditOperation: "reference_to_video", referenceAssetNodeIds: [reference.id],
        // 参考节点保留真实画幅；生成参数由所选模型的有效选项决定。
    });
    generation.title = "白模转成片";
    generation.position = { x: x + reference.width + 120, y };
    return {
        nodes: [reference, generation], connections: [{ id: nanoid(), fromNodeId: reference.id, toNodeId: generation.id }],
    };
}
