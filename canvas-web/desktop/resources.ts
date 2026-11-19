import localforage from 'localforage';
import { desktopCall, isDesktop } from './bridge';
import type { RemoteResource } from '@/services/api/resources';
import { createVideoPosterBlob } from '@/lib/video-poster';

const preview = localforage.createInstance({ name: 'lalor-desktop-canvas-preview', storeName: 'media' });
const urls = new Map<string, string>();
const posters = localforage.createInstance({ name: 'lalor-desktop-canvas-preview', storeName: 'video_posters' });
const posterUrls = new Map<string, { revision: string; url: string }>();
const posterRequests = new Map<string, Promise<string>>();

/** thumbnail 必须返回图片，不能把原 MP4 地址交给 img；历史视频也按需补齐。 */
export async function localResourceAccess(resource: RemoteResource, variant: string): Promise<{ url: string; actualVariant: 'original' | 'thumbnail' }> {
    if (variant !== 'thumbnail' || (resource.kind !== 'video' && !resource.mimeType.startsWith('video/'))) {
        return { url: localResourceUrl(resource.id), actualVariant: 'original' };
    }
    const revision = `${resource.updatedAt}:${resource.size}`;
    const cached = posterUrls.get(resource.id);
    if (cached?.revision === revision) return { url: cached.url, actualVariant: 'thumbnail' };
    const key = `${resource.id}:${revision}`;
    let request = posterRequests.get(key);
    if (!request) {
        request = (async (): Promise<string> => {
            const stored = await posters.getItem<{ revision: string; blob: Blob }>(resource.id);
            const blob = stored?.revision === revision ? stored.blob : await createVideoPosterBlob(localResourceUrl(resource.id));
            if (stored?.revision !== revision) await posters.setItem(resource.id, { revision, blob });
            const url = URL.createObjectURL(blob);
            const previous = posterUrls.get(resource.id);
            if (previous) URL.revokeObjectURL(previous.url);
            posterUrls.set(resource.id, { revision, url });
            return url;
        })();
        posterRequests.set(key, request);
    }
    try { return { url: await request, actualVariant: 'thumbnail' }; }
    finally { if (posterRequests.get(key) === request) posterRequests.delete(key); }
}

export function localResourceUrl(id: string): string {
    return isDesktop ? `lalor-canvas://resources/${encodeURIComponent(id)}` : urls.get(id) || '';
}
export async function restorePreviewResources(): Promise<void> {
    if (isDesktop) return;
    await preview.iterate<{ resource: RemoteResource; blob: Blob }, void>((value, key) => {
        urls.set(key, URL.createObjectURL(value.blob));
    });
}
export async function saveResource(form: FormData): Promise<{ resource: RemoteResource }> {
    const blob = form.get('file');
    if (!(blob instanceof Blob) || !blob.size) throw new Error('请选择有效素材');
    const metadata = { name: blob instanceof File ? blob.name : '素材', mimeType: blob.type, kind: String(form.get('kind') || 'file'), width: Number(form.get('width')) || undefined, height: Number(form.get('height')) || undefined, durationMs: Number(form.get('durationMs')) || undefined };
    if (isDesktop) return desktopCall('resources.upload', { ...metadata, bytes: new Uint8Array(await blob.arrayBuffer()) });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const resource: RemoteResource = { ...metadata, id, userId: 'desktop', status: 'ready', provider: 'local', endpoint: '', bucket: '', objectKey: id, publicUrl: '', size: blob.size, createdAt: now, updatedAt: now };
    await preview.setItem(id, { resource, blob });
    urls.set(id, URL.createObjectURL(blob));
    return { resource: { ...resource, publicUrl: localResourceUrl(id) } };
}
export async function readResource(id: string): Promise<RemoteResource> {
    if (isDesktop) return desktopCall('resources.get', { id });
    const value = await preview.getItem<{ resource: RemoteResource; blob: Blob }>(id);
    if (!value) throw new Error('本地素材不存在');
    if (!urls.has(id)) urls.set(id, URL.createObjectURL(value.blob));
    return { ...value.resource, publicUrl: localResourceUrl(id) };
}
