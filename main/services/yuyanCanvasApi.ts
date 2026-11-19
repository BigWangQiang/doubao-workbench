import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { YUYAN_CUSTOMER_API, YUYAN_ORIGIN } from '../config/yuyanPlatform';
import { readYuyanKey, requireYuyanGenerationAccess } from '../ipc/yuyanAuth';
import { contentTypeFromArtifactBytes } from '../utils/artifactKind';
import { downloadCanvasMedia } from './workbenchCanvasApi';
import { canvasRead, canvasWrite, getCanvasResource, saveCanvasBytes, type CanvasRecord } from './workbenchCanvasStorage';

type CloudStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type Reference = { storageKey?: string; url?: string; dataUrl?: string; role?: string };
type GenerationInput = {
    operation: string; prompt: string; type: string; projectId?: string;
    input: { mode: 'image' | 'video' | 'text'; config: {
        channelId: string; model: string; size: string; vquality: string; quality: string; count: string; videoSeconds: string;
        videoGenerateAudio: string; videoWatermark: string; systemPrompt?: string;
    }; mask?: Reference; referenceImages?: Reference[]; referenceVideos?: Reference[]; referenceAudios?: Reference[];
    metadata?: { videoEditOperation?: string } };
};
type RemoteFile = { id: string; kind: 'image' | 'video'; contentUrl: string };
type RemoteTask = { id: string; status: CloudStatus; progress: number; stage: string; error: string; text?: string; files: RemoteFile[] };
type LocalTask = Omit<RemoteTask, 'files' | 'text'> & CanvasRecord & { remoteId?: string; credentialHash: string };
const taskIndex = 'yuyan-task-ids';
const taskKey = (id: string): string => `yuyan-task:${id}`;
const credentialHash = (key: string): string => createHash('sha256').update(key).digest('hex');
const pendingReads = new Map<string, Promise<LocalTask>>();

async function request<T>(route: string, key: string, body?: FormData | object): Promise<T> {
    const form = body instanceof FormData;
    const response = await fetch(`${YUYAN_CUSTOMER_API}${route}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(body === undefined ? 25_000 : 120_000),
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
        body: form ? body : JSON.stringify(body),
    });
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error(`屿砚 API 响应格式无效（HTTP ${response.status}）`);
    const envelope: { code: number; data?: T; msg: string } = await response.json();
    if (!response.ok || envelope.code !== 0 || envelope.data === undefined || envelope.data === null) throw new Error(envelope.msg || `屿砚 API 请求失败（HTTP ${response.status}）`);
    return envelope.data;
}

export async function listYuyanModels(): Promise<CanvasRecord> {
    return request<CanvasRecord>('/models', readYuyanKey());
}

async function uploadReference(ref: Reference, key: string, defaultRole: string): Promise<{ fileId: string; role: string }> {
    let bytes: Uint8Array;
    let mimeType: string;
    if (ref.storageKey?.startsWith('resource:')) {
        const resource = await getCanvasResource(ref.storageKey.slice('resource:'.length));
        [bytes, mimeType] = [await readFile(resource.localPath), resource.mimeType];
    } else if (ref.dataUrl) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(ref.dataUrl);
        if (!match) throw new Error('参考图格式无效');
        [bytes, mimeType] = [Buffer.from(match[2], 'base64'), match[1]];
    } else if (ref.url) {
        ({ bytes, mimeType } = await downloadCanvasMedia(ref.url));
    } else throw new Error('参考素材缺少文件或 HTTPS 地址');
    const form = new FormData();
    form.set('file', new Blob([Uint8Array.from(bytes)], { type: mimeType }), `reference.${mimeType.split('/')[1]}`);
    const file = await request<{ id: string }>('/files', key, form);
    if (!file.id) throw new Error('屿砚未返回参考文件编号');
    return { fileId: file.id, role: ref.role || defaultRole };
}

export async function createYuyanTask(raw: CanvasRecord): Promise<LocalTask> {
    const input = raw as GenerationInput;
    const { mode, config } = input.input;
    if (!['image', 'video', 'text'].includes(mode) || !config.channelId.startsWith('yuyan-') || !config.model) throw new Error('请选择屿砚模型');
    if (input.input.mask) throw new Error('屿砚客户 API 不支持蒙版编辑');
    const key = readYuyanKey();
    await requireYuyanGenerationAccess(key);
    const id = `api-yuyan-${randomUUID()}`;
    const now = new Date().toISOString();
    const task: LocalTask = { id, type: input.type, projectId: input.projectId, status: 'running', stage: '准备生成', progress: 0, error: '', prompt: input.prompt, model: config.model, credentialHash: credentialHash(key), createdAt: now, updatedAt: now, inputJson: JSON.stringify({ mode, metadata: (raw.input as CanvasRecord).metadata }) };
    await canvasWrite(taskKey(id), task);
    const ids = await listYuyanTaskIds();
    await canvasWrite(taskIndex, [...ids, id]);
    let submitting = false;
    try {
        const refs: Array<{ fileId: string; role: string }> = [];
        const images = input.input.referenceImages ?? [], videos = input.input.referenceVideos ?? [], audios = input.input.referenceAudios ?? [];
        const operation = mode === 'video'
            ? input.input.metadata?.videoEditOperation || (videos.length || audios.length ? 'reference_to_video' : input.operation)
            : mode === 'text' ? 'text_generation' : images.length ? 'image_to_image' : 'text_to_image';
        for (const [index, ref] of images.entries()) {
            const role = operation === 'reference_to_video' ? 'reference_image'
                : operation === 'image_to_video' && images.length <= 2 ? (index === 0 ? 'first_frame' : 'last_frame') : 'reference';
            refs.push(await uploadReference(ref, key, role));
        }
        for (const ref of videos) refs.push(await uploadReference(ref, key, 'reference_video'));
        for (const ref of audios) refs.push(await uploadReference(ref, key, 'reference_audio'));
        const options: Record<string, string | number | boolean> = {};
        if (mode !== 'text' && config.size && config.size !== 'auto') options.size = config.size;
        if (mode === 'image' && config.quality && config.quality !== 'auto') options.quality = config.quality;
        if (mode === 'image' && Number(config.count) > 0) options.count = Number(config.count);
        if (mode === 'video' && config.videoSeconds && config.videoSeconds !== 'auto') options.duration = Number(config.videoSeconds.replace(/s$/, ''));
        if (mode === 'video' && config.vquality && config.vquality !== 'auto') options.resolution = config.vquality;
        if (mode === 'video' && ['true', 'false'].includes(config.videoGenerateAudio)) options.generateAudio = config.videoGenerateAudio === 'true';
        if (mode === 'video' && ['true', 'false'].includes(config.videoWatermark)) options.watermark = config.videoWatermark === 'true';
        if (key !== readYuyanKey()) throw new Error('屿砚登录已改变，未提交生成');
        submitting = true;
        const remote = await request<RemoteTask>('/tasks', key, { channelId: config.channelId.slice('yuyan-'.length), model: config.model,
            capability: mode, operation, options, references: refs, idempotencyKey: id,
            prompt: mode === 'text' && config.systemPrompt ? `${config.systemPrompt}\n\n${input.prompt}` : input.prompt });
        if (!remote.id) throw new Error('屿砚未返回任务编号');
        const next: LocalTask = { ...task, remoteId: remote.id, stage: remote.stage };
        await canvasWrite(taskKey(id), next);
        return next;
    } catch (error) {
        const next: LocalTask = { ...task, status: 'failed', stage: submitting ? '请在屿砚网站核对提交结果' : '未提交生成', error: error instanceof Error ? error.message : String(error) };
        await canvasWrite(taskKey(id), next);
        return next;
    }
}

export async function listYuyanTaskIds(): Promise<string[]> {
    return (await canvasRead<string[]>(taskIndex)) ?? [];
}

async function saveYuyanResult(task: LocalTask, remote: RemoteTask, key: string): Promise<LocalTask> {
    const result: CanvasRecord = {};
    const images: CanvasRecord[] = [];
    if (remote.status === 'succeeded') {
        if (remote.text) result.text = remote.text;
        if (!remote.text && !remote.files.length) throw new Error('屿砚任务结束但尚未返回产物');
        for (const file of remote.files) {
            const path = `/api/v1/files/${encodeURIComponent(file.id)}/content`;
            if (file.contentUrl !== path) throw new Error('屿砚产物地址不符合下载合同');
            const { bytes } = await downloadCanvasMedia(`${YUYAN_ORIGIN}${path}`, true, 0, key, YUYAN_ORIGIN);
            const mimeType = contentTypeFromArtifactBytes(bytes);
            if (!mimeType?.startsWith(`${file.kind}/`)) throw new Error('屿砚返回的产物与媒体格式不匹配');
            const media = await saveCanvasBytes({ bytes, mimeType, kind: file.kind });
            const view = { storageKey: `resource:${media.id}`, url: media.publicUrl, bytes: media.size, mimeType };
            if (file.kind === 'image') images.push({ ...view, dataUrl: media.publicUrl });
            else result.video = view;
        }
        if (images.length) result.images = images;
    }
    const next = { ...task, status: remote.status, progress: remote.progress, stage: remote.stage, error: remote.error, updatedAt: new Date().toISOString(), ...(remote.status === 'succeeded' ? { resultJson: JSON.stringify(result) } : {}) };
    await canvasWrite(taskKey(task.id), next);
    return next;
}

export async function queryYuyanTask(id: string, cancel = false): Promise<LocalTask> {
    const running = pendingReads.get(id);
    if (running) {
        if (!cancel) return running;
        await running;
    }
    const run = (async (): Promise<LocalTask> => {
        const task = await canvasRead<LocalTask>(taskKey(id));
        if (!task) throw new Error('屿砚任务不存在');
        if (!task.remoteId || !['queued', 'running'].includes(task.status)) return task;
        const key = readYuyanKey();
        if (task.credentialHash !== credentialHash(key)) throw new Error('请先恢复提交任务时使用的屿砚 Key');
        const route = `/tasks/${encodeURIComponent(task.remoteId)}`;
        const remote = await request<RemoteTask>(cancel ? `${route}/cancel` : route, key, cancel ? {} : undefined);
        return saveYuyanResult(task, remote, key);
    })();
    pendingReads.set(id, run);
    try { return await run; } finally { if (pendingReads.get(id) === run) pendingReads.delete(id); }
}
