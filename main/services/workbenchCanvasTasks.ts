import type { Task, VideoModel, VideoDuration, VideoAspectRatio } from '@doubao-studio/contracts';
import { createTasksForLocalPlugin, getTaskForLalor, cancelTaskForLalor, listTaskArtifactFilesForLalor } from '../ipc/tasks';
import { canvasRead, canvasWrite, getCanvasResource, registerCanvasFile, type CanvasRecord } from './workbenchCanvasStorage';
import { requireYuyanGenerationAccess } from '../ipc/yuyanAuth';

export async function createCanvasPoolTask(input: CanvasRecord): Promise<CanvasRecord> {
    await requireYuyanGenerationAccess();
    const body = input.input as CanvasRecord;
    const config = body?.config as CanvasRecord;
    const channel = String(config?.channelId || '');
    if (channel !== 'desktop-doubao' && channel !== 'desktop-dola') throw new Error('无效账号池');
    const mode = String(body.mode || '').replace('text', 'chat');
    if (!['image', 'video', 'chat'].includes(mode)) throw new Error('此账号池暂不支持音频生成');
    const readPaths = async (references: unknown, kind: string): Promise<string[]> => {
        if (!Array.isArray(references)) return [];
        return Promise.all(references.map(async (reference: CanvasRecord): Promise<string> => {
            const id = String(reference.storageKey || '').replace(/^resource:/, '');
            const resource = await getCanvasResource(id);
            if (resource.kind !== kind) throw new Error('参考素材类型不匹配');
            return resource.localPath;
        }));
    };
    const [images, videos, audios] = await Promise.all([readPaths(body.referenceImages, 'image'), readPaths(body.referenceVideos, 'video'), readPaths(body.referenceAudios, 'audio')]);
    if (body.mask) throw new Error('账号池不支持蒙版局部重绘，请使用支持此能力的 API 模型');
    const model = String(config.model);
    const duration = String(config.videoSeconds).replace(/s$/, '') + 's';
    // 和本地画布目录同步，仅豆包 2.0 / Fast 新增 15 秒；发送仍需回读平台控件。
    const supports15s = channel === 'desktop-doubao' && ['seedance-2.0', 'seedance-2.0-fast'].includes(model);
    const durationAllowed = ['4s', '5s', '10s', '30s'].includes(duration) || (supports15s && duration === '15s');
    if (mode === 'video' && (!['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'].includes(model) || !durationAllowed || !['16:9', '9:16', '1:1'].includes(String(config.size)))) throw new Error('此账号池不支持所选视频参数');
    const created = createTasksForLocalPlugin({
        prompts: [String(input.prompt || '')], mode: mode as 'image' | 'video' | 'chat', targetPlatform: channel === 'desktop-dola' ? 'dola' : 'doubao',
        attachments: images, referenceVideos: videos, audioAttachments: audios, audioAttachment: audios[0],
        ...(mode === 'video' ? { videoConfig: { model: model as VideoModel, duration: duration as VideoDuration, aspectRatio: String(config.size) as VideoAspectRatio } } : {}),
    });
    const task = created[0];
    await canvasWrite('task:' + task.id, { id: task.id, projectId: input.projectId, type: input.type, prompt: input.prompt, model: input.model, inputJson: JSON.stringify(input.input), createdAt: task.createdAt });
    const ids = await canvasRead<string[]>('task-ids') || [];
    await canvasWrite('task-ids', [...new Set([...ids, task.id])]);
    return canvasPoolTask(task.id);
}
function mappedStatus(task: Task): string {
    if (task.status === 'done') return 'succeeded';
    if (task.status === 'fail') return 'failed';
    if (task.status === 'cancelled') return 'cancelled';
    if (['pending', 'queued'].includes(task.status)) return 'queued';
    return 'running';
}
export async function canvasPoolTask(id: string): Promise<CanvasRecord> {
    const binding = await canvasRead<CanvasRecord>('task:' + id);
    if (!binding) throw new Error('这不是当前画布创建的任务');
    const task = getTaskForLalor(id);
    if (!task) throw new Error('任务已不存在');
    const status = mappedStatus(task);
    let resultJson = '';
    if (status === 'succeeded') {
        const files = listTaskArtifactFilesForLalor(id);
        const resources = await Promise.all(files.map(async (file, index): Promise<CanvasRecord> => {
            const saved = await registerCanvasFile(file.filePath, { kind: file.kind, mimeType: file.contentType || (file.kind === 'video' ? 'video/mp4' : 'image/png') }, `task-${id}-${index}`);
            return { dataUrl: saved.publicUrl, storageKey: 'resource:' + saved.id, bytes: saved.size, mimeType: saved.mimeType };
        }));
        if (task.mode === 'chat') resultJson = JSON.stringify({ text: task.result || '' });
        else if (!resources.length) throw new Error('任务已完成，但本地产物尚未归档，请在任务中心检查下载状态');
        else resultJson = JSON.stringify(task.mode === 'video' ? { video: resources[0] } : { images: resources });
    }
    return { ...binding, status, resultJson, progress: status === 'succeeded' ? 100 : -1, stage: task.runtime?.message || task.status, error: task.errorInfo?.message || (status === 'failed' ? task.result : undefined), attempts: 1, updatedAt: task.updatedAt, providerRequestId: id, continuePolling: true };
}
export async function cancelCanvasPoolTask(id: string): Promise<CanvasRecord> {
    if (!await canvasRead('task:' + id)) throw new Error('无权停止其他任务');
    cancelTaskForLalor(id, '用户在工作台画布停止任务');
    return canvasPoolTask(id);
}
