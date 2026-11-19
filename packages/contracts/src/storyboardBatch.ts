import type { VideoModel, VideoAspectRatio } from './enums';

export type StoryboardRowState = 'pending' | 'creating' | 'filling' | 'ready' | 'submitting' | 'generating' | 'saving' | 'done' | 'failed' | 'review';
export interface StoryboardInput {
  id: string;
  number: string;
  prompt: string;
  duration: number;
  images: string[];
}
export interface StoryboardRow extends StoryboardInput {
  taskId: string;
  nodeId?: string;
  /** 上传后从当前节点回读的有序附件标识，发送前必须完全一致。 */
  referenceKeys?: string[];
  state: StoryboardRowState;
  message?: string;
  submittedAt?: string;
  submissionIntentAt?: string;
  /** 保留发送中断的原始原因，恢复查询不能覆盖证据。 */
  submissionError?: string;
  submissionRecovery?: { previousIntentAt: string; confirmedNotSentAt: string };
  /** 同一节点自动点击最多 5 次；暂停、刷新和重启不能重置上限。 */
  regeneration?: {
    attempts: number;
    attemptId: string;
    intentAt: string;
    clickedAt?: string;
    settled?: boolean;
  };
  outputUrl?: string;
  filePath?: string;
  /** 豆包节点公开显示的真实百分比，不用本机计时推算。 */
  progress?: number;
  progressUpdatedAt?: string;
}
export interface StoryboardBatchInput {
  title: string;
  projectId: string;
  accountId: string;
  model: VideoModel;
  ratio: VideoAspectRatio;
  /** 仅支持已确认有分辨率控件的 Seedance 2.5；未指定时保留豆包默认值。 */
  resolution?: '720P' | '1080P';
  /** 只限制状态查询和下载工作者数量；全批节点连续发送，生成不按此值分组。 */
  concurrency: number;
  rows: StoryboardInput[];
  /** 本批次素材别名，键为本机路径，不重命名原文件。 */
  referenceNames: Record<string, string>;
}
export interface StoryboardBatch extends Omit<StoryboardBatchInput, 'rows'> {
  id: string;
  rows: StoryboardRow[];
  phase: 'draft' | 'preparing' | 'ready' | 'running' | 'paused' | 'done';
  canvasId?: string;
  canvasUrl?: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  busy?: boolean;
}
export interface StoryboardBatchAPI {
  list: () => Promise<StoryboardBatch[]>;
  create: (input: StoryboardBatchInput) => Promise<StoryboardBatch>;
  prepare: (id: string) => Promise<void>;
  start: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  recover: (id: string) => Promise<void>;
  restoreUnsent: (id: string, rowId: string, confirmedNotSent: boolean) => Promise<void>;
  open: (id: string) => Promise<void>;
  retryDownload: (id: string, rowId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
