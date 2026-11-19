import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { StoryboardBatch, StoryboardBatchInput } from '@doubao-studio/contracts';
import { getDataDir, writeJSON } from '../utils/store';

const FILE = 'storyboard-batches.json';

/** 损坏时拒绝写入，不能把旧批次当空列表覆盖。 */
export class StoryboardBatchStore {
  private batches: StoryboardBatch[] | undefined;
  list(): StoryboardBatch[] {
    if (!this.batches) {
      const file = path.join(getDataDir(), FILE);
      const data: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      if (!Array.isArray(data) || data.some((item) => !item?.id || !Array.isArray(item.rows))) throw new Error('分镜批次记录损坏，请恢复备份，未覆盖原文件');
      this.batches = data as StoryboardBatch[];
      for (const batch of this.batches) {
        for (const row of batch.rows) {
          if (row.state === 'ready' && !row.submissionIntentAt && !row.submittedAt) {
            row.state = 'pending'; row.message = '工作台已重启，待恢复豆包节点草稿';
          }
        }
        if (['preparing', 'running'].includes(batch.phase)) {
          batch.phase = 'paused';
          batch.message = '上次操作中断，请继续查询原节点；未自动重发';
          for (const row of batch.rows) {
            if (['creating', 'filling', 'submitting'].includes(row.state)) { row.state = 'review'; row.message = '操作中断，请检查原节点'; }
            if (row.state === 'saving') { row.state = 'generating'; row.message = '等待恢复下载'; }
          }
        }
        if (batch.rows.some(row => row.state === 'pending') && batch.canvasId) {
          batch.phase = 'paused'; batch.message = '请恢复准备：本机分镜已保留，豆包页面草稿需重新填写';
        }
      }
    }
    return this.batches;
  }
  get(id: string): StoryboardBatch {
    const batch = this.list().find((item) => item.id === id);
    if (!batch) throw new Error('分镜批次不存在');
    return batch;
  }
  save(batch: StoryboardBatch): void {
    const batches = this.list();
    batch.updatedAt = new Date().toISOString();
    const next = batches.some((item) => item.id === batch.id) ? batches.map((item) => item.id === batch.id ? batch : item) : [...batches, batch];
    if (!writeJSON(FILE, next)) throw new Error('分镜批次保存失败，已停止后续操作');
    this.batches = next;
  }
  remove(id: string): void {
    this.get(id);
    const next = this.list().filter((batch) => batch.id !== id);
    if (!writeJSON(FILE, next)) throw new Error('批次删除失败，原记录已保留');
    this.batches = next;
  }
}

export function validateStoryboardBatch(raw: StoryboardBatchInput): StoryboardBatchInput {
  if (!raw || typeof raw !== 'object') throw new Error('批次参数无效');
  if (typeof raw.accountId !== 'string' || !raw.accountId || typeof raw.projectId !== 'string' || !raw.projectId) throw new Error('请选择账号和项目');
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 100) throw new Error('批次名称需为 1–100 字');
  if (!['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'].includes(raw.model)) throw new Error('请选择支持的豆包视频模型');
  if (!['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(raw.ratio)) throw new Error('视频比例无效');
  if (raw.resolution !== undefined && (raw.model !== 'seedance-2.5' || !['720P', '1080P'].includes(raw.resolution))) throw new Error('所选模型或分辨率不受支持');
  if (!Number.isInteger(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > 10) throw new Error('并发查询数量须为 1–10');
  if (!Array.isArray(raw.rows) || !raw.rows.length || raw.rows.length > 100) throw new Error('每个批次需要 1–100 条分镜');
  if (!raw.referenceNames || typeof raw.referenceNames !== 'object' || Array.isArray(raw.referenceNames)) throw new Error('参考图名称配置无效');
  const referenceNames: Record<string, string> = {};
  const namedPaths = new Map<string, string>();
  const numbers = new Set<string>();
  const rows = raw.rows.map((row) => {
    if (!row || typeof row.number !== 'string' || !/^\d{1,6}$/.test(row.number)) throw new Error('分镜编号须为 1–6 位数字');
    const number = String(Number(row.number)).padStart(3, '0');
    if (numbers.has(number)) throw new Error(`分镜${number}重复`);
    numbers.add(number);
    if (typeof row.prompt !== 'string' || !row.prompt.trim() || row.prompt.length > 30000) throw new Error(`分镜${number}提示词为空或过长`);
    if (!Number.isInteger(row.duration) || row.duration < 4 || row.duration > (raw.model === 'seedance-2.5' ? 30 : 15)) throw new Error(`分镜${number}时长不适用于所选模型`);
    if (!Array.isArray(row.images) || row.images.length > 9 || new Set(row.images).size !== row.images.length) throw new Error(`分镜${number}参考图最多 9 张且不能重复`);
    for (const image of row.images) {
      if (typeof image !== 'string' || !path.isAbsolute(image) || !/\.(png|jpe?g|webp)$/i.test(image)) throw new Error('参考图仅支持本机 PNG/JPG/WebP');
      const stat = fs.statSync(image);
      if (!stat.isFile() || stat.size === 0 || stat.size > 30 * 1024 * 1024) throw new Error(`分镜${number}参考图无效或超过 30MB`);
      const name = raw.referenceNames[image] || path.parse(image).name;
      if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]{1,60}$/u.test(name) || /^图\d/.test(name)) throw new Error(`分镜${number}的图片名称无效，请用中文、字母、数字、下划线或短横线命名，且不要以“图+数字”开头`);
      if (namedPaths.has(name) && namedPaths.get(name) !== image) throw new Error(`参考图“${name}”重名，请先修改名称`);
      namedPaths.set(name, image); referenceNames[image] = name;
    }
    const names = row.images.map((image) => referenceNames[image]);
    for (const token of row.prompt.matchAll(/@([^\s@，,。；;、：:！？!?（）()]+)/g)) {
      const name = token[1].replace(/^图\d+/, '');
      if (names.filter((item) => item === name).length !== 1) throw new Error(`分镜${number}的 @${name} 没有唯一匹配的参考图`);
    }
    return { id: randomUUID(), number, prompt: row.prompt.trim(), duration: row.duration, images: [...row.images] };
  });
  return { title: raw.title.trim(), projectId: raw.projectId, accountId: raw.accountId, model: raw.model, ratio: raw.ratio, resolution: raw.resolution, concurrency: raw.concurrency, rows, referenceNames };
}

export function resolveStoryboardPrompt(prompt: string, images: string[], referenceNames: Record<string, string>): string {
  const names = images.map((image) => referenceNames[image] || path.parse(image).name);
  return prompt.replace(/@([^\s@，,。；;、：:！？!?（）()]+)/g, (token, raw: string) => {
    const name = raw.replace(/^图\d+/, '');
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`参考图 ${name} 未绑定到当前分镜，已停止准备`);
    return `${name}：${storyboardImageLabel(index)}`;
  });
}

export function storyboardImageLabel(index: number): string {
  const ordinal = ['一', '二', '三', '四', '五', '六', '七', '八', '九'][index];
  if (!ordinal) throw new Error('参考图编号超出范围');
  return `图片${ordinal}`;
}
