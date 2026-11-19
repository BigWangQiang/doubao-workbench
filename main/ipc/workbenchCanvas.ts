import { ipcMain } from '../security/trustedIpc';
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { replaceIpcHandlers } from './lifecycle';
import { listLocalAssets } from '../utils/localAssetStore';
import { canvasRead, canvasWrite, canvasRemove, getCanvasResource, saveCanvasBytes, registerCanvasFile, publicCanvasResource, registerCanvasResourceProtocol, type CanvasRecord } from '../services/workbenchCanvasStorage';
import { canvasPoolTask, createCanvasPoolTask, cancelCanvasPoolTask } from '../services/workbenchCanvasTasks';
import { downloadCanvasMedia } from '../services/workbenchCanvasApi';
import { createYuyanTask, listYuyanModels, listYuyanTaskIds, queryYuyanTask } from '../services/yuyanCanvasApi';

function object(value: unknown): CanvasRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画布请求格式错误');
    return value as CanvasRecord;
}
let creating: Promise<unknown> = Promise.resolve();
async function createTask(input: CanvasRecord): Promise<CanvasRecord> {
    const channel = String(object(object(input.input).config).channelId || '');
    if (!String(input.prompt || '').trim()) throw new Error('请输入提示词');
    if (!channel.startsWith('desktop-') && !channel.startsWith('yuyan-')) throw new Error('请选择工作台账号池或屿砚 API 模型');
    const run = creating.catch(() => undefined).then(() => channel.startsWith('yuyan-') ? createYuyanTask(input) : createCanvasPoolTask(input));
    creating = run;
    return run;
}
async function listAssets(): Promise<CanvasRecord[]> {
    const result: CanvasRecord[] = [];
    for (const asset of listLocalAssets()) {
        if (asset.taskStatus !== 'success') continue;
        try {
            const kind = asset.kind === 'video' ? 'video' : asset.kind === 'image' ? 'image' : /\.(mp3|wav|m4a|flac|ogg)$/i.test(asset.localFilePath) ? 'audio' : 'file';
            if (kind === 'file') continue;
            const id = 'asset-' + createHash('sha256').update(asset.assetId).digest('hex').slice(0, 32);
            const resource = await canvasRead<CanvasRecord>('resource:' + id) || await registerCanvasFile(asset.localFilePath, { kind, mimeType: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png' }, id);
            result.push({ id, kind, name: path.basename(asset.localFilePath), category: '', tags: asset.tags.join(','), coverResourceId: kind === 'image' ? id : '', payloadJson: JSON.stringify({ asset: { kind, title: path.basename(asset.localFilePath), ...(kind === 'image' ? { dataUrl: resource.publicUrl } : { url: resource.publicUrl }), storageKey: 'resource:' + id, width: resource.width || 1024, height: resource.height || 1024, mimeType: resource.mimeType, bytes: resource.size } }), published: true, sortOrder: 0, updatedAt: resource.updatedAt });
        } catch (error) {
            // 单个历史文件已被用户移走时不阻断整个素材库，记录可排查的文件编号。
            console.warn('[WorkbenchCanvas] 本地素材不可用:', asset.assetId, error instanceof Error ? error.message : '读取失败');
        }
    }
    return result;
}
export function registerWorkbenchCanvasIPC(): () => void {
    const dispose = replaceIpcHandlers(ipcMain, ['workbenchCanvas:invoke']);
    registerCanvasResourceProtocol();
    ipcMain.handle('workbenchCanvas:invoke', async (event, method: unknown, raw: unknown): Promise<unknown> => {
        const input = raw === undefined ? {} : object(raw);
        const key = String(input.key || '');
        switch (method) {
            case 'storage.get': return canvasRead(key);
            case 'storage.set': await canvasWrite(key, input.value); return null;
            case 'storage.remove': await canvasRemove(key); return null;
            case 'resources.upload': return { resource: publicCanvasResource(await saveCanvasBytes(input)) };
            case 'resources.get': return publicCanvasResource(await getCanvasResource(String(input.id)));
            case 'resources.import': return { resource: publicCanvasResource(await saveCanvasBytes({ ...input, ...await downloadCanvasMedia(String(input.url)) })) };
            case 'assets.list': return listAssets();
            case 'models.list': return listYuyanModels();
            case 'agent.create': case 'agent.get': case 'agent.cancel':
                throw new Error('屿砚客户 API 支持文本生成任务；画布助手请在屿砚网站使用。');
            case 'legacy.read': {
                const file = path.join(app.getPath('userData'), 'settings.json');
                try { const settings = JSON.parse(await fs.readFile(file, 'utf8')) as CanvasRecord; return { projects: settings.workbenchCanvasProjects, document: settings.workbenchCanvas }; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
            }
            case 'tasks.create': return createTask(input);
            case 'tasks.get': return readTask(String(input.id));
            case 'tasks.list': {
                const ids = [...await canvasRead<string[]>('task-ids') || [], ...await canvasRead<string[]>('api-task-ids') || [], ...await listYuyanTaskIds()];
                const tasks = await Promise.all(ids.map((id) => id.startsWith('api-yuyan-') ? canvasRead<CanvasRecord>(`yuyan-task:${id}`) : readTask(id)));
                return tasks.filter((task) => task && (!input.projectId || task.projectId === input.projectId) && (!input.activeOnly || ['queued', 'running'].includes(String(task.status)))).slice(-Math.min(200, Number(input.limit) || 30));
            }
            case 'tasks.cancel': {
                if (String(input.id).startsWith('api-yuyan-')) return queryYuyanTask(String(input.id), true);
                if (String(input.id).startsWith('api-')) throw new Error('此任务属于旧平台，请在原网站管理。');
                return cancelCanvasPoolTask(String(input.id));
            }
            case 'tasks.logs': return [];
            case 'tasks.text-deltas': {
                const task = await readTask(String(input.id));
                return { deltas: [], complete: task.status === 'succeeded', finalText: task.resultJson ? JSON.parse(String(task.resultJson)).text : '' };
            }
            default: throw new Error('不允许的画布操作');
        }
    });
    return dispose;
}

async function readTask(id: string): Promise<CanvasRecord> {
    if (id.startsWith('api-yuyan-')) return queryYuyanTask(id);
    if (!id.startsWith('api-')) return canvasPoolTask(id);
    const task = await canvasRead<CanvasRecord>(`api-task:${id}`);
    if (!task) throw new Error('画布任务不存在');
    return ['queued', 'running'].includes(String(task.status)) ? { ...task, status: 'failed', error: '此任务属于旧平台，请在原网站查看结果。' } : task;
}
