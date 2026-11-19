import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { desktopCall, isDesktop } from './bridge';
import { readLocal, writeLocal, removeLocal } from './storage';
import { readResource, saveResource, localResourceUrl, localResourceAccess } from './resources';

type RecordData = Record<string, unknown>;
function record(value: unknown): RecordData { return value && typeof value === 'object' ? value as RecordData : {}; }
async function route(config: InternalAxiosRequestConfig): Promise<unknown> {
    const url = new URL(config.url || '/', 'https://desktop.invalid');
    const path = url.pathname;
    const method = (config.method || 'get').toLowerCase();
    const input = typeof config.data === 'string' ? JSON.parse(config.data) as RecordData : config.data;
    const params = { ...Object.fromEntries(url.searchParams), ...record(config.params) };
    if (path === '/resources' && method === 'post' && input instanceof FormData) return saveResource(input);
    if (path === '/resources/import' && method === 'post') {
        const address = String(input.url || '');
        if (!/^https:\/\//.test(address)) throw new Error('只能导入 HTTPS 素材地址');
        if (isDesktop) return desktopCall('resources.import', input);
        const response = await fetch(address, { signal: config.signal as AbortSignal });
        if (!response.ok) throw new Error(`素材下载失败 (${response.status})`);
        const form = new FormData(); form.set('file', await response.blob()); form.set('kind', input.kind);
        return saveResource(form);
    }
    const resource = /^\/resources\/([^/]+)(?:\/(access|playback))?$/.exec(path);
    if (resource && method === 'get') {
        const value = await readResource(decodeURIComponent(resource[1]));
        if (resource[2] === 'access') return { access: { resourceId: value.id, ...await localResourceAccess(value, String(params.variant || 'original')), delivery: 'platform-local', requestedVariant: params.variant || 'original', issuedAt: new Date().toISOString(), refreshAt: new Date(Date.now() + 86_400_000).toISOString(), revision: value.updatedAt } };
        if (resource[2] === 'playback') return { status: 'ready', url: localResourceUrl(value.id) };
        return { resource: value };
    }
    if (path === '/tasks' && method === 'post') return desktopCall('tasks.create', input);
    if (path === '/agent/turns' && method === 'post') return desktopCall('agent.create', input);
    const agent = /^\/agent\/turns\/([^/]+)(\/cancel)?$/.exec(path);
    if (agent && ((agent[2] && method === 'post') || (!agent[2] && method === 'get'))) {
        return desktopCall(agent[2] ? 'agent.cancel' : 'agent.get', { id: decodeURIComponent(agent[1]) });
    }
    if (path === '/tasks' && method === 'get') return isDesktop ? desktopCall('tasks.list', params) : [];
    const task = /^\/tasks\/([^/]+)(?:\/(cancel|logs|text-deltas))?$/.exec(path);
    if (task) return desktopCall(`tasks.${task[2] || 'get'}`, { id: task[1] });
    if (path === '/projects' && method === 'get') return { projects: [] };
    if (path === '/assets/generated-times') return { times: {} };
    const collection = /^\/(canvas-projects|assets)(?:\/([^/]+))?$/.exec(path);
    if (collection) {
        const [, namespace, id] = collection;
        const ids = await readLocal<string[]>(`${namespace}:ids`) || [];
        const field = namespace === 'assets' ? 'asset' : 'project';
        const key = `${namespace}:${id}`;
        if (method === 'get' && !id) return { [namespace === 'assets' ? 'assets' : 'projects']: (await Promise.all(ids.map((item) => readLocal(`${namespace}:${item}`)))).filter(Boolean) };
        if (method === 'get') { const value = await readLocal(key); if (!value) throw new Error('本地记录不存在'); return { [field]: value }; }
        if (method === 'put' && id && input?.[field]) { await writeLocal(key, input[field]); await writeLocal(`${namespace}:ids`, [...new Set([...ids, id])]); return { [field]: input[field] }; }
        if (method === 'delete' && id) { await removeLocal(key); await writeLocal(`${namespace}:ids`, ids.filter((item) => item !== id)); return { id, releasedBytes: 0, retainedResourceCount: 0 }; }
    }
    if (path.startsWith('/library')) return libraryRoute(path, method, input, params);
    if ((path === '/skills' || path === '/skills/added') && method === 'get') return { skills: [], total: 0, categories: [] };
    if (path === '/wallet' && method === 'get') throw new Error('本地画布免费，API 调用余额请在 Lalor 账户查看');
    throw new Error(`独立工作台尚无此网站服务接口：${method.toUpperCase()} ${path}。未发送请求。`);
}

async function libraryRoute(path: string, method: string, input: RecordData, params: RecordData): Promise<unknown> {
    const saved = await readLocal<RecordData[]>('local-library') || [];
    const assets = isDesktop ? await desktopCall<RecordData[]>('assets.list') : [];
    const items = [...saved, ...assets];
    if (path === '/library/categories') return [...new Set(items.map((item) => String(item.category || '')).filter(Boolean))];
    if (path === '/library' && method === 'get') {
        const found = items.filter((item) => (!params.kind || item.kind === params.kind || (params.kind === 'media' && ['image', 'video', 'text'].includes(String(item.kind)))) && (!params.keyword || String(item.name).toLowerCase().includes(String(params.keyword).toLowerCase())) && (!params.category || item.category === params.category));
        const page = Math.max(1, Number(params.page) || 1), limit = Math.max(1, Number(params.limit) || 24);
        return { items: found.slice((page - 1) * limit, page * limit), total: found.length, page, limit };
    }
    const id = path.split('/')[2];
    if ((method === 'get' || path.endsWith('/use')) && id) { const item = items.find((item) => item.id === id); if (!item) throw new Error('素材不存在'); return item; }
    if (method === 'post' || method === 'put') {
        const item = { ...input, id: id || crypto.randomUUID(), payloadJson: JSON.stringify(input.payload), updatedAt: new Date().toISOString() };
        await writeLocal('local-library', [...saved.filter((old) => old.id !== item.id), item]); return item;
    }
    throw new Error('不支持的本地素材操作');
}

export const desktopAdapter: AxiosAdapter = async (config) => {
    if (config.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const data = await route(config);
    // 写入已发生时必须返回真实回执，不能因 UI 关闭而丢掉任务编号。
    return { data: { code: 0, data, msg: '' }, status: 200, statusText: 'OK', headers: {}, config };
};
