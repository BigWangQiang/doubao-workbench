import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { StoryboardBatch, StoryboardBatchInput, StoryboardRow, TaskStatus } from '@doubao-studio/contracts';
import { downloadTaskOutputs, getTaskForLalor, taskService } from '../ipc/tasks';
import { requireYuyanGenerationAccess as requireLalorGenerationAccess } from '../ipc/yuyanAuth';
import { resolveStoryboardPrompt, storyboardImageLabel, StoryboardBatchStore, validateStoryboardBatch } from './storyboardBatchStore';
import { StoryboardBrowser, StoryboardCommandNotStartedError, type StoryboardSubmitResult } from './storyboardBrowser';

const mimeFor = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
};

interface NodeObservation {
  state: string; url?: string; message?: string; progress?: number; retryable?: boolean;
  retryReceipt?: { attemptId: string; status: 'waiting' | 'settled' | 'blocked' | 'unknown'; message?: string };
}

const MAX_REGENERATION_CLICKS = 5;
const REGENERATION_INTERVAL_MS = 5000;

export class StoryboardBatchService {
  private readonly store = new StoryboardBatchStore();
  private readonly browser = new StoryboardBrowser((id): void => {
    // 未发送编辑器只存在于豆包页面内存，窗口关闭/刷新后本机 ready 不再可信。
    // 此处只更新运行时视图；下次保存会持久化，进程重启也会作同样失效处理。
    const batch = this.store.list().find(item => item.id === id);
    if (!batch) return;
    for (const row of batch.rows) {
      if (row.state === 'ready' && !row.submissionIntentAt && !row.submittedAt) {
        row.state = 'pending'; row.message = '画布已关闭或刷新，待恢复提示词、参数和参考图';
      }
    }
    if (batch.rows.some(row => row.state === 'pending')) {
      batch.phase = 'paused'; batch.message = '豆包未发送草稿已失效，请恢复准备；本机分镜和参考图仍保留';
    }
  });
  private readonly running = new Map<string, Promise<void>>();
  private readonly stopping = new Set<string>();
  // 查询可并发，页面选中和点击必须串行，不能让多个失败节点抢焦点。
  private regenerationTurn: Promise<void> = Promise.resolve();

  list(): StoryboardBatch[] { return this.store.list().map((batch) => ({ ...batch, busy: this.running.has(batch.id) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  /** 同一账号只能有一个页面写入者；持久任务锁也阻止普通队列抢占账号。 */
  private async execute(id: string, action: (batch: StoryboardBatch) => Promise<void>, newGeneration: boolean): Promise<void> {
    if (this.running.has(id)) throw new Error('该批次正在处理，请等待当前操作结束');
    const batch = this.store.get(id);
    if (this.list().some((item) => item.id !== id && item.accountId === batch.accountId && item.busy)) throw new Error('该豆包账号已有批次正在操作，请先暂停原批次');
    this.stopping.delete(id);
    let release: (() => void) | undefined;
    // 先登记运行状态，再异步鉴权，防止双击创建两个执行器。
    const run = Promise.resolve().then(async (): Promise<void> => {
      if (newGeneration) await requireLalorGenerationAccess();
      const lockTask = batch.rows.map((row) => getTaskForLalor(row.taskId)).find(Boolean);
      if (!lockTask) throw new Error('批次任务记录不存在，已停止操作');
      const ownerId = `storyboard:${batch.id}`;
      const locked = taskService.acquireLock({ taskId: lockTask.id, ownerId }, true);
      if (!locked.success) throw new Error(locked.error);
      const timer = setInterval((): void => {
        try {
          const renewed = taskService.renewLock({ taskId: lockTask.id, ownerId });
          if (!renewed.success) { this.stopping.add(id); this.browser.stop(batch); }
        } catch { this.stopping.add(id); this.browser.stop(batch); }
      }, 5000);
      release = (): void => {
        clearInterval(timer);
        const result = taskService.releaseLock({ taskId: lockTask.id, ownerId });
        if (!result.success) throw new Error(result.error);
      };
      this.checkStopped(batch);
      await action(batch);
    }).catch((error: unknown): never => {
      batch.phase = 'paused'; batch.message = error instanceof Error ? error.message : String(error); this.store.save(batch);
      throw error;
    }).finally((): void => {
      try { release?.(); } finally { this.running.delete(id); this.stopping.delete(id); }
    });
    this.running.set(id, run);
    await run;
  }

  private checkStopped(batch: StoryboardBatch): void {
    if (this.stopping.has(batch.id)) throw new Error('已暂停后续操作，已提交任务仍在豆包生成，不会自动重发');
  }

  private updateTask(row: StoryboardRow, status: TaskStatus, result: string, outputs?: string[]): void {
    const updated = taskService.updateStatus({ taskId: row.taskId, status, result, outputs });
    if (!updated.success) throw new Error(updated.error);
  }

  async create(raw: StoryboardBatchInput): Promise<StoryboardBatch> {
    await requireLalorGenerationAccess();
    const input = validateStoryboardBatch(raw);
    const id = randomUUID();
    const now = new Date().toISOString();
    const tasksResult = taskService.createStoryboardBatch(id, input);
    if (!tasksResult.success) throw new Error(tasksResult.error);
    const rows: StoryboardRow[] = input.rows.map((row, index) => ({ ...row, taskId: tasksResult.data[index].id, state: 'pending' }));
    const batch: StoryboardBatch = { ...input, id, rows, phase: 'draft', message: '已保存分镜草稿，等待创建豆包画布', createdAt: now, updatedAt: now };
    this.store.save(batch);
    return batch;
  }

  async open(id: string): Promise<void> { await this.browser.open(this.store.get(id)); }

  async remove(id: string): Promise<void> {
    if (this.running.has(id)) throw new Error('批次正在运行，请先暂停并等待当前操作结束');
    const batch = this.store.get(id);
    if (batch.rows.some((row) => ['submitting', 'generating', 'saving'].includes(row.state) || ((row.submissionIntentAt || row.submittedAt) && !['done', 'failed'].includes(row.state)))) throw new Error('批次还有已发送或结果待确认的任务，请先找回进度；删除记录无法取消豆包生成');
    this.store.remove(id);
    this.browser.close(id);
  }

  async prepare(id: string): Promise<void> {
    await this.execute(id, (batch) => this.prepareInternal(batch), true);
  }

  private async prepareInternal(batch: StoryboardBatch): Promise<void> {
    if (!batch.rows.some(row => !row.submissionIntentAt && !row.submittedAt && row.state !== 'done')) throw new Error('此批次已经发送过，请查询原节点，不再重新准备');
    batch.phase = 'preparing'; batch.message = '正在打开豆包账号并准备画布'; this.store.save(batch);
    const identity = await this.browser.ensureCanvas(batch);
    batch.canvasId = identity.canvasId; batch.canvasUrl = identity.url;
    this.store.save(batch);
    for (const [index, row] of batch.rows.entries()) {
      this.checkStopped(batch);
      if (row.submissionIntentAt || row.submittedAt || row.state === 'generating' || row.state === 'done') continue;
      if (!getTaskForLalor(row.taskId)) throw new Error(`分镜${row.number}任务记录已删除，已停止准备`);
      try {
        if (row.state === 'ready') {
          try { await this.browser.command(batch, 'verify', this.expected(batch, row)); continue; }
          catch { this.checkStopped(batch); row.state = 'pending'; }
        }
        const prompt = resolveStoryboardPrompt(row.prompt, row.images, batch.referenceNames);
        if (row.nodeId) {
          row.message = '核对原节点，继续未完成的准备'; this.store.save(batch);
          const original = await this.browser.command<{ missing: boolean; referenceKeys: string[] }>(batch, 'resumeDraft', this.expected(batch, row));
          if (original.missing) row.nodeId = undefined;
          row.referenceKeys = original.referenceKeys;
          this.store.save(batch);
        }
        if (!row.nodeId) {
          row.state = 'creating'; row.message = '创建视频节点'; this.store.save(batch);
          const created = await this.browser.command<{ nodeId: string }>(batch, 'create', { canvasId: batch.canvasId, rowId: row.id, number: row.number, index, ratio: batch.ratio });
          row.nodeId = created.nodeId;
          this.store.save(batch);
          const original = await this.browser.command<{ referenceKeys: string[] }>(batch, 'resumeDraft', this.expected(batch, row));
          row.referenceKeys = original.referenceKeys;
        }
        row.state = 'filling'; row.message = '填写模型、比例、时长、分辨率和提示词'; this.store.save(batch);
        await this.browser.command(batch, 'fill', this.expected(batch, row));
        for (let imageIndex = row.referenceKeys?.length || 0; imageIndex < row.images.length; imageIndex += 1) {
          this.checkStopped(batch);
          const imagePath = row.images[imageIndex];
          const image = fs.readFileSync(imagePath);
          row.state = 'filling'; row.message = `上传参考图 ${imageIndex + 1}/${row.images.length}`; this.store.save(batch);
          const uploaded = await this.browser.command<{ referenceKeys: string[] }>(batch, 'upload', {
            canvasId: batch.canvasId, nodeId: row.nodeId, prompt,
            base64: image.toString('base64'), name: `${storyboardImageLabel(imageIndex)}${path.extname(imagePath)}`, mime: mimeFor(imagePath),
            imageIndex, expectedKeys: row.referenceKeys || [],
          });
          row.referenceKeys = uploaded.referenceKeys;
          this.store.save(batch);
        }
        await this.browser.command(batch, 'verify', this.expected(batch, row));
        row.state = 'ready'; row.message = '草稿已回读确认'; this.store.save(batch);
      } catch (error: unknown) {
        row.state = 'review'; row.message = error instanceof Error ? error.message : String(error); batch.phase = 'paused'; batch.message = `分镜${row.number}停止，请核对豆包画布后继续`; this.store.save(batch); throw error;
      }
    }
    const readyCount = batch.rows.filter(row => row.state === 'ready').length;
    const reviewCount = batch.rows.filter(row => row.state === 'review').length;
    batch.phase = reviewCount ? 'paused' : 'ready';
    batch.message = reviewCount ? `已准备 ${readyCount} 个节点，另有 ${reviewCount} 条待核对；可单独发送已就绪节点` : `已准备 ${readyCount} 个待发送节点；已发送节点保持原任务，不会重发`;
    this.store.save(batch);
  }

  private expected(batch: StoryboardBatch, row: StoryboardRow): Record<string, unknown> {
    return { canvasId: batch.canvasId, nodeId: row.nodeId, prompt: resolveStoryboardPrompt(row.prompt, row.images, batch.referenceNames), model: batch.model, ratio: batch.ratio, resolution: batch.resolution, duration: row.duration, imageCount: row.images.length, expectedKeys: row.referenceKeys || [] };
  }

  async start(id: string): Promise<void> {
    await this.execute(id, (batch) => this.startInternal(batch), true);
  }

  private async startInternal(batch: StoryboardBatch): Promise<void> {
    // 待发送草稿必须全准备好；已有发送意图的待核对节点单独保留，不阻塞其余分镜。
    if (!batch.canvasId || batch.rows.some((row) => !['ready', 'generating', 'saving', 'done', 'failed'].includes(row.state) && !(row.state === 'review' && row.submissionIntentAt))) throw new Error('待发送分镜尚未全部就绪，请先恢复准备');
    await this.browser.ensureCanvas(batch);
    const ready = batch.rows.filter((row) => row.state === 'ready' && row.nodeId);
    if (!ready.length || batch.rows.some(row => row.state === 'pending')) throw new Error('画布重新打开后需要恢复草稿，请先点击“恢复准备全部节点”');
    batch.phase = 'ready'; batch.message = '正在复核整批节点，尚未发送'; this.store.save(batch);
    for (const row of ready) {
      this.checkStopped(batch);
      if (row.submissionIntentAt || row.submittedAt) throw new Error(`分镜${row.number}存在发送记录，已阻止重复发送`);
      if (!getTaskForLalor(row.taskId)) throw new Error(`分镜${row.number}任务记录不存在`);
      try { await this.browser.command(batch, 'verify', this.expected(batch, row)); }
      catch (error: unknown) {
        row.state = 'review'; row.message = error instanceof Error ? error.message : String(error);
        this.store.save(batch); throw error;
      }
    }
    this.checkStopped(batch);
    batch.phase = 'running'; batch.message = `正在连续发送 ${ready.length} 个节点，不等待上一条生成完成`; this.store.save(batch);
    await requireLalorGenerationAccess();
    const attempted: StoryboardRow[] = [];
    let sendError: unknown;
    const started = Date.now();
    try {
      for (const row of ready) {
        this.checkStopped(batch);
        if (!getTaskForLalor(row.taskId)) throw new Error(`分镜${row.number}任务记录已删除，已停止发送`);
        // 每次点击之前持久化意图；点击后立即下一条，受理回执最后统一核对。
        row.state = 'submitting'; row.submissionIntentAt = new Date().toISOString(); row.submissionError = undefined; row.message = '已进入发送流程，等待豆包受理';
        attempted.push(row); this.store.save(batch);
        let result: StoryboardSubmitResult;
        try { result = await this.browser.command<StoryboardSubmitResult>(batch, 'submit', this.expected(batch, row)); }
        catch (error: unknown) {
          if (error instanceof StoryboardCommandNotStartedError) result = { clicked: false, message: error.message };
          else { row.submissionError = error instanceof Error ? error.message : String(error); throw error; }
        }
        if (result?.clicked === false) {
          // 页面明确证明尚未点击，撤销本次意图；超时/断线等不确定异常绝不能走这里。
          row.state = 'pending'; row.submissionIntentAt = undefined;
          row.message = `未点击发送：${result.message}。请恢复准备后再发送`;
          attempted.pop(); this.store.save(batch);
          throw new Error(row.message);
        }
        if (result?.clicked !== true) throw new Error('发送返回结果无效，请查询原节点，未自动重发');
        row.message = '已点击发送，等待豆包受理回执';
        batch.message = `已点击 ${attempted.length}/${ready.length} 个节点 · 用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`;
        this.store.save(batch);
      }
    } catch (error: unknown) { sendError = error; }
    try {
      if (attempted.length) {
        const receipts = await this.browser.command<{ nodeId: string; accepted: boolean; message: string }[]>(batch, 'receipts', { canvasId: batch.canvasId, nodeIds: attempted.map(row => row.nodeId) }, false);
        for (const row of attempted) {
          const receipt = receipts.find(item => item.nodeId === row.nodeId);
          if (receipt?.accepted) {
            row.submittedAt = new Date().toISOString(); row.state = 'generating'; row.message = '豆包已受理，等待生成';
            this.store.save(batch);
            this.updateTask(row, 'generating', '豆包已受理，等待视频产物');
          } else { row.state = 'review'; row.message = row.submissionError || receipt?.message || '提交回执未确认，请查询原节点'; }
        }
      }
    } catch (error: unknown) { sendError ||= error; }
    finally {
      for (const row of attempted.filter(item => item.state === 'submitting')) { row.state = 'review'; row.message = row.submissionError || '发送过程中页面已中断，请找回原节点进度，不会自动重发'; }
      this.store.save(batch);
    }
    if (sendError) throw sendError;
    if (attempted.some(row => row.state === 'review')) throw new Error('部分节点受理结果待确认，请找回进度；未自动重发');
    await this.monitor(batch);
  }

  private async monitor(batch: StoryboardBatch): Promise<void> {
    await this.browser.command(batch, 'overview', { canvasId: batch.canvasId, nodeIds: batch.rows.map((row) => row.nodeId).filter(Boolean) }, false);
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline && !this.stopping.has(batch.id)) {
      const pending = batch.rows.filter((row) => ['generating', 'saving'].includes(row.state));
      if (!pending.length) break;
      batch.message = `全部已发送节点正在豆包生成 · 已保存 ${batch.rows.filter((row) => row.state === 'done').length}/${batch.rows.length}`;
      this.store.save(batch);
      // 每轮检查所有节点；查询并发度不限制生成条数，也不等待前几个生成完。
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < pending.length && !this.stopping.has(batch.id)) {
          const row = pending[cursor++];
          try { await this.pollRow(batch, row); }
          catch (error: unknown) { row.state = row.outputUrl ? 'failed' : 'review'; row.message = error instanceof Error ? error.message : String(error); this.store.save(batch); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(batch.concurrency, pending.length) }, () => worker()));
      if (batch.rows.some((row) => ['generating', 'saving'].includes(row.state))) await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    this.checkStopped(batch);
    const pending = batch.rows.filter((row) => ['generating', 'saving'].includes(row.state));
    for (const row of pending) { row.state = 'review'; row.message = '本轮查询超过 1 小时，请找回进度继续查询；未自动重发'; }
    const saved = batch.rows.filter((row) => row.state === 'done').length;
    batch.phase = batch.rows.every((row) => ['done', 'failed'].includes(row.state)) ? 'done' : 'paused';
    batch.message = saved === batch.rows.length ? '全部视频已保存到产物中心和设置目录' : `已保存 ${saved}/${batch.rows.length} 条，其余请查看分镜状态`;
    this.store.save(batch);
  }

  private async pollRow(batch: StoryboardBatch, row: StoryboardRow): Promise<void> {
    const result: NodeObservation = row.outputUrl ? { state: 'done', url: row.outputUrl, progress: 100 } : await this.browser.command<NodeObservation>(batch, 'observe', { canvasId: batch.canvasId, nodeId: row.nodeId, attemptId: row.regeneration?.attemptId }, false);
    this.applyProgress(row, result);
    if (result.state === 'done' && result.url) {
      row.outputUrl = result.url; row.state = 'saving'; row.message = '视频已生成，正在保存到产物中心'; this.store.save(batch);
      await this.saveOutput(batch, row); return;
    }
    const retry = row.regeneration;
    if (retry && !retry.settled) {
      const receipt = result.retryReceipt?.attemptId === retry.attemptId ? result.retryReceipt : undefined;
      if (receipt?.status === 'blocked') {
        row.state = 'review'; row.message = receipt.message || '重新生成未受理，请核对原节点'; this.store.save(batch); return;
      }
      if (receipt?.status === 'settled') retry.settled = true;
      else {
        row.state = receipt?.status === 'waiting' || result.state === 'generating' ? 'generating' : 'review';
        row.message = result.state === 'generating' ? '原节点正在生成，继续查询；未再次点击' : receipt?.status === 'waiting' ? `重新生成 ${retry.attempts}/${MAX_REGENERATION_CLICKS}，等待本次受理回执` : '重新生成结果不明，请核对原节点；未继续点击';
        this.store.save(batch); return;
      }
    }
    if (result.state === 'failed') {
      row.progress = undefined; row.progressUpdatedAt = undefined;
      if (result.retryable !== false && row.submittedAt) {
        const turn = this.regenerationTurn.then(() => this.regenerateRow(batch, row));
        // 保留当前调用的错误，由 monitor 展示；只让队列继续处理其他节点。
        this.regenerationTurn = turn.catch((): void => {});
        await turn; return;
      }
      row.state = 'failed'; row.message = result.message || '豆包生成失败'; this.updateTask(row, 'fail', row.message);
    }
    else if (result.state === 'missing') { row.state = 'review'; row.message = '原视频节点已不存在，未自动重建或重发'; }
    else row.message = typeof result.progress === 'number' ? `豆包生成进度 ${result.progress}%` : '豆包生成中，持续查询原节点';
    this.store.save(batch);
  }

  private async regenerateRow(batch: StoryboardBatch, row: StoryboardRow): Promise<void> {
    this.checkStopped(batch);
    const previous = row.regeneration;
    const attempts = previous?.attempts || 0;
    if (attempts >= MAX_REGENERATION_CLICKS) {
      row.state = 'failed'; row.message = `此节点已自动点击重新生成 ${MAX_REGENERATION_CLICKS} 次仍失败，已停止自动重试`;
      this.updateTask(row, 'fail', row.message); this.store.save(batch); return;
    }
    if (previous?.clickedAt && Date.now() - Date.parse(previous.clickedAt) < REGENERATION_INTERVAL_MS) {
      row.state = 'generating'; row.message = `重新生成 ${attempts}/${MAX_REGENERATION_CLICKS} 后仍显示失败，等待下一次状态核对`; this.store.save(batch); return;
    }
    // 排队期间节点可能已出片或开始生成，必须重新回读，不能使用并发查询时的旧失败状态。
    const current = await this.browser.command<NodeObservation>(batch, 'observe', { canvasId: batch.canvasId, nodeId: row.nodeId }, false);
    if (current.state !== 'failed') {
      row.state = current.state === 'missing' ? 'review' : 'generating';
      row.message = current.state === 'missing' ? '原视频节点已不存在，未点击重新生成' : '节点状态已变化，继续查询原任务'; this.store.save(batch); return;
    }
    if (current.retryable === false) {
      row.state = 'failed'; row.message = current.message || '当前失败需要人工处理'; this.updateTask(row, 'fail', row.message); this.store.save(batch); return;
    }
    await requireLalorGenerationAccess();
    this.checkStopped(batch);
    if (!getTaskForLalor(row.taskId)) throw new Error('分镜任务记录已删除，未点击重新生成');
    // 点击前持久化次数和意图。中断时保留该次占位，避免重启后突破五次上限。
    row.regeneration = { attempts: attempts + 1, attemptId: randomUUID(), intentAt: new Date().toISOString() };
    row.state = 'generating'; row.message = `视频生成失败，正在重新生成 ${attempts + 1}/${MAX_REGENERATION_CLICKS}`;
    this.store.save(batch);
    let result: StoryboardSubmitResult;
    try { result = await this.browser.command<StoryboardSubmitResult>(batch, 'regenerate', { canvasId: batch.canvasId, nodeId: row.nodeId, attemptId: row.regeneration.attemptId }); }
    catch (error: unknown) {
      if (error instanceof StoryboardCommandNotStartedError) result = { clicked: false, message: error.message };
      else throw error;
    }
    if (result?.clicked === false) {
      row.regeneration = previous; row.state = 'review'; row.message = `未点击重新生成：${result.message}`; this.store.save(batch); return;
    }
    if (result?.clicked !== true) throw new Error('重新生成返回结果不明，请核对原节点；未继续点击');
    row.regeneration.clickedAt = new Date().toISOString();
    row.message = `已点击重新生成 ${attempts + 1}/${MAX_REGENERATION_CLICKS}，等待豆包受理`;
    this.store.save(batch); this.updateTask(row, 'generating', row.message);
  }

  private applyProgress(row: StoryboardRow, observation: NodeObservation): void {
    const value = observation.progress;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) {
      row.progress = Math.round(value); row.progressUpdatedAt = new Date().toISOString();
    }
  }

  private async saveOutput(batch: StoryboardBatch, row: StoryboardRow): Promise<void> {
    if (!row.outputUrl) throw new Error('没有可保存的视频地址');
    const task = getTaskForLalor(row.taskId);
    if (!task) throw new Error('批次任务记录不存在，已停止归档');
    this.updateTask(row, 'done', '视频已生成，正在保存到本地', [row.outputUrl]);
    const download = await downloadTaskOutputs({ outputs: [{ taskId: task.id, prompt: task.prompt, outputs: [row.outputUrl], accountId: task.assignedAccountId, mode: 'video' }] });
    row.state = download.success && download.count ? 'done' : 'failed';
    row.message = row.state === 'done' ? '已保存到产物中心和设置的保存目录' : (download.error || '视频已生成但保存失败，可重试保存');
    this.store.save(batch);
  }

  async pause(id: string): Promise<void> {
    const batch = this.store.get(id); if (!this.running.has(id)) return;
    this.stopping.add(id);
    batch.phase = 'paused'; batch.message = '正在暂停后续操作，已提交任务继续生成，正在保存的文件会完成保存'; this.store.save(batch); this.browser.stop(batch);
  }
  async recover(id: string): Promise<void> {
    await this.execute(id, async (batch): Promise<void> => {
      if (!batch.canvasId) throw new Error('没有保存的画布编号，请先准备节点');
      await this.browser.ensureCanvas(batch);
      for (const row of batch.rows.filter((item) => item.nodeId && item.state !== 'done' && !(item.state === 'failed' && item.outputUrl))) {
        this.checkStopped(batch);
        if (row.outputUrl) { row.state = 'saving'; continue; }
        const result = await this.browser.command<NodeObservation>(batch, 'observe', { canvasId: batch.canvasId, nodeId: row.nodeId }, false);
        this.applyProgress(row, result);
        if (result.state === 'done' && result.url) { row.outputUrl = result.url; row.state = 'saving'; row.message = '已找回视频，准备保存'; }
        else if (result.state === 'failed') {
          if (row.submittedAt && result.retryable !== false && ((row.regeneration?.attempts || 0) < MAX_REGENERATION_CLICKS || (row.regeneration && !row.regeneration.settled))) {
            row.state = 'generating'; row.message = '已找回失败节点，将核对重新生成按钮和剩余次数';
          } else { row.state = 'failed'; row.message = (row.regeneration?.attempts || 0) >= MAX_REGENERATION_CLICKS ? '此节点已达到自动重新生成 5 次上限' : result.message || '豆包显示失败'; this.updateTask(row, 'fail', row.message); }
        }
        else if (result.state === 'missing') { row.state = 'review'; row.message = '原节点已不存在，未自动重建'; }
        else if (result.state === 'generating' || row.submittedAt) { row.state = 'generating'; row.message = '已找回原任务，继续查询'; this.updateTask(row, 'generating', row.message); }
        else if (row.submissionIntentAt) { row.state = 'review'; row.message = `${row.submissionError ? row.submissionError + '；' : ''}发送结果未确认。请核对原节点；确认没有提交后可恢复草稿`; }
        else {
          try { await this.browser.command(batch, 'verify', this.expected(batch, row)); row.state = 'ready'; row.message = '原草稿已回读确认'; }
          catch (error: unknown) { row.state = 'review'; row.message = error instanceof Error ? error.message : String(error); }
        }
        this.store.save(batch);
      }
      if (batch.rows.some((row) => ['generating', 'saving'].includes(row.state))) { batch.phase = 'running'; this.store.save(batch); await this.monitor(batch); }
      else { batch.phase = batch.rows.every((row) => row.state === 'ready') ? 'ready' : 'paused'; batch.message = '已核对原节点，未自动发送；请查看每条分镜状态'; this.store.save(batch); }
    }, false);
  }
  async restoreUnsent(id: string, rowId: string, confirmedNotSent: boolean): Promise<void> {
    if (confirmedNotSent !== true) throw new Error('请先在豆包原画布和任务记录中确认此分镜没有提交');
    await this.execute(id, async (batch): Promise<void> => {
      const row = batch.rows.find(item => item.id === rowId);
      if (!row || row.state !== 'review' || !row.submissionIntentAt || row.submittedAt || row.outputUrl) throw new Error('只有未确认受理的待核对分镜可以恢复；已受理任务只能查询');
      await this.browser.ensureCanvas(batch);
      this.checkStopped(batch);
      const result = await this.browser.command<{ draft: boolean }>(batch, 'confirmUnsentDraft', { canvasId: batch.canvasId, nodeId: row.nodeId });
      if (result?.draft !== true) throw new Error('未确认原节点为草稿，保留发送记录');
      row.submissionRecovery = { previousIntentAt: row.submissionIntentAt, confirmedNotSentAt: new Date().toISOString() };
      row.submissionIntentAt = undefined; row.submissionError = undefined; row.state = 'pending';
      row.message = '已人工确认未提交，请恢复准备；未自动发送';
      batch.phase = 'paused'; batch.message = `分镜${row.number}已恢复待准备，其他分镜记录保持不变`;
      this.store.save(batch);
    }, false);
  }
  async retryDownload(id: string, rowId: string): Promise<void> {
    await this.execute(id, async (batch): Promise<void> => {
      const row = batch.rows.find((item) => item.id === rowId); if (!row || row.state !== 'failed' || !row.outputUrl) throw new Error('该分镜没有可重试保存的视频');
      row.state = 'saving'; row.message = '正在重试保存'; this.store.save(batch);
      await this.saveOutput(batch, row);
      if (batch.rows.every((item) => item.state === 'done')) { batch.phase = 'done'; batch.message = '全部视频已保存到产物中心和设置目录'; this.store.save(batch); }
    }, false);
  }
  dispose(): void { for (const id of this.running.keys()) this.stopping.add(id); this.browser.dispose(); }
}

export const storyboardBatchService = new StoryboardBatchService();
