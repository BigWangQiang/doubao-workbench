/**
 * src/types/index.ts
 * 全局类型定义（渲染进程侧）
 *
 * 领域模型接口已迁移至 @doubao-studio/contracts。
 * 本文件作为渲染进程兼容桥，通过 import type + export type 重导出共享类型，
 * 同时保留渲染端专属的 UI 常量和辅助类型。
 */

import type {
  GenerationMode,
  AccountStatus,
  AccountPlatform,
  TaskStatus,
  TaskStage,
  TaskErrorCode,
  VideoModel,
  VideoDuration,
  VideoAspectRatio,
  DependencyPolicy,
  SeedanceQuota,
  AccountAvailabilityState,
  AccountAvailabilitySource,
  AccountAvailability,
  AccountHealth,
  AccountScheduling,
  AccountProxyProtocol,
  AccountProxyConfig,
  Account,
  TaskErrorInfo,
  TaskRunSnapshot,
  TaskRunRecord,
  TaskLock,
  TaskArtifact,
  DownloadJob,
  Task,
  Project,
  LogEntry,
  // IPC DTO（从 contracts re-export，保持渲染进程旧导入路径可用）
  TaskUpdateInput,
  CsvImportResult,
  AdapterSelfCheckItem,
  AdapterSelfCheckReport,
  AdapterRuleBundle,
} from '@doubao-studio/contracts';

// 兼容性 re-export：保持渲染进程旧导入路径可用
export type {
  GenerationMode,
  AccountStatus,
  AccountPlatform,
  TaskStatus,
  TaskStage,
  TaskErrorCode,
  VideoModel,
  VideoDuration,
  VideoAspectRatio,
  DependencyPolicy,
  SeedanceQuota,
  AccountAvailabilityState,
  AccountAvailabilitySource,
  AccountAvailability,
  AccountHealth,
  AccountScheduling,
  AccountProxyProtocol,
  AccountProxyConfig,
  Account,
  TaskErrorInfo,
  TaskRunSnapshot,
  TaskRunRecord,
  TaskLock,
  TaskArtifact,
  DownloadJob,
  Task,
  Project,
  LogEntry,
  TaskUpdateInput,
  CsvImportResult,
  AdapterSelfCheckItem,
  AdapterSelfCheckReport,
  AdapterRuleBundle,
};

// ==================== 渲染端专属类型 ====================

// ==================== 渲染端专属常量 ====================

/** 视频配置默认值 */
export const DEFAULT_VIDEO_CONFIG = {
  // 当前普通账号页面默认可用项；标准版会触发会员升级弹层，不能作为无探测默认值。
  model: 'seedance-2.0-mini' as VideoModel,
  duration: '10s' as VideoDuration,
  aspectRatio: '16:9' as VideoAspectRatio,
};

/**
 * Dola 当前创作栏可见的视频模型白名单。
 *
 * Dola 的模型菜单与豆包不同，当前页面实际提供 Seedance 2.5 和
 * Seedance 2.0 Fast；Seedance 2.0 Mini 不能作为 Dola 的隐式回退。
 * 这个列表只用于渲染端的选择与校验，最终提交仍需以页面回读为准。
 */
export const DOLA_VIDEO_MODELS: readonly VideoModel[] = [
  'seedance-2.5',
  'seedance-2.0-fast',
];

/** 豆包端允许在任务表单中选择的完整模型集合。 */
export const VIDEO_MODELS: readonly VideoModel[] = [
  'seedance-2.5',
  'seedance-2.0',
  'seedance-2.0-fast',
  'seedance-2.0-mini',
];

/** Dola 表单默认使用当前页面可见的 2.5 模型；豆包继续保留 Mini 默认值。 */
export const DEFAULT_DOLA_VIDEO_CONFIG = {
  ...DEFAULT_VIDEO_CONFIG,
  model: 'seedance-2.5' as VideoModel,
};

export function getDefaultVideoConfig(platform: AccountPlatform = 'doubao'): {
  model: VideoModel;
  duration: VideoDuration;
  aspectRatio: VideoAspectRatio;
} {
  return {
    ...(platform === 'dola' ? DEFAULT_DOLA_VIDEO_CONFIG : DEFAULT_VIDEO_CONFIG),
  };
}

/** 判断模型是否可用于指定平台；不做跨模型静默映射。 */
export function isVideoModelAvailableForPlatform(platform: AccountPlatform, model: VideoModel): boolean {
  return platform !== 'dola' || DOLA_VIDEO_MODELS.includes(model);
}

/** 返回指定平台可以在任务表单中主动选择的模型，不做隐式降级。 */
export function getVideoModelsForPlatform(platform: AccountPlatform = 'doubao'): readonly VideoModel[] {
  return platform === 'dola' ? DOLA_VIDEO_MODELS : VIDEO_MODELS;
}

/** 视频模型显示名映射 */
export const VIDEO_MODEL_LABELS: Record<VideoModel, string> = {
  'seedance-2.5': 'Seedance 2.5',
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
  'seedance-2.0-mini': 'Seedance 2.0 Mini',
};

/** 视频模型消耗说明 */
export const VIDEO_MODEL_COST: Record<VideoModel, string> = {
  'seedance-2.5': '按执行账号额度设置扣减',
  'seedance-2.0': '按执行账号额度设置扣减',
  'seedance-2.0-fast': '按执行账号额度设置扣减',
  'seedance-2.0-mini': '按执行账号额度设置扣减',
};

/** 生成模式配置 */
export const GENERATION_MODE_CONFIG: Record<GenerationMode, {
  label: string;
  icon: string;
  color: string;
  url: string;
  description: string;
}> = {
  chat: {
    label: '对话',
    icon: '💬',
    color: '#60a5fa',
    url: 'https://www.doubao.com/chat/',
    description: '智能对话、问答、写作',
  },
  image: {
    label: '图片',
    icon: '🎨',
    color: '#a78bfa',
    url: 'https://www.doubao.com/chat/create-image/',
    description: 'AI 绘画、文生图、图生图',
  },
  video: {
    label: '视频',
    icon: '🎬',
    color: '#f472b6',
    url: 'https://www.doubao.com/chat/create-video/',
    description: 'AI 视频、文生视频、图生视频',
  },
  music: {
    label: '音乐',
    icon: '🎵',
    color: '#34d399',
    url: 'https://www.doubao.com/chat/create-music/',
    description: 'AI 作曲、音乐生成',
  },
};

/** 任务状态标签配置 */
export const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; className: string }> = {
  queued: { label: '排队中', color: '#60a5fa', className: 'queued' },
  executing: { label: '注入中', color: '#a78bfa', className: 'executing' },
  generating: { label: '生成中', color: '#fbbf24', className: 'generating' },
  waiting_verification: { label: '等待验证', color: '#fb923c', className: 'waiting-verification' },
  waiting_generation_confirmation: { label: '等待生成确认', color: '#f97316', className: 'waiting-generation-confirmation' },
  manual_submission_observing: { label: '人工提交观察中', color: '#38bdf8', className: 'manual-submission-observing' },
  paused: { label: '已暂停', color: '#94a3b8', className: 'paused' },
  done: { label: '已完成', color: '#34d399', className: 'done' },
  fail: { label: '失败', color: '#fb7185', className: 'fail' },
  cancelled: { label: '已取消', color: '#94a3b8', className: 'cancelled' },
};

export const TASK_STAGE_LABELS: Record<TaskStage, string> = {
  queued: '等待执行',
  preparing_account: '准备账号',
  new_conversation: '创建新对话',
  switching_mode: '切换生成模式',
  configuring: '配置生成参数',
  uploading_assets: '上传参考素材',
  injecting_prompt: '填写提示词',
  submitting: '提交任务',
  waiting_verification: '等待人工验证',
  waiting_generation_confirmation: '等待视频生成确认',
  manual_submission_observing: '只读观察人工提交',
  generating: '豆包生成中',
  extracting_outputs: '识别任务产物',
  completed: '已完成',
  paused: '已暂停',
  failed: '执行失败',
  cancelled: '已取消',
};

/** 账号状态标签配置 */
export const ACCOUNT_STATUS_CONFIG: Record<AccountStatus, { label: string; color: string }> = {
  idle: { label: '空闲', color: '#4ade80' },
  busy: { label: '忙碌', color: '#fbbf24' },
  error: { label: '异常', color: '#f87171' },
};

/** 自动化阶段 → UI 展示 */
export const AUTO_STATE_DISPLAY: Record<string, { label: string; color: string; animated: boolean }> = {
  idle: { label: '空闲', color: '#4ade80', animated: false },
  injecting: { label: '注入中…', color: '#a78bfa', animated: true },
  submitting: { label: '提交中…', color: '#818cf8', animated: true },
  generating: { label: '生成中…', color: '#fbbf24', animated: true },
  completed: { label: '已完成', color: '#34d399', animated: false },
  failed: { label: '失败', color: '#f87171', animated: false },
};
