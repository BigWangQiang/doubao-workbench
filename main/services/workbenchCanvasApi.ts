import { app, safeStorage } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import https from 'https';
import { isIP } from 'net';
import { canvasRead, canvasWrite, saveCanvasBytes, getCanvasResource, type CanvasRecord } from './workbenchCanvasStorage';
import { contentTypeFromArtifactBytes } from '../utils/artifactKind';
import { requireLalorGenerationAccess } from '../ipc/lalorAuth';

const API_ORIGIN = 'https://aigc.lalun.cn';
const API_BASE_URL = `${API_ORIGIN}/api/v1`;
async function apiKey(): Promise<string> {
    const config = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'workbench-api.json'), 'utf8')) as { apiKeyCipher?: string };
    if (!config.apiKeyCipher || !safeStorage.isEncryptionAvailable()) throw new Error('请先在 API 设置中保存 Lalor API Key');
    return safeStorage.decryptString(Buffer.from(config.apiKeyCipher, 'base64'));
}
/** 固定平台出口，密钥不进入渲染进程。生成请求从不自动重发。 */
export async function canvasApiRequest(endpoint: string, body?: unknown, credential?: string, method?: 'GET' | 'POST' | 'DELETE', signal?: AbortSignal): Promise<CanvasRecord> {
    if (!/^\/(models|resources(?:\/[a-zA-Z0-9_-]{1,128})?|images\/(generations|edits)|chat\/completions|videos(?:\/[a-zA-Z0-9_-]+)?)$/.test(endpoint)) throw new Error('不允许的 API 路径');
    const multipart = body instanceof FormData;
    const requestMethod = method || (body ? 'POST' : 'GET');
    if (requestMethod === 'DELETE' && !/^\/resources\/[a-zA-Z0-9_-]{1,128}$/.test(endpoint)) throw new Error('不允许的清理路径');
    // 文件上传由运行时生成 boundary；不能手写 multipart 的 Content-Type。
    const timeout = AbortSignal.timeout(requestMethod === 'POST' ? 30 * 60_000 : 25_000);
    const response = await fetch(`${API_BASE_URL}${endpoint}`, { method: requestMethod, headers: { Authorization: `Bearer ${credential ?? await apiKey()}`, Accept: 'application/json', ...(!multipart ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (endpoint === '/resources' && response.status === 404) throw new Error('网站尚未启用参考素材上传，请更新服务端后重试；本次未提交生成。');
    if (endpoint === '/images/edits' && response.status === 404) throw new Error('Lalor 参考图接口 /api/v1/images/edits 返回 404。未改发文生图，也未重复提交，请核对网站当前开放的接口地址。');
    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
        // 不把网页正文、上游地址或可能夹带的凭据写进本地任务错误。
        throw new Error(`Lalor API ${endpoint} 返回非 JSON 响应（HTTP ${response.status}），未取得生成结果。未自动重试，请先在网站核对记录。`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Lalor API ${endpoint} 返回格式无效（HTTP ${response.status}）`);
    const value = parsed as CanvasRecord;
    if (!response.ok || value.error || (typeof value.code === 'number' && value.code !== 0)) {
        throw new Error(String((value.error as CanvasRecord)?.message || (typeof value.error === 'string' ? value.error : '') || value.msg || `Lalor API 请求失败 (${response.status})`));
    }
    return value;
}
function publicIP(address: string): boolean {
    if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address);
    const [a, b] = address.split('.').map(Number);
    return isIP(address) === 4 && a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}
export async function downloadCanvasMedia(address: string, auth = false, redirects = 0, credential?: string, allowedOrigin = API_ORIGIN): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || redirects > 4) throw new Error('素材地址无效');
    const resolved = await lookup(url.hostname);
    if (!publicIP(resolved.address)) throw new Error('不能从本机或内网地址下载素材');
    const authorization = auth && url.origin === allowedOrigin ? `Bearer ${credential ?? await apiKey()}` : undefined;
    return new Promise((resolve, reject): void => {
        // DNS 校验与实际连接使用同一个地址，防止二次解析访问内网。
        const request = https.get(url, { lookup: (_hostname, options, callback): void => {
            // Node 的连接器启用 all 时要求地址数组；返回单个字符串会触发 Invalid IP address。
            if (options.all) callback(null, [resolved]);
            else callback(null, resolved.address, resolved.family);
        }, headers: authorization ? { Authorization: authorization } : {} }, (response): void => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                void downloadCanvasMedia(new URL(response.headers.location, url).href, false, redirects + 1).then(resolve, reject); return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`素材下载失败 (${response.statusCode})`)); return; }
            const chunks: Buffer[] = []; let total = 0;
            response.on('data', (chunk: Buffer): void => { total += chunk.length; if (total > 512 * 1024 * 1024) { response.destroy(new Error('素材超过 512MB')); return; } chunks.push(chunk); });
            response.on('error', reject);
            response.on('aborted', (): void => reject(new Error('素材下载中断，正在重新取回原结果')));
            response.on('end', (): void => {
                const expected = Number(response.headers['content-length']);
                if (Number.isFinite(expected) && expected > 0 && total !== expected) { reject(new Error('素材下载不完整，正在重新取回原结果')); return; }
                resolve({ bytes: Buffer.concat(chunks), mimeType: String(response.headers['content-type'] || 'application/octet-stream').split(';')[0] });
            });
        });
        request.setTimeout(120_000, (): void => { request.destroy(new Error('素材下载超时')); });
        request.on('error', reject);
    });
}
export async function createCanvasApiTask(input: CanvasRecord): Promise<CanvasRecord> {
    const credential = await apiKey();
    const payload = input.input as CanvasRecord;
    const mode = String(payload.mode);
    if (!['video', 'image', 'text'].includes(mode)) throw new Error('Lalor 公共 API 暂未提供此生成接口');
    if (payload.mask) throw new Error('Lalor 公共 API 未开放蒙版编辑接口，本次未提交');
    const imageRequest = mode === 'image' ? await imageGenerationRequest(payload) : undefined;
    await requireLalorGenerationAccess();
    const now = new Date().toISOString(), id = 'api-' + randomUUID();
    const metadata = payload.metadata as CanvasRecord | undefined;
    // 刷新后按本地任务和节点绑定恢复；不把密钥、媒体地址或参考文件正文写入任务输入。
    const inputJson = JSON.stringify({ mode, prompt: payload.prompt, metadata: { nodeId: metadata?.nodeId, sourceNodeId: metadata?.sourceNodeId } });
    const task = { id, projectId: input.projectId, type: input.type || `canvas_${mode}`, prompt: input.prompt || payload.prompt, model: input.model, inputJson, apiKeyHash: createHash('sha256').update(credential).digest('hex'), status: 'running', stage: '正在准备生成', progress: -1, attempts: 1, createdAt: now, updatedAt: now, providerRequestId: id, continuePolling: true };
    await canvasWrite('api-task:' + id, task);
    const ids = await canvasRead<string[]>('api-task-ids') || []; await canvasWrite('api-task-ids', [...ids, id]);
    void executeApiTask(id, payload, credential, imageRequest).catch(async (error: unknown): Promise<void> => {
        const current = await canvasRead<CanvasRecord>('api-task:' + id);
        await canvasWrite('api-task:' + id, { ...current, status: 'failed', error: error instanceof Error ? error.message : 'API 调用失败', updatedAt: new Date().toISOString() });
    });
    return task;
}
async function executeApiTask(id: string, payload: CanvasRecord, credential: string, imageRequest?: ImageGenerationRequest): Promise<void> {
    const config = payload.config as CanvasRecord, mode = String(payload.mode), prompt = String(payload.prompt || '');
    let task = await canvasRead<CanvasRecord>('api-task:' + id);
    if (mode === 'video') {
        const request: CanvasRecord = { model: config.model, prompt };
        if (config.videoSeconds) request.seconds = Number(config.videoSeconds);
        if (config.size && config.size !== 'auto') request.size = config.size;
        if (config.vquality && config.vquality !== 'auto') request.resolution = config.vquality;
        if (config.operation) request.operation = config.operation;
        const groups = [['reference_images', 'referenceImages', 'image'], ['reference_videos', 'referenceVideos', 'video'], ['reference_audios', 'referenceAudios', 'audio']] as const;
        const total = groups.reduce((sum, [, key]) => sum + (Array.isArray(payload[key]) ? (payload[key] as unknown[]).length : 0), 0);
        let done = 0;
        const uploaded = new Map<string, { resource_id: string }>();
        const temporaryResourceIds = Array.isArray(task?.temporaryResourceIds) ? [...task.temporaryResourceIds as string[]] : [];
        const temporaryCleanupTokens: Record<string, string> = {};
        for (const [field, key, kind] of groups) {
            if (!Array.isArray(payload[key])) continue;
            const refs: Array<{ url: string } | { resource_id: string }> = [];
            for (const ref of payload[key] as CanvasRecord[]) {
                await canvasWrite('api-task:' + id, { ...task, stage: `正在上传参考素材 ${done + 1}/${total}`, updatedAt: new Date().toISOString() });
                refs.push(await prepareVideoReference(ref, kind, credential, uploaded, temporaryResourceIds, temporaryCleanupTokens));
                done++;
                task = { ...task, temporaryResourceIds: [...temporaryResourceIds], temporaryCleanupTokens: { ...temporaryCleanupTokens }, stage: `正在上传参考素材 ${done}/${total}`, updatedAt: new Date().toISOString() };
                await canvasWrite('api-task:' + id, task);
            }
            if (refs.length) request[field] = refs;
        }
        task = { ...task, temporaryResourceIds, stage: '素材已就绪，正在提交生成', updatedAt: new Date().toISOString() };
        await canvasWrite('api-task:' + id, task);
        const value = await canvasApiRequest('/videos', request, credential);
        if (typeof value.id !== 'string' || !value.id) throw new Error('API 未返回任务编号，请人工核对，不要重复提交');
        await canvasWrite('api-task:' + id, { ...task, remoteId: value.id, stage: 'Lalor 正在生成', providerRequestId: value.id, updatedAt: new Date().toISOString() });
        return;
    }
    const references: string[] = [];
    for (const reference of (mode === 'text' ? payload.referenceImages || [] : []) as CanvasRecord[]) {
        const resource = await getCanvasResource(String(reference.storageKey).replace(/^resource:/, ''));
        const bytes = await fs.readFile(resource.localPath);
        references.push(`data:${resource.mimeType};base64,${bytes.toString('base64')}`);
    }
    if (mode === 'image' && !imageRequest) throw new Error('图片请求尚未准备完成');
    const value = await canvasApiRequest(imageRequest?.endpoint || '/chat/completions', imageRequest
        ? imageRequest.body
        : { model: config.model, stream: false, messages: [...(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []), { role: 'user', content: references.length ? [{ type: 'text', text: prompt }, ...references.map((url) => ({ type: 'image_url', image_url: { url } }))] : prompt }] }, credential);
    let result: CanvasRecord;
    if (mode === 'text') {
        const choices = value.choices as Array<{ message?: { content?: string } }>;
        if (!choices?.[0]?.message?.content) throw new Error('API 未返回文本');
        result = { text: choices[0].message.content };
    } else {
        const images = [];
        if (!Array.isArray(value.data) || !value.data.length) throw new Error('Lalor 图片 API 未返回 data 图片数组，请先在网站核对记录，不要重复提交');
        for (const item of value.data as CanvasRecord[]) {
            if (!item || typeof item !== 'object' || (typeof item.b64_json !== 'string' && typeof item.url !== 'string')) throw new Error('Lalor 图片 API 返回的图片缺少 url 或 b64_json');
            const media = item.b64_json ? { bytes: Buffer.from(String(item.b64_json), 'base64'), mimeType: 'image/png' } : await downloadCanvasMedia(String(item.url));
            const mimeType = contentTypeFromArtifactBytes(media.bytes);
            if (!mimeType?.startsWith('image/')) throw new Error('Lalor 图片 API 未返回有效图片文件，未保存为成功结果');
            const resource = await saveCanvasBytes({ ...media, mimeType, kind: 'image' });
            images.push({ dataUrl: resource.publicUrl, storageKey: 'resource:' + resource.id, bytes: resource.size, mimeType: resource.mimeType });
        }
        if (!images.length) throw new Error('API 未返回图片');
        result = { images };
    }
    await canvasWrite('api-task:' + id, { ...task, status: 'succeeded', progress: 100, resultJson: JSON.stringify(result), updatedAt: new Date().toISOString() });
}
interface ImageGenerationRequest { endpoint: '/images/generations' | '/images/edits'; body: CanvasRecord | FormData; }
async function imageGenerationRequest(payload: CanvasRecord): Promise<ImageGenerationRequest> {
    const config = payload.config as CanvasRecord | undefined;
    const model = typeof config?.model === 'string' ? config.model.trim() : '';
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!model) throw new Error('请选择 Lalor API 图片模型');
    if (!prompt) throw new Error('请输入图片提示词');
    // 原样使用 /models 的完整模型 ID；每张请求 n=1，不发送画布私有字段。
    const request: CanvasRecord = { model, prompt, n: 1 };
    for (const key of ['size', 'quality']) {
        const value = config?.[key];
        if (typeof value === 'string' && value.trim() && value !== 'auto') request[key] = value;
    }
    const references = Array.isArray(payload.referenceImages) ? payload.referenceImages as CanvasRecord[] : [];
    if (!references.length) return { endpoint: '/images/generations', body: request };
    const form = new FormData();
    for (const [key, value] of Object.entries(request)) form.set(key, String(value));
    // 沿用 OpenAI 图片编辑的文件协议；顺序与画布参考图一致，绝不把本机路径当成公网 URL。
    for (const [index, reference] of references.entries()) {
        const storageKey = typeof reference.storageKey === 'string' ? reference.storageKey : '';
        let bytes: Uint8Array;
        if (storageKey.startsWith('resource:')) {
            const resource = await getCanvasResource(storageKey.slice('resource:'.length));
            if (resource.kind !== 'image' || resource.size > 50 * 1024 * 1024) throw new Error('参考图类型无效或超过 50MB');
            bytes = await fs.readFile(resource.localPath);
        } else {
            const address = String(reference.url || reference.dataUrl || '');
            if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(address)) bytes = Buffer.from(address.slice(address.indexOf(',') + 1), 'base64');
            else bytes = (await downloadCanvasMedia(address)).bytes;
        }
        const mimeType = contentTypeFromArtifactBytes(bytes);
        if (!mimeType?.startsWith('image/') || !bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('参考图不是有效图片或超过 50MB');
        const extension = mimeType.split('/')[1];
        form.append('image', new Blob([new Uint8Array(bytes)], { type: mimeType }), `reference-${index + 1}.${extension}`);
    }
    return { endpoint: '/images/edits', body: form };
}
function videoReference(ref: CanvasRecord): { url: string } | { resource_id: string } | null {
    const url = String(ref.url || '').trim();
    if (/^https:\/\//.test(url)) return { url };
    // storageKey/resourceId 是工作台本地编号，网站无法读取；只接受明确传入的站点 resource_id。
    const explicitResourceId = String(ref.resource_id || '').trim();
    return /^[a-zA-Z0-9_-]{1,128}$/.test(explicitResourceId) ? { resource_id: explicitResourceId } : null;
}
async function prepareVideoReference(ref: CanvasRecord, kind: 'image' | 'video' | 'audio', credential: string, uploaded: Map<string, { resource_id: string }>, temporaryResourceIds: string[], cleanupTokens: Record<string, string>): Promise<{ url: string } | { resource_id: string }> {
    const remote = videoReference(ref);
    if (remote) return remote;
    const key = typeof ref.storageKey === 'string' ? ref.storageKey : '';
    if (!key.startsWith('resource:')) throw new Error('参考素材尚未保存到本机，请重新上传；本次未提交生成。');
    const cacheKey = kind + ':' + key;
    const previous = uploaded.get(cacheKey);
    if (previous) return previous;
    const resource = await getCanvasResource(key.slice('resource:'.length));
    if (resource.kind !== kind || resource.size <= 0 || resource.size > 512 * 1024 * 1024) throw new Error('参考素材类型或大小不符合要求；本次未提交生成。');
    const bytes = await fs.readFile(resource.localPath);
    if (bytes.length !== resource.size) throw new Error('本机参考文件已变化，请重新上传；本次未提交生成。');
    const form = new FormData();
    form.set('kind', kind);
    form.set('purpose', 'temporary_reference');
    form.set('file', new Blob([new Uint8Array(bytes)], { type: resource.mimeType }), `reference-${kind}`);
    // 与生成请求固定使用同一份 Key；本地编号绝不冒充网站资源编号。
    const value = await canvasApiRequest('/resources', form, credential);
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) || value.status !== 'ready' || value.kind !== kind) throw new Error('参考素材上传未返回有效资源编号；本次未提交生成。');
    const result = { resource_id: value.id };
    uploaded.set(cacheKey, result);
    if (typeof value.cleanupToken !== 'string' || !value.cleanupToken) throw new Error('网站未返回临时素材清理凭证；本次未提交生成。');
    temporaryResourceIds.push(value.id);
    cleanupTokens[value.id] = value.cleanupToken;
    return result;
}
const polling = new Map<string, Promise<CanvasRecord>>();
const downloads = new Map<string, Promise<void>>();
const cleanups = new Map<string, Promise<void>>();

function cleanupTemporaryResources(task: CanvasRecord): void {
    const taskID = String(task.id);
    if (task.status !== 'succeeded' || !task.resultJson || !task.remoteId || cleanups.has(taskID) || Number(task.nextCleanupAt || 0) > Date.now()) return;
    const ids = Array.isArray(task.temporaryResourceIds) ? task.temporaryResourceIds.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) : [];
    if (!ids.length) return;
    const run = (async (): Promise<void> => {
        const credential = await apiKey();
        // 完成任务的回收也校验原 Key，切换账号后不能携带新账号的密钥执行删除。
        if (!task.apiKeyHash || task.apiKeyHash !== createHash('sha256').update(credential).digest('hex')) throw new Error('等待恢复原任务密钥');
        const tokens = task.temporaryCleanupTokens as Record<string, string> | undefined;
        const remaining = [...ids];
        for (const id of ids) {
            if (!tokens?.[id]) continue;
            try {
                const result = await canvasApiRequest('/resources/' + id, { cleanup_token: tokens[id], task_id: task.remoteId }, credential, 'DELETE');
                if (result.deleted !== true || result.id !== id) continue;
                remaining.splice(remaining.indexOf(id), 1);
            } catch {
                // 清理失败仅影响重试记录，绝不回退已经保存的成片，也不重发生成。
            }
        }
        const latest = await canvasRead<CanvasRecord>('api-task:' + taskID);
        if (!latest || latest.status !== 'succeeded') return;
        await canvasWrite('api-task:' + taskID, { ...latest, temporaryResourceIds: remaining,
            temporaryCleanupTokens: Object.fromEntries(remaining.map((id) => [id, tokens?.[id]])),
            cleanupStatus: remaining.length ? 'pending' : 'completed', nextCleanupAt: remaining.length ? Date.now() + 60_000 : undefined });
    })().catch(async (): Promise<void> => {
        const latest = await canvasRead<CanvasRecord>('api-task:' + taskID);
        if (latest) await canvasWrite('api-task:' + taskID, { ...latest, cleanupStatus: 'pending', nextCleanupAt: Date.now() + 60_000 });
    });
    cleanups.set(taskID, run);
    void run.catch((): void => { console.error('[WorkbenchCanvas] 临时素材清理记录保存失败，待下次恢复'); }).finally((): void => { cleanups.delete(taskID); });
}

/** 主进程恢复既有任务和清理记录，页面刷新或关闭画布不影响取回；不创建新生成。 */
export function startCanvasApiRecovery(): () => void {
    let stopped = false, running = false;
    const tick = async (): Promise<void> => {
        if (stopped || running) return;
        running = true;
        try {
            const ids = await canvasRead<string[]>('api-task-ids') || [];
            for (const id of ids) {
                if (stopped) break;
                const task = await canvasRead<CanvasRecord>('api-task:' + id);
                if (task?.remoteId && (['queued', 'running'].includes(String(task.status)) || (task.status === 'succeeded' && Array.isArray(task.temporaryResourceIds) && task.temporaryResourceIds.length))) await queryCanvasApiTask(id);
            }
        } catch {
            console.warn('[WorkbenchCanvas] 任务恢复暂时中断，下轮继续查询');
        } finally { running = false; }
    };
    const timer = setInterval((): void => { void tick(); }, 10_000);
    timer.unref();
    void tick();
    return (): void => { stopped = true; clearInterval(timer); };
}

function retrieveVideo(task: CanvasRecord, credential: string): void {
    const id = String(task.id);
    if (downloads.has(id) || Number(task.nextDownloadAt || 0) > Date.now()) return;
    const run = (async (): Promise<void> => {
        try {
            const media = await downloadCanvasMedia(`${API_BASE_URL}/videos/${task.remoteId}/content`, true, 0, credential);
            const mimeType = contentTypeFromArtifactBytes(media.bytes);
            if (!mimeType?.startsWith('video/')) throw new Error('取回内容不是有效视频文件');
            const resource = await saveCanvasBytes({ ...media, mimeType, kind: 'video' });
            const completed = { ...task, status: 'succeeded', stage: '视频已保存到本机', progress: 100, error: undefined, nextDownloadAt: undefined, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultJson: JSON.stringify({ video: { dataUrl: resource.publicUrl, storageKey: 'resource:' + resource.id, mimeType: resource.mimeType, bytes: resource.size } }) };
            // 先保存可恢复的结果，再后台清理，不能让清理网络延迟卡住成功状态。
            await canvasWrite('api-task:' + id, completed);
            cleanupTemporaryResources(completed);
        } catch {
            // 取回失败不改变上游成功事实，不重投生成，也不丢失原任务编号。
            await canvasWrite('api-task:' + id, { ...task, status: 'running', stage: '视频已生成，取回暂时失败，正在重试', progress: 99, continuePolling: true, nextDownloadAt: Date.now() + 10_000, updatedAt: new Date().toISOString() });
        }
    })();
    downloads.set(id, run);
    void run.catch((): void => { console.error('[WorkbenchCanvas] 视频取回状态保存失败，原任务编号仍保留'); }).finally((): void => { downloads.delete(id); });
}

export async function queryCanvasApiTask(id: string): Promise<CanvasRecord> {
    const current = await canvasRead<CanvasRecord>('api-task:' + id);
    if (!current) throw new Error('API 任务不存在');
    // queued 也必须继续查询；提交响应通常先返回 queued，不能因为一次查询后变成 queued 就停止轮询。
    if (!current.remoteId || !['queued', 'running'].includes(String(current.status))) {
        cleanupTemporaryResources(current);
        return current;
    }
    const existing = polling.get(id); if (existing) return existing;
    const run = (async (): Promise<CanvasRecord> => {
        const credential = await apiKey();
        if (current.apiKeyHash && current.apiKeyHash !== createHash('sha256').update(credential).digest('hex')) throw new Error('请在接口设置中恢复提交此任务时使用的密钥，原任务仍保留');
        if (current.remoteCompleted) { retrieveVideo(current, credential); return current; }
        const value = await canvasApiRequest('/videos/' + current.remoteId, undefined, credential);
        if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.status))) throw new Error('任务状态响应无效，正在重新查询原任务');
        let next: CanvasRecord = { ...current, status: value.status, progress: value.progress, error: value.error, updatedAt: new Date().toISOString() };
        if (value.status === 'succeeded') {
            // 先持久化“上游成功”，取回在后台进行，不让下载耗时阻塞画布刷新查询。
            next = { ...next, status: 'running', remoteCompleted: true, stage: '视频已生成，正在取回文件', progress: 99, continuePolling: true };
        }
        await canvasWrite('api-task:' + id, next);
        if (next.remoteCompleted) retrieveVideo(next, credential);
        return next;
    })().catch(async (): Promise<CanvasRecord> => {
        // 查询失败只说明同步中断，不等于记录不存在；刷新仍返回持久化凭证。
        const retained = await canvasRead<CanvasRecord>('api-task:' + id) || current;
        if (retained.status === 'succeeded') return retained;
        return { ...retained, stage: '任务状态同步暂时中断，正在重连原任务', continuePolling: true };
    });
    polling.set(id, run);
    try { return await run; } finally { polling.delete(id); }
}
