import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createYuyanTask, queryYuyanTask } from '../../main/services/yuyanCanvasApi';

const mock = vi.hoisted(() => ({
    records: new Map<string, unknown>(),
    authorize: vi.fn(),
    download: vi.fn(),
    save: vi.fn(),
}));
vi.mock('../../main/ipc/yuyanAuth', () => ({ readYuyanKey: (): string => 'synthetic-key', requireYuyanGenerationAccess: mock.authorize }));
vi.mock('../../main/services/workbenchCanvasApi', () => ({ downloadCanvasMedia: mock.download }));
vi.mock('../../main/services/workbenchCanvasStorage', () => ({
    canvasRead: (key: string): unknown => mock.records.get(key) ?? null,
    canvasWrite: (key: string, value: unknown): void => { mock.records.set(key, value); },
    getCanvasResource: vi.fn(),
    saveCanvasBytes: mock.save,
}));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5cAAAAASUVORK5CYII=', 'base64');
const input = {
    type: 'canvas_image', operation: 'image', prompt: 'synthetic image',
    input: { mode: 'image', config: { channelId: 'yuyan-my-channel', model: 'synthetic-image', size: '1:1', count: '1' },
        referenceImages: [{ dataUrl: 'data:image/png;base64,' + png.toString('base64') }] },
};
const ok = (data: object): Response => Response.json({ code: 0, data });

describe('屿砚客户 API', (): void => {
    beforeEach((): void => {
        vi.resetAllMocks();
        mock.records.clear();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test forbids network')));
    });
    afterEach((): void => { vi.unstubAllGlobals(); });

    it('blocks before uploading or creating a task if membership is denied', async (): Promise<void> => {
        mock.authorize.mockRejectedValue(new Error('expired'));
        await expect(createYuyanTask(input)).rejects.toThrow('expired');
        expect(fetch).not.toHaveBeenCalled();
        expect(mock.records.size).toBe(0);
    });

    it('uploads once, submits once, and saves a completed image from the same-origin file route', async (): Promise<void> => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(ok({ id: 'reference-1' }))
            .mockResolvedValueOnce(ok({ id: 'remote-1', status: 'queued', stage: 'queued' }))
            .mockResolvedValueOnce(ok({ id: 'remote-1', status: 'succeeded', progress: 100, files: [{ id: 'image-1', kind: 'image', contentUrl: '/api/v1/files/image-1/content' }] }));
        mock.download.mockResolvedValue({ bytes: png });
        mock.save.mockResolvedValue({ id: 'saved-1', publicUrl: 'lalor-canvas://resources/saved-1', size: png.length });
        const task = await createYuyanTask(input);
        const requests = vi.mocked(fetch).mock.calls;
        expect(requests[0][0]).toBe('https://yuyan-ai.site/api/v1/files');
        expect(requests[0][1]?.body).toBeInstanceOf(FormData);
        expect(requests[1][0]).toBe('https://yuyan-ai.site/api/v1/tasks');
        expect(JSON.parse(String(requests[1][1]?.body))).toMatchObject({
            channelId: 'my-channel', model: 'synthetic-image', idempotencyKey: task.id, references: [{ fileId: 'reference-1', role: 'reference' }],
        });
        const result = await queryYuyanTask(task.id);
        expect(result.status).toBe('succeeded');
        expect(result.resultJson).toContain('resource:saved-1');
        expect(mock.download).toHaveBeenCalledWith('https://yuyan-ai.site/api/v1/files/image-1/content', true, 0, 'synthetic-key', 'https://yuyan-ai.site');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not resubmit after an uncertain submission', async (): Promise<void> => {
        vi.mocked(fetch).mockRejectedValue(new Error('connection closed'));
        const task = await createYuyanTask({ ...input, input: { ...input.input, referenceImages: [] } });
        expect(task.stage).toContain('核对提交结果');
        expect((await queryYuyanTask(task.id)).status).toBe('failed');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('maps video parameters to the site contract and only cancels the recorded remote task', async (): Promise<void> => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(ok({ id: 'video-task', status: 'queued', stage: 'queued' }))
            .mockResolvedValueOnce(ok({ id: 'video-task', status: 'cancelled', progress: 0, files: [] }));
        const task = await createYuyanTask({
            type: 'canvas_video', operation: 'text_to_video', prompt: 'fake video',
            input: { mode: 'video', config: { channelId: 'yuyan-video', model: 'fake-model', videoSeconds: '6s', size: '16:9', vquality: '720p' } },
        });
        expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({
            capability: 'video', operation: 'text_to_video', options: { duration: 6, size: '16:9', resolution: '720p' },
        });
        expect((await queryYuyanTask(task.id, true)).status).toBe('cancelled');
        expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://yuyan-ai.site/api/v1/tasks/video-task/cancel');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
