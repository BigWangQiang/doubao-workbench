import { app, net, protocol } from 'electron';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';

export type CanvasRecord = Record<string, unknown>;
export interface LocalCanvasResource extends CanvasRecord { id: string; mimeType: string; kind: string; size: number; publicUrl: string; localPath: string; }
function directory(): string { return path.join(app.getPath('userData'), 'WorkbenchCanvas'); }
function storagePath(key: string): string {
    if (!key || key.length > 1000) throw new Error('无效的画布存储标识');
    return path.join(directory(), 'state', createHash('sha256').update(key).digest('hex') + '.json');
}
export async function canvasRead<T>(key: string): Promise<T | null> {
    try { return JSON.parse(await fs.readFile(storagePath(key), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('本地画布数据读取失败，请保留数据目录并重试'); }
}
const writes = new Map<string, Promise<void>>();
export async function canvasWrite(key: string, value: unknown): Promise<void> {
    const file = storagePath(key);
    const run = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(async (): Promise<void> => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('不能保存空的画布值');
        await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
        await fs.copyFile(file, file + '.bak').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        await fs.rename(temporary, file);
    });
    writes.set(key, run);
    try { await run; } finally { if (writes.get(key) === run) writes.delete(key); }
}
export async function canvasRemove(key: string): Promise<void> { await writes.get(key); await fs.rm(storagePath(key), { force: true }); }
export function canvasResourceURL(id: string): string { return `lalor-canvas://resources/${encodeURIComponent(id)}`; }
export async function getCanvasResource(id: string): Promise<LocalCanvasResource> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('无效素材编号');
    const resource = await canvasRead<LocalCanvasResource>('resource:' + id);
    if (!resource) throw new Error('本地素材不存在');
    return resource;
}
export async function registerCanvasFile(file: string, metadata: CanvasRecord, existingId?: string): Promise<LocalCanvasResource> {
    const stat = await fs.stat(file);
    if (!stat.isFile() || !stat.size) throw new Error('素材文件不可用');
    const id = existingId || randomUUID();
    const now = new Date().toISOString();
    const resource: LocalCanvasResource = { ...metadata, id, userId: 'desktop', status: 'ready', provider: 'local', endpoint: '', bucket: '', objectKey: id, mimeType: String(metadata.mimeType || 'application/octet-stream'), kind: String(metadata.kind || 'file'), size: stat.size, publicUrl: canvasResourceURL(id), localPath: file, createdAt: now, updatedAt: now };
    await canvasWrite('resource:' + id, resource);
    return resource;
}
export async function saveCanvasBytes(input: CanvasRecord): Promise<LocalCanvasResource> {
    if (!(input.bytes instanceof Uint8Array)) throw new Error('素材内容无效');
    if (!input.bytes.length || input.bytes.length > 512 * 1024 * 1024) throw new Error('素材大小必须在 512MB 以内');
    const id = randomUUID();
    const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/flac': '.flac' };
    const extension = extensions[String(input.mimeType)] || '.bin';
    const file = path.join(directory(), 'media', id + extension);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.bytes, { flag: 'wx' });
    const { bytes: _bytes, ...metadata } = input;
    return registerCanvasFile(file, metadata, id);
}
export function publicCanvasResource(resource: LocalCanvasResource): CanvasRecord {
    const { localPath: _localPath, ...view } = resource;
    return view;
}
let protocolRegistered = false;
export function registerCanvasResourceProtocol(): void {
    if (protocolRegistered) return;
    protocolRegistered = true;
    protocol.handle('lalor-canvas', async (request): Promise<Response> => {
        try {
            const url = new URL(request.url);
            if (url.hostname === 'app' && request.method === 'GET') {
                // 独立的本地静态根，沿用原画布 /icons、/canvas 等资源路径。
                const root = path.resolve(__dirname, '../../renderer/canvas');
                const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
                const relative = path.relative(root, file);
                if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
                return net.fetch(pathToFileURL(file).href);
            }
            if (url.hostname !== 'resources' || request.method !== 'GET') return new Response('Not found', { status: 404 });
            const resource = await getCanvasResource(decodeURIComponent(url.pathname.slice(1)));
            // 只读已登记文件；URL 不能携带任意本机路径。原生 file fetch 保留视频 Range 支持。
            return net.fetch(pathToFileURL(resource.localPath).href, { headers: request.headers });
        } catch { return new Response('Local media not found', { status: 404 }); }
    });
}
