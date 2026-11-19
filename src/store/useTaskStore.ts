/**
 * src/store/useTaskStore.ts
 * 任务调度状态（Zustand） — V3 多账号并行 + 队列调度
 *
 * 改进：
 * - per-account 执行状态，不再全局单任务
 * - 账号忙时自动排队，空闲自动接下一个
 * - 不同账号的任务可以并行执行
 */

import { create } from 'zustand';
import type {
  Task,
  TaskStatus,
  GenerationMode,
  TaskUpdateInput,
  TaskErrorInfo,
  TaskRunSnapshot,
  TaskStage,
  TaskArtifact,
  AccountPlatform,
} from '../types';
import { getAssignedAccountBlockReason } from '../utils/queueAccountDecision';
import { evaluateDependencies } from '../utils/dependencyEval';
import { useAccountStore } from './useAccountStore';
import { useLalorAuthStore } from './useLalorAuthStore';
import { automationEngine } from '../automation/AutomationEngine';
import { useProjectStore } from './useProjectStore';
import { inferArtifactKind } from '../utils/artifactKind';
import {
  BoundedTimeoutError,
  WATCHDOG_POLICY,
  withTimeout,
} from '../utils/taskWatchdog';
import { decideStartupRecovery } from '../utils/postSubmitVerification';

// ==================== 类型 ====================

/** 自动化执行状态 */
export type AutomationState = 'idle' | 'injecting' | 'submitting' | 'generating' | 'completed' | 'failed';

/**
 * 视频已经在平台侧生成，但本地下载/登记没有完成。
 * 这是提交后的可恢复归档错误，不应被当成“可以重新发送”的普通失败。
 */
class ArtifactArchiveError extends Error {
  readonly code = 'artifact_download_failed';

  constructor(message: string) {
    super(message);
    this.name = 'ArtifactArchiveError';
  }
}

interface TaskState {
  /** 所有任务列表 */
  tasks: Task[];
  loading: boolean;
  error: string | null;
  schedulerPaused: boolean;

  // ---- V3: 多账号并行执行 ----
  /** 每个账号正在执行的任务 ID */
  executingTasks: Record<string, string>;
  /** 每个账号是否正在忙碌 */
  accountBusy: Record<string, boolean>;
  /** 每个账号的自动化阶段（用于 UI 显示） */
  accountAutomationState: Record<string, AutomationState>;
  /** 每个账号的自动化消息 */
  accountAutoMessage: Record<string, string>;

  // 向后兼容（活跃账号的 automation 状态）
  activeTaskId: string | null;
  automationState: AutomationState;

  // ---- Actions ----
  loadTasks: (recoverInterrupted?: boolean) => Promise<void>;
  addTasks: (
    text: string,
    mode?: GenerationMode,
    videoConfig?: Task['videoConfig'],
    attachments?: string[],
    audioAttachment?: string,
    targetPlatform?: AccountPlatform,
    referenceVideos?: string[],
    audioAttachments?: string[],
  ) => Promise<Task[] | null>;
  importCsv: (filePath?: string) => Promise<{ tasks: Task[]; imported: number; skipped: number; errors: string[] } | null>;
  assignTask: (taskId: string, accountId: string) => Promise<boolean>;
  updateTaskStatus: (taskId: string, status: TaskStatus, result?: string, outputs?: string[]) => Promise<boolean>;
  registerArtifact: (taskId: string, url: string, options?: {
    source?: TaskArtifact['source'];
    conversationUrl?: string;
    runId?: string;
    kind?: TaskArtifact['kind'];
    contentType?: string;
    contentLength?: number;
    statusCode?: number;
  }) => Promise<boolean>;
  updateTask: (taskId: string, updates: TaskUpdateInput) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<boolean>;
  retryTask: (taskId: string) => Promise<boolean>;
  retryAfterQuotaExhaustion: (taskId: string, expectedRunId: string, replacementAccountId?: string | null) => Promise<boolean>;
  retryAfterPreSubmitFailure: (taskId: string, expectedRunId: string, replacementAccountId: string) => Promise<boolean>;
  batchPause: () => Promise<boolean>;
  resumeAll: () => Promise<boolean>;
  getCompletedOutputs: () => Promise<Array<{ taskId: string; prompt: string; outputs: string[]; accountId: string | null; mode: GenerationMode }>>;
  clearError: () => void;

  // V3 自动化方法
  startAutomation: (taskId: string) => Promise<boolean>;
  setAccountAutomationState: (accountId: string, state: AutomationState, message?: string, stage?: TaskStage) => void;
  updateTaskRuntime: (taskId: string, patch: {
    status?: TaskStatus;
    runtime?: Partial<TaskRunSnapshot>;
    errorInfo?: TaskErrorInfo | null;
    result?: string;
  }) => Promise<boolean>;
  completeAutomation: (taskId: string, accountId: string, resultUrl: string, outputs?: string[]) => Promise<void>;
  pauseAutomation: (
    taskId: string,
    accountId: string,
    message?: string,
    options?: {
      status: 'paused' | 'cancelled' | 'waiting_verification' | 'waiting_generation_confirmation';
      code?: string;
      generationConfirmation?: NonNullable<TaskRunSnapshot['generationConfirmation']>;
    },
  ) => Promise<void>;
  failAutomation: (taskId: string, accountId: string, errorMsg: string, errorInfo?: TaskErrorInfo) => Promise<void>;

  /** 处理队列：检查待执行任务，分配到空闲账号 */
  processQueue: () => void;
  /** 获取指定账号的下一个排队任务 */
  getNextTaskForAccount: (accountId: string) => Task | null;
}

const runtimePersistState = new Map<string, { stage?: TaskStage; savedAt: number }>();
let queueProcessing = false;

function artifactId(url: string): string {
  let hash = 5381;
  for (let index = 0; index < url.length; index++) hash = ((hash << 5) + hash) ^ url.charCodeAt(index);
  return `artifact-${(hash >>> 0).toString(16)}`;
}

function mergeArtifacts(task: Task, outputs: string[], source: TaskArtifact['source'] = 'network'): TaskArtifact[] {
  const artifacts = new Map((task.artifacts || []).map((artifact) => [artifact.url, artifact]));
  for (const url of outputs.filter(Boolean)) {
    const current = artifacts.get(url);
    if (current) {
      current.kind = inferArtifactKind(url, current.kind, current.validation?.contentType, task.mode);
      continue;
    }
    artifacts.set(url, {
      id: artifactId(url),
      url,
      kind: inferArtifactKind(url, task.mode === 'video' ? 'video' : task.mode === 'image' ? 'image' : 'file', undefined, task.mode),
      source,
      runId: task.runtime?.runId,
      conversationUrl: task.runtime?.conversationUrl,
      discoveredAt: new Date().toISOString(),
    });
  }
  return [...artifacts.values()];
}

// evaluateDependencies 已抽取到 src/utils/dependencyEval.ts

// ==================== Store ====================

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  schedulerPaused: false,
  executingTasks: {},
  accountBusy: {},
  accountAutomationState: {},
  accountAutoMessage: {},
  activeTaskId: null,
  automationState: 'idle',

  // ---- 基础操作 ----

  loadTasks: async (recoverInterrupted = false) => {
    set({ loading: true, error: null });
    try {
      let tasks = await window.electronAPI.tasks.list();
      if (recoverInterrupted) {
        const activeTasks = tasks.filter((task) => !task.canvasBatch && decideStartupRecovery({
          status: task.status,
          mode: task.mode,
          submittedAt: task.runtime?.submittedAt,
          conversationUrl: task.runtime?.conversationUrl,
        }) !== 'none');
        for (const task of activeTasks) {
          const recovery = decideStartupRecovery({
            status: task.status,
            mode: task.mode,
            submittedAt: task.runtime?.submittedAt,
            conversationUrl: task.runtime?.conversationUrl,
          });
          const now = new Date().toISOString();
          if (recovery === 'reconcile_submitted_video') {
            const recoveryMessage = '应用界面重新载入；Dola 已接收的视频正在原会话只读续查，系统不会重新发送';
            await window.electronAPI.tasks.updateRuntime(task.id, {
              status: 'waiting_verification',
              result: recoveryMessage,
              errorInfo: { code: 'startup_reconcile_required', message: recoveryMessage, recoverable: true, detectedAt: now },
              runtime: task.runtime ? {
                stage: 'waiting_verification',
                message: recoveryMessage,
                stageStartedAt: now,
                lastHeartbeatAt: now,
              } : undefined,
            });
          } else if (recovery === 'pause_interrupted') {
            await window.electronAPI.tasks.updateRuntime(task.id, {
              status: 'paused',
              result: '应用界面重新载入，任务已安全暂停',
              errorInfo: { code: 'cancelled', message: '应用界面重新载入，任务已安全暂停', recoverable: true, detectedAt: now },
              runtime: task.runtime ? { stage: 'paused', message: '应用界面重新载入，任务已安全暂停', stageStartedAt: now, lastHeartbeatAt: now } : undefined,
            });
          }
          if (task.lock?.ownerId) {
            await window.electronAPI.tasks.releaseLock(task.id, task.lock.ownerId);
          }
        }
        if (activeTasks.length > 0) tasks = await window.electronAPI.tasks.list();
      }
      set({ tasks, loading: false, executingTasks: {}, accountBusy: {} });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  addTasks: async (
    text: string,
    mode?: GenerationMode,
    videoConfig?: Task['videoConfig'],
    attachments?: string[],
    audioAttachment?: string,
    targetPlatform: AccountPlatform = 'doubao',
    referenceVideos?: string[],
    audioAttachments?: string[],
  ) => {
    set({ error: null });
    const prompts = text
      .split('%%%%%%%%%%')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (prompts.length === 0) {
      set({ error: '请输入至少一条提示词' });
      return null;
    }

    try {
      const result = await window.electronAPI.tasks.add(
        prompts,
        mode,
        videoConfig,
        attachments,
        audioAttachment,
        useProjectStore.getState().activeProjectId,
        targetPlatform,
        referenceVideos,
        audioAttachments,
      );
      if (result.success && result.tasks) {
        set({ tasks: [...get().tasks, ...result.tasks] });
        return result.tasks;
      } else {
        set({ error: result.error || '添加失败' });
        return null;
      }
    } catch (err: any) {
      set({ error: err.message });
      return null;
    }
  },

  assignTask: async (taskId: string, accountId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.assign(taskId, accountId);
      if (result.success) {
        const tasks = get().tasks.map((t) =>
          t.id === taskId
            ? { ...t, assignedAccountId: accountId, updatedAt: new Date().toISOString() }
            : t
        );
        set({ tasks });

        // 指派后由统一队列调度器启动，避免在这里和定时调度同时抢占账号。
        setTimeout(() => get().processQueue(), 0);
        return true;
      } else {
        set({ error: result.error || '指派失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  updateTaskStatus: async (taskId: string, status: TaskStatus, result?: string, outputs?: string[]) => {
    const persisted = await window.electronAPI.tasks.updateStatus(taskId, status, result, outputs);
    if (!persisted.success) {
      set({ error: persisted.error || '任务状态写入失败' });
      return false;
    }
    const tasks = get().tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status,
            result: result ?? t.result,
            outputs: outputs ?? t.outputs,
            artifacts: outputs ? mergeArtifacts(t, outputs, 'manual') : t.artifacts,
            updatedAt: new Date().toISOString(),
          }
        : t
    );
    set({ tasks });
    return true;
  },

  registerArtifact: async (taskId: string, url: string, options = {}) => {
    const persisted = await window.electronAPI.tasks.registerArtifact({
      taskId,
      url,
      source: options.source || 'manual',
      conversationUrl: options.conversationUrl,
      runId: options.runId,
      kind: options.kind,
      contentType: options.contentType,
      contentLength: options.contentLength,
      statusCode: options.statusCode,
    });
    if (!persisted.success || !persisted.task) {
      set({ error: persisted.error || '产物登记失败' });
      return false;
    }
    set({ tasks: get().tasks.map((task) => task.id === taskId ? persisted.task! : task) });
    return true;
  },

  importCsv: async (filePath?: string) => {
    const result = await window.electronAPI.tasks.importCsv(useProjectStore.getState().activeProjectId, filePath);
    if (!result.success || !result.tasks) {
      if (result.error) set({ error: result.error });
      return null;
    }
    set({ tasks: [...get().tasks, ...result.tasks] });
    setTimeout(() => get().processQueue(), 0);
    return { tasks: result.tasks, imported: result.imported || result.tasks.length, skipped: result.skipped || 0, errors: result.errors || [] };
  },

  updateTask: async (taskId: string, updates: TaskUpdateInput) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.update(taskId, updates);
      if (!result.success || !result.task) {
        set({ error: result.error || '编辑任务失败' });
        return false;
      }
      set({
        tasks: get().tasks.map((task) => task.id === taskId ? result.task! : task),
      });
      return true;
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  deleteTask: async (taskId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.delete(taskId);
      if (result.success) {
        const tasks = get().tasks.filter((t) => t.id !== taskId);
        set({ tasks });
        return true;
      } else {
        set({ error: result.error || '删除失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  retryTask: async (taskId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.retry(taskId);
      if (result.success && result.task) {
        const tasks = get().tasks.map((t) =>
          t.id === taskId ? { ...result.task! } : t
        );
        set({ tasks });

        // 重试后统一由调度器决定是否启动，避免绕过依赖检查、账号健康/额度检查和防重复处理
        setTimeout(() => get().processQueue(), 0);

        return true;
      } else {
        set({ error: result.error || '重试失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  retryAfterQuotaExhaustion: async (taskId: string, expectedRunId: string, replacementAccountId?: string | null) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.retryAfterQuotaExhaustion({
        taskId,
        expectedRunId,
        replacementAccountId,
      });
      if (result.success && result.task) {
        set({ tasks: get().tasks.map((task) => task.id === taskId ? result.task! : task) });
        setTimeout(() => get().processQueue(), 0);
        return true;
      }
      set({ error: result.error || '额度恢复失败' });
      return false;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : '额度恢复失败' });
      return false;
    }
  },

  retryAfterPreSubmitFailure: async (taskId: string, expectedRunId: string, replacementAccountId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.retryAfterPreSubmitFailure({
        taskId,
        expectedRunId,
        replacementAccountId,
      });
      if (result.success && result.task) {
        set({ tasks: get().tasks.map((task) => task.id === taskId ? result.task! : task) });
        setTimeout(() => get().processQueue(), 0);
        return true;
      }
      set({ error: result.error || '提交前账号切换失败' });
      return false;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : '提交前账号切换失败' });
      return false;
    }
  },

  batchPause: async () => {
    try {
      Object.values(get().executingTasks).forEach((taskId) => {
        window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId } }));
      });
      const result = await window.electronAPI.tasks.batchPause();
      if (result.success) {
        const tasks = get().tasks.map((t) =>
          t.status === 'executing' || t.status === 'generating' || t.status === 'waiting_verification'
            ? {
                ...t,
                status: 'paused' as TaskStatus,
                result: '批量暂停',
                runtime: t.runtime ? { ...t.runtime, stage: 'paused' as TaskStage, message: '批量暂停' } : t.runtime,
              }
            : t
        );
        // 清空所有执行状态
        set({
          tasks,
          executingTasks: {},
          accountBusy: {},
          accountAutomationState: {},
          accountAutoMessage: {},
          activeTaskId: null,
          automationState: 'idle',
          schedulerPaused: true,
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  resumeAll: async () => {
    const pausedTasks = get().tasks.filter((task) => task.status === 'paused');
    const resumed = new Map<string, Task>();
    const failures: string[] = [];
    for (const task of pausedTasks) {
      const result = await window.electronAPI.tasks.retry(task.id);
      if (result.success && result.task) {
        resumed.set(task.id, result.task);
      } else {
        failures.push(result.error || `任务 ${task.id.slice(0, 8)} 恢复失败`);
      }
    }
    set({
      schedulerPaused: false,
      tasks: get().tasks.map((task) => resumed.get(task.id) || task),
      error: failures.length > 0 ? `部分任务未恢复：${failures.slice(0, 2).join('；')}` : null,
    });
    setTimeout(() => get().processQueue(), 0);
    return failures.length === 0;
  },

  getCompletedOutputs: async () => {
    return window.electronAPI.tasks.getCompletedOutputs();
  },

  clearError: () => set({ error: null }),

  // ---- V3 自动化方法 ----

  startAutomation: async (taskId: string) => {
    const auth = useLalorAuthStore.getState().snapshot;
    if (!auth.authenticated || !auth.profile?.membership?.active || !(Date.parse(auth.profile.membership.expiresAt) > Date.now())) {
      set({ error: '生成需要有效 Lalor 会员，请到个人中心登录或续费' });
      return false;
    }
    if (get().schedulerPaused) {
      set({ error: '任务调度已暂停' });
      return false;
    }
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task || !task.assignedAccountId) {
      console.warn('[TaskStore] startAutomation: 任务未指派账号', taskId);
      set({ error: task ? '任务尚未指派账号' : '任务不存在' });
      return false;
    }
    if (task.status !== 'queued') {
      set({ error: '只有排队中的任务可以启动' });
      return false;
    }

    const dependency = evaluateDependencies(task, get().tasks);
    if (dependency.state !== 'ready') {
      set({ error: dependency.message || '任务依赖尚未就绪' });
      setTimeout(() => get().processQueue(), 0);
      return false;
    }

    const accountId = task.assignedAccountId;
    const assignedAccount = useAccountStore.getState().accounts.find((account) => account.id === accountId);
    const accountBlockReason = getAssignedAccountBlockReason(assignedAccount, task);
    if (accountBlockReason) {
      console.warn('[TaskStore] 账号不可调度:', accountBlockReason, accountId);
      set({ error: accountBlockReason });
      setTimeout(() => get().processQueue(), 0);
      return false;
    }

    // 检查账号是否忙碌
    const reservedTask = get().tasks.find((item) =>
      item.id !== taskId && item.assignedAccountId === accountId &&
      ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(item.status),
    );
    if (reservedTask) {
      set({ error: '该账号仍绑定生成确认或人工提交观察会话；请先完成只读回读或人工取消' });
      return false;
    }
    if (get().accountBusy[accountId]) {
      console.log('[TaskStore] 账号', accountId, '忙碌，任务排队');
      set({ error: '该账号正在执行其他任务' });
      return false;
    }

    const runId = `${taskId}-${Date.now()}`;
    const reservation = await automationEngine.reserve(taskId, accountId, runId, {
      mode: task.mode,
      onWatchdogTimeout: async (event) => {
        const latest = get().tasks.find((item) => item.id === taskId);
        // 迟到的 watchdog 只能结束创建它的那次运行，不能覆盖重试后的新 run。
        if (!latest || latest.runtime?.runId !== runId) return;
        if (['done', 'fail', 'paused', 'cancelled'].includes(latest.status)) return;
        const timeoutSeconds = Math.ceil(event.timeoutMs / 1000);
        const timeoutMessage = `任务在 ${event.stage} 阶段超过 ${timeoutSeconds} 秒，已停止等待；系统未自动重发`;
        await get().pauseAutomation(taskId, accountId, timeoutMessage, {
          status: 'paused',
          code: 'task_watchdog_timeout',
        });
        set({ error: timeoutMessage });
        setTimeout(() => get().processQueue(), 0);
      },
    });
    if (!reservation.ok) {
      set({ error: reservation.error || '任务锁定失败' });
      return false;
    }

    const now = new Date().toISOString();
    const startedTask: Task = {
      ...task,
      status: 'executing',
      result: null,
      errorInfo: undefined,
      runtime: {
        runId,
        attempt: (task.runtime?.attempt || 0) + 1,
        stage: 'preparing_account',
        message: '准备执行',
        startedAt: now,
        stageStartedAt: now,
        lastHeartbeatAt: now,
        input: {
          prompt: task.prompt,
          mode: task.mode,
          videoConfig: task.videoConfig,
          attachments: [...(task.attachments || [])],
          referenceVideos: [...(task.referenceVideos || [])],
          audioAttachment: task.audioAttachment,
          audioAttachments: [...(task.audioAttachments || [])],
        },
      },
      updatedAt: now,
    };

    const initialRuntimePatch = {
      status: 'executing',
      runtime: startedTask.runtime,
      errorInfo: null,
      result: '',
    } as const;
    const initialRuntimePromise = Promise.resolve().then(() => window.electronAPI.tasks.updateRuntime(taskId, initialRuntimePatch));
    let persisted: Awaited<typeof initialRuntimePromise>;
    try {
      persisted = await withTimeout(
        initialRuntimePromise,
        WATCHDOG_POLICY.runtimePersistMs,
        '任务运行状态写入超时，已停止等待；任务未提交且未自动重发',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '任务运行状态写入失败，任务未提交且未自动重发';
      const pausedAt = new Date().toISOString();
      const pauseErrorInfo: TaskErrorInfo = {
        code: error instanceof BoundedTimeoutError ? 'runtime_persistence_timeout' : 'runtime_persistence_failed',
        message,
        recoverable: true,
        detectedAt: pausedAt,
      };
      const pausedRuntime: TaskRunSnapshot = {
        ...startedTask.runtime as TaskRunSnapshot,
        stage: 'paused' as TaskStage,
        message,
        stageStartedAt: pausedAt,
        lastHeartbeatAt: pausedAt,
      };
      // 先更新本地快照，防止队列调度器把仍为 queued 的任务立即再次启动。
      set((current) => ({
        tasks: current.tasks.map((item) => item.id === taskId ? {
          ...item,
          status: 'paused' as TaskStatus,
          result: message,
          errorInfo: pauseErrorInfo,
          runtime: pausedRuntime,
          updatedAt: pausedAt,
        } : item),
        error: message,
      }));
      if (error instanceof BoundedTimeoutError) {
        // IPC 可能在超时后迟到；只允许同一 runId 的迟到结果触发一次暂停回写，
        // 且绝不覆盖已经开始的新 run。
        void initialRuntimePromise.then((lateResult) => {
          if (!lateResult.success || lateResult.task?.runtime?.runId !== runId) return;
          void withTimeout(
            () => window.electronAPI.tasks.updateRuntime(taskId, {
              status: 'paused',
              result: message,
              errorInfo: pauseErrorInfo,
              runtime: pausedRuntime,
            }),
            WATCHDOG_POLICY.runtimePersistMs,
            '迟到的任务暂停状态写入超时',
          ).catch((lateError: unknown) => {
            console.warn('[TaskStore] 迟到的任务暂停状态未能写回:', lateError);
          });
        }, () => undefined);
      } else {
        // 已知的同步失败没有迟到写入，做一次有界的暂停状态落盘尝试。
        void withTimeout(
          () => window.electronAPI.tasks.updateRuntime(taskId, {
            status: 'paused',
            result: message,
            errorInfo: pauseErrorInfo,
            runtime: pausedRuntime,
          }),
          WATCHDOG_POLICY.runtimePersistMs,
          '任务暂停状态写入超时',
        ).catch((persistError: unknown) => {
          console.warn('[TaskStore] 任务暂停状态未能写回:', persistError);
        });
      }
      await automationEngine.release(taskId);
      return false;
    }
    if (!persisted.success) {
      const message = persisted.error || '任务运行状态写入失败，任务未提交且未自动重发';
      const pausedAt = new Date().toISOString();
      const pauseErrorInfo: TaskErrorInfo = {
        code: 'runtime_persistence_failed',
        message,
        recoverable: true,
        detectedAt: pausedAt,
      };
      const pausedRuntime: TaskRunSnapshot = {
        ...startedTask.runtime as TaskRunSnapshot,
        stage: 'paused' as TaskStage,
        message,
        stageStartedAt: pausedAt,
        lastHeartbeatAt: pausedAt,
      };
      set((current) => ({
        tasks: current.tasks.map((item) => item.id === taskId ? {
          ...item,
          status: 'paused' as TaskStatus,
          result: message,
          errorInfo: pauseErrorInfo,
          runtime: pausedRuntime,
          updatedAt: pausedAt,
        } : item),
        error: message,
      }));
      void withTimeout(
        () => window.electronAPI.tasks.updateRuntime(taskId, {
          status: 'paused',
          result: message,
          errorInfo: pauseErrorInfo,
          runtime: pausedRuntime,
        }),
        WATCHDOG_POLICY.runtimePersistMs,
        '任务暂停状态写入超时',
      ).catch((persistError: unknown) => {
        console.warn('[TaskStore] 任务暂停状态未能写回:', persistError);
      });
      await automationEngine.release(taskId);
      return false;
    }

    console.log('[TaskStore] 启动任务', taskId, '在账号', accountId);
    void window.electronAPI.logs.append({ level: 'info', scope: 'automation', message: '任务开始执行', taskId, accountId });

    set({
      tasks: get().tasks.map((item) => item.id === taskId ? (persisted.task || startedTask) : item),
      executingTasks: { ...get().executingTasks, [accountId]: taskId },
      accountBusy: { ...get().accountBusy, [accountId]: true },
      accountAutomationState: { ...get().accountAutomationState, [accountId]: 'injecting' },
      accountAutoMessage: { ...get().accountAutoMessage, [accountId]: '准备执行...' },
      // 向后兼容
      activeTaskId: taskId,
      automationState: 'injecting',
    });

    return true;
  },

  setAccountAutomationState: (accountId: string, state: AutomationState, message?: string, stage?: TaskStage) => {
    const previousState = get().accountAutomationState[accountId];
    const taskId = get().executingTasks[accountId];
    if (taskId) automationEngine.heartbeat(taskId, stage);
    const now = new Date().toISOString();
    const status: TaskStatus | undefined = stage === 'waiting_verification' || stage === 'waiting_generation_confirmation'
      ? stage
      : state === 'generating'
        ? 'generating'
        : state === 'injecting' || state === 'submitting'
          ? 'executing'
          : undefined;
    const tasks = taskId
      ? get().tasks.map((task) => task.id === taskId
        ? {
            ...task,
            status: status || task.status,
            runtime: task.runtime ? {
              ...task.runtime,
              stage: stage || task.runtime.stage,
              message: message ?? task.runtime.message,
              stageStartedAt: stage && stage !== task.runtime.stage ? now : task.runtime.stageStartedAt,
              lastHeartbeatAt: now,
              // submitting 只记录“准备发送”的意图；平台回读确认后再写 submittedAt。
              // 未确认的人机验证/控件恢复仍可在同一账号安全重试。
              submissionIntentAt: stage === 'submitting'
                ? (task.runtime.submissionIntentAt || (!task.runtime.submittedAt && !task.runtime.submissionConfirmedAt ? now : undefined))
                : task.runtime.submissionIntentAt,
              submittedAt: task.runtime.submittedAt,
              submissionConfirmedAt: task.runtime.submissionConfirmedAt,
            } : task.runtime,
            updatedAt: now,
          }
        : task)
      : get().tasks;
    set({
      tasks,
      accountAutomationState: { ...get().accountAutomationState, [accountId]: state },
      accountAutoMessage: message !== undefined
        ? { ...get().accountAutoMessage, [accountId]: message }
        : get().accountAutoMessage,
    });
    if (taskId) {
      const task = tasks.find((item) => item.id === taskId);
      const previousPersist = runtimePersistState.get(taskId);
      const shouldPersist = !!task?.runtime && (
        previousPersist?.stage !== task.runtime.stage ||
        Date.now() - (previousPersist?.savedAt || 0) >= 15_000 ||
        state === 'failed' ||
        state === 'completed'
      );
      if (task?.runtime && shouldPersist) {
        runtimePersistState.set(taskId, { stage: task.runtime.stage, savedAt: Date.now() });
        void window.electronAPI.tasks.updateRuntime(taskId, {
          status,
          runtime: task.runtime,
        });
      }
    }
    if (state === 'generating' && previousState !== 'generating') {
      setTimeout(() => get().processQueue(), 0);
    }
  },

  updateTaskRuntime: async (taskId, patch) => {
    const currentStage = get().tasks.find((task) => task.id === taskId)?.runtime?.stage;
    automationEngine.heartbeat(taskId, patch.runtime?.stage || currentStage);
    try {
      const result = await window.electronAPI.tasks.updateRuntime(taskId, patch);
      if (!result.success) {
        set({ error: result.error || '任务运行状态写入失败' });
        return false;
      }
      // IPC 成功但没有返回完整任务时仍视为写入成功；保留当前内存快照，
      // 避免把“磁盘已写入”误判成失败。正常 IPC 会返回 result.task，
      // 此时用服务端归一化后的任务替换本地快照。
      if (result.task) {
        set({ tasks: get().tasks.map((task) => task.id === taskId ? result.task! : task) });
      }
      return true;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  completeAutomation: async (taskId: string, accountId: string, resultUrl: string, outputs?: string[]) => {
    const task = get().tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('任务已不存在，无法保存视频产物');

    // 对话/音乐结果可能是文本或无媒体回复；只有图片/视频允许把
    // resultUrl 作为兼容的单个媒体地址回退，避免把对话文本写入 outputs。
    const isMediaTask = task.mode === 'image' || task.mode === 'video';
    const mediaLabel = task.mode === 'image' ? '图片' : '视频';
    const fallbackOutputs = isMediaTask ? [resultUrl] : [];
    const finalOutputs = [...new Set((outputs && outputs.length > 0 ? outputs : fallbackOutputs).filter(
      (url): url is string => typeof url === 'string' && url.trim().length > 0,
    ))];
    if (task.mode === 'video' && finalOutputs.length === 0) {
      throw new ArtifactArchiveError('视频已生成，但没有可保存的产物地址');
    }
    if (task.mode === 'image' && finalOutputs.length === 0) {
      throw new Error('图片已生成，但没有可保存的产物地址');
    }

    // 图片/视频自动化任务必须先把平台地址落盘，再写入 done/artifacts。
    // 这样产物中心中的“本地”状态与任务完成状态保持一致，下载失败时
    // 由调用方进入失败/暂停处理，不会把带水印或未保存的地址标成完成。
    // 对话/音乐仍保持文本结果语义，不触发媒体下载。
    if (isMediaTask) {
      try {
        const settings = await window.electronAPI.settings.get();
        const downloadDir = settings && typeof settings.downloadDir === 'string' ? settings.downloadDir : undefined;
        const download = await window.electronAPI.tasks.downloadOutputs([{
          taskId,
          prompt: task.prompt,
          outputs: finalOutputs,
          accountId,
          mode: task.mode,
        }], downloadDir);
        if (!download.success || download.failed > 0 || download.count < finalOutputs.length) {
          const detail = download.error || `仅下载 ${download.count}/${finalOutputs.length} 个产物`;
          throw new ArtifactArchiveError(`${mediaLabel}已生成，但自动保存到产物中心失败：${detail}`);
        }
      } catch (error: unknown) {
        if (error instanceof ArtifactArchiveError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new ArtifactArchiveError(`${mediaLabel}已生成，但自动保存到产物中心失败：${detail}`);
      }
    }

    void window.electronAPI.logs.append({
      level: 'info',
      scope: 'automation',
      message: isMediaTask
        ? `任务完成并已保存 ${finalOutputs.length} 个${mediaLabel}产物`
        : `任务完成，发现 ${finalOutputs.length} 个产物`,
      taskId,
      accountId,
    });
    let statusResult = await window.electronAPI.tasks.updateStatus(taskId, 'done', resultUrl, finalOutputs);
    if (!statusResult.success) {
      // 下载文件已经落盘时，优先再走一次正式 artifact 登记并重试状态写入。
      // 这可以覆盖一次性的 repository 快照冲突，同时不会重新请求平台视频。
      if (finalOutputs.length > 0) {
        const registrations = await Promise.all(finalOutputs.map((url) => window.electronAPI.tasks.registerArtifact({
          taskId,
          url,
          source: 'network',
          conversationUrl: task.runtime?.conversationUrl,
          runId: task.runtime?.runId,
        })));
        if (registrations.some((result) => !result.success)) {
          const detail = statusResult.error || '请稍后重试归档';
          if (isMediaTask) {
            throw new ArtifactArchiveError(`${mediaLabel}已生成，但任务产物登记失败：${detail}`);
          }
          throw new Error(`任务产物登记失败：${detail}`);
        }
      }
      statusResult = await window.electronAPI.tasks.updateStatus(taskId, 'done', resultUrl, finalOutputs);
      if (!statusResult.success) {
        const detail = statusResult.error || '请检查数据目录权限';
        if (isMediaTask) {
          throw new ArtifactArchiveError(`${mediaLabel}已生成，但任务完成状态写入失败：${detail}`);
        }
        throw new Error(`任务完成状态写入失败：${detail}`);
      }
    }

    // 任务已进入 done 后，runtime 写入失败不能再把已完成任务覆盖成 fail。
    // 有界重试后保留 done，并在本地以完成快照更新；下次加载会从任务文件回读。
    let runtimePersisted = false;
    for (let attempt = 0; attempt < 2 && !runtimePersisted; attempt += 1) {
      const runtimeResult = await window.electronAPI.tasks.updateRuntime(taskId, {
      status: 'done',
      runtime: {
        stage: 'completed',
        message: '生成完成',
        stageStartedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      },
      errorInfo: null,
      });
      runtimePersisted = runtimeResult.success;
      if (!runtimePersisted && attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (!runtimePersisted) {
      void window.electronAPI.logs.append({
        level: 'warn',
        scope: 'automation',
        message: '任务已完成且产物已保存，但完成运行快照写入失败；保留 done，不回退状态',
        taskId,
        accountId,
      });
    }

    // 让渲染层优先采用主进程归一化后的 artifact.kind/MIME 分类，
    // 避免本地旧快照仍把视频任务中的封面显示为视频。
    let persistedTask: Task | undefined;
    try {
      persistedTask = (await window.electronAPI.tasks.list()).find((item) => item.id === taskId);
    } catch {
      persistedTask = undefined;
    }

    const tasks: Task[] = get().tasks.map((t): Task => {
      if (t.id !== taskId) return t;

      // Resolve the persisted snapshot once. Keeping this as a concrete Task
      // preserves the required runId on runtime during TypeScript inference.
      const completedBase: Task = persistedTask ?? t;
      return {
        ...completedBase,
        status: 'done',
        result: resultUrl,
        outputs: finalOutputs,
        artifacts: persistedTask?.artifacts || mergeArtifacts(t, finalOutputs),
        errorInfo: undefined,
        runtime: completedBase.runtime
          ? {
              ...completedBase.runtime,
              stage: 'completed',
              message: '生成完成',
            }
          : undefined,
        updatedAt: new Date().toISOString(),
      };
    });

    // 清除该账号的执行状态
    const newExecuting = { ...get().executingTasks };
    const newBusy = { ...get().accountBusy };
    const newAutoState = { ...get().accountAutomationState };
    const newAutoMsg = { ...get().accountAutoMessage };
    delete newExecuting[accountId];
    delete newBusy[accountId];
    newAutoState[accountId] = 'completed';
    newAutoMsg[accountId] = '生成完成！';

    // 向后兼容：如果完成的是活跃任务
    const isActive = get().activeTaskId === taskId;

    set({
      tasks,
      executingTasks: newExecuting,
      accountBusy: newBusy,
      accountAutomationState: newAutoState,
      accountAutoMessage: newAutoMsg,
      activeTaskId: isActive ? null : get().activeTaskId,
      automationState: isActive ? 'completed' : get().automationState,
    });

    // 更新账号状态
    window.electronAPI.accounts.setStatus(accountId, 'idle');

    // 延迟后清理完成状态 + 处理队列
    setTimeout(() => {
      const s = get();
      const cleanState = { ...s.accountAutomationState };
      const cleanMsg = { ...s.accountAutoMessage };
      if (cleanState[accountId] === 'completed') {
        cleanState[accountId] = 'idle';
        cleanMsg[accountId] = '';
      }
      set({
        accountAutomationState: cleanState,
        accountAutoMessage: cleanMsg,
      });
      // 处理队列：检查是否有排队任务可以启动
      get().processQueue();
    }, 2000);
  },

  pauseAutomation: async (
    taskId: string,
    accountId: string,
    pauseMessage = '用户已暂停',
    options?: {
      status: 'paused' | 'cancelled' | 'waiting_verification' | 'waiting_generation_confirmation';
      code?: string;
      generationConfirmation?: NonNullable<TaskRunSnapshot['generationConfirmation']>;
    },
  ) => {
    void window.electronAPI.logs.append({ level: 'warn', scope: 'automation', message: pauseMessage, taskId, accountId });
    const now = new Date().toISOString();
    const targetStatus: TaskStatus = options?.status || 'paused';
    const targetStage: TaskStage = targetStatus === 'waiting_verification'
      ? 'waiting_verification'
      : targetStatus === 'waiting_generation_confirmation'
        ? 'waiting_generation_confirmation'
        : 'paused';
    const errorInfo: TaskErrorInfo = {
      code: options?.code || 'cancelled',
      message: pauseMessage,
      recoverable: true,
      detectedAt: now,
    };
    const runtimeBeforePause = get().tasks.find((task) => task.id === taskId)?.runtime;
    const pausePatch = {
      status: targetStatus,
      result: pauseMessage,
      errorInfo,
      runtime: {
        stage: targetStage,
        message: pauseMessage,
        stageStartedAt: now,
        lastHeartbeatAt: now,
        generationConfirmation: options?.generationConfirmation,
        // 显式保留提交意图/确认标记；暂停/恢复路径不能因为部分 runtime patch
        // 把它丢掉，否则应用重启后可能重复发送或丢失同账号恢复依据。
        submissionIntentAt: runtimeBeforePause?.submissionIntentAt,
        submittedAt: runtimeBeforePause?.submittedAt,
        submissionConfirmedAt: runtimeBeforePause?.submissionConfirmedAt,
        humanVerificationRetryCount: runtimeBeforePause?.humanVerificationRetryCount,
      },
    };
    let persisted = false;
    for (let attempt = 0; attempt < 2 && !persisted; attempt += 1) {
      persisted = await get().updateTaskRuntime(taskId, pausePatch);
      if (!persisted && attempt === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!persisted) {
      // 不更新内存中的暂停/空闲状态，也不向 UI 宣称暂停成功；调用方可
      // 保留执行锁并提示用户检查数据目录，避免“假暂停”导致重复提交。
      set({ error: '任务暂停状态写入失败，请检查磁盘空间和数据目录权限' });
      throw new Error('任务暂停状态持久化失败；未宣称已暂停，执行锁保持');
    }

    const newExecuting = { ...get().executingTasks };
    const newBusy = { ...get().accountBusy };
    delete newExecuting[accountId];
    delete newBusy[accountId];
    set({
      tasks: get().tasks.map((task) => task.id === taskId ? {
        ...task,
        status: targetStatus,
        result: pauseMessage,
        errorInfo,
        runtime: task.runtime ? {
          ...task.runtime,
          stage: targetStage,
          message: pauseMessage,
          stageStartedAt: now,
          lastHeartbeatAt: now,
          generationConfirmation: options?.generationConfirmation,
        } : task.runtime,
        updatedAt: now,
      } : task),
      executingTasks: newExecuting,
      accountBusy: newBusy,
      accountAutomationState: { ...get().accountAutomationState, [accountId]: 'idle' },
      accountAutoMessage: { ...get().accountAutoMessage, [accountId]: pauseMessage },
      activeTaskId: get().activeTaskId === taskId ? null : get().activeTaskId,
      automationState: get().activeTaskId === taskId ? 'idle' : get().automationState,
    });
    void window.electronAPI.accounts.setStatus(accountId, 'idle');
  },

  failAutomation: async (taskId: string, accountId: string, errorMsg: string, errorInfo?: TaskErrorInfo) => {
    void window.electronAPI.logs.append({ level: 'error', scope: errorInfo?.code || 'automation', message: errorMsg, taskId, accountId });
    const now = new Date().toISOString();
    await window.electronAPI.tasks.updateStatus(taskId, 'fail', errorMsg);
    await window.electronAPI.tasks.updateRuntime(taskId, {
      status: 'fail',
      result: errorMsg,
      errorInfo: errorInfo || null,
      runtime: { stage: 'failed', message: errorMsg, stageStartedAt: now, lastHeartbeatAt: now },
    });

    const tasks = get().tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status: 'fail' as TaskStatus,
            result: errorMsg,
            errorInfo,
            runtime: t.runtime ? { ...t.runtime, stage: 'failed' as TaskStage, message: errorMsg, stageStartedAt: now, lastHeartbeatAt: now } : t.runtime,
            updatedAt: now,
          }
        : t
    );

    const newExecuting = { ...get().executingTasks };
    const newBusy = { ...get().accountBusy };
    const newAutoState = { ...get().accountAutomationState };
    const newAutoMsg = { ...get().accountAutoMessage };
    delete newExecuting[accountId];
    delete newBusy[accountId];
    newAutoState[accountId] = 'failed';
    newAutoMsg[accountId] = errorMsg;

    const isActive = get().activeTaskId === taskId;

    set({
      tasks,
      executingTasks: newExecuting,
      accountBusy: newBusy,
      accountAutomationState: newAutoState,
      accountAutoMessage: newAutoMsg,
      activeTaskId: isActive ? null : get().activeTaskId,
      automationState: isActive ? 'failed' : get().automationState,
    });

    window.electronAPI.accounts.setStatus(accountId, 'idle');

    // 延迟后清理 + 处理队列
    setTimeout(() => {
      const s = get();
      const cleanState = { ...s.accountAutomationState };
      const cleanMsg = { ...s.accountAutoMessage };
      if (cleanState[accountId] === 'failed') {
        cleanState[accountId] = 'idle';
        cleanMsg[accountId] = '';
      }
      set({
        accountAutomationState: cleanState,
        accountAutoMessage: cleanMsg,
      });
      get().processQueue();
    }, 3000);
  },

  // ---- 队列调度 ----

  processQueue: () => {
    const auth = useLalorAuthStore.getState().snapshot;
    if (!auth.authenticated || !auth.profile?.membership?.active || !(Date.parse(auth.profile.membership.expiresAt) > Date.now())) return;
    if (queueProcessing) return;
    queueProcessing = true;
    let handedOff = false;
    try {
      const state = get();
      if (state.schedulerPaused) return;
    // 找出所有已指派但还在 queued 状态的任务
      const queuedTasks = state.tasks.filter(
        (t) => t.status === 'queued' && t.assignedAccountId
      );

    // 按创建时间排序
      queuedTasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const task of queuedTasks) {
        const dependency = evaluateDependencies(task, state.tasks);
        if (dependency.state === 'missing' || dependency.state === 'failed' || dependency.state === 'invalid') {
          const message = dependency.message!;
          const now = new Date().toISOString();
          set((current) => ({
            tasks: current.tasks.map((item) => item.id === task.id ? {
              ...item,
              status: 'fail' as TaskStatus,
              result: message,
              errorInfo: { code: 'generation_failed', message, recoverable: true, detectedAt: now },
              updatedAt: now,
            } : item),
          }));
          void window.electronAPI.tasks.updateRuntime(task.id, {
            status: 'fail',
            result: message,
            errorInfo: { code: 'generation_failed', message, recoverable: true, detectedAt: now },
          });
          continue;
        }
        if (dependency.state !== 'ready') continue;
        const accountId = task.assignedAccountId!;
        const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
        if (getAssignedAccountBlockReason(account, task)) {
          // 用户已明确指派的任务必须保持绑定，不得因冷却/额度/登录状态而静默改派。
          // 自动指派只发生在任务创建或 CSV 导入阶段。
          continue;
        }
        if (!state.accountBusy[accountId]) {
          console.log('[TaskStore] 队列调度：启动任务', task.id, '在账号', accountId);
          handedOff = true;
          void state.startAutomation(task.id).then((started) => {
            queueProcessing = false;
            // 会员/网络校验失败时保留排队，等待用户恢复；不能立即无限重试同一任务。
            if (started) get().processQueue();
          }, (error: unknown) => {
            queueProcessing = false;
            set({ error: error instanceof Error ? error.message : '任务启动失败，请检查会员和网络后重试' });
          });
          return; // 每次只启动一个，完成锁定后继续调度其他空闲账号
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[TaskStore] 队列调度异常：', err);
      set({ error: `任务调度异常：${error}` });
    } finally {
      // assign/startAutomation 已接管后，由其 finally 释放调度锁；其余路径必须立即释放。
      if (!handedOff) queueProcessing = false;
    }
  },

  getNextTaskForAccount: (accountId: string) => {
    const tasks = get().tasks;
    return tasks.find(
      (t) => t.status === 'queued' && t.assignedAccountId === accountId
    ) || null;
  },
}));
