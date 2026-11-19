/**
 * main/preload.ts
 * 预加载脚本 - 在渲染进程加载前执行
 * 通过 contextBridge 安全地暴露 IPC 通信接口给渲染进程
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  SoftwareUpdateState,
  SoftwareUpdateResult,
  ElectronAPI,
  ZiziPluginAPI,
  Account,
  AccountAvailability,
  AccountPlatform,
  AccountProxyInput,
  AccountGetProxyResult,
  DolaProxyResult,
  AccountTestProxyResult,
  AccountDailyQuotaRefreshResult,
  AccountVideoQuotaAction,
  Task,
  GenerationMode,
  TaskRegisterArtifactParams,
  TaskRetryAfterQuotaExhaustionParams,
  TaskRetryAfterPreSubmitFailureParams,
  TaskDownloadOutputsResult,
  StoryboardBatchAPI,
  DolaCkImportItem,
  DoubaoCkImportItem,
  DolaEmailImportItem,
  LocalRoutingMode,
  ProxyPoolInput,
  ProxySubscriptionInput,
  LocalManagerResult,
  LocalManagerSnapshot,
  LocalAssetMetadata,
  SessionBinding,
  LalorAuthResult,
  LalorAuthSnapshot,
  LalorCashPurchaseInput,
  LalorCatalog,
  LalorImportDeliveryResult,
  LalorOrderHistoryClearResult,
  LalorOrderPage,
  LalorPurchasePointsInput,
  LalorConnectionStatus,
  LalorOperationResult,
  LalorProfile,
  LalorPurchaseResult,
  LalorSaveDeliveryResult,
  WorkbenchApiResult,
  WorkbenchApiSaveInput,
} from '@doubao-studio/contracts';

type LalorTaskListener = (taskId: string) => void;
const lalorTaskAvailableListeners = new Set<LalorTaskListener>();
const lalorTaskCancelledListeners = new Set<LalorTaskListener>();
const pendingLalorTasks = new Set<string>();
const pendingLalorCancellations = new Set<string>();

function dispatchLalorTaskEvent(
  taskId: unknown,
  listeners: Set<LalorTaskListener>,
  pending: Set<string>,
): void {
  if (typeof taskId !== 'string' || !taskId.trim()) return;
  const normalized = taskId.trim();
  if (listeners.size === 0) {
    pending.add(normalized);
    return;
  }
  for (const listener of listeners) listener(normalized);
}

ipcRenderer.on('lalorTasks:available', (_event, taskId: unknown) => {
  dispatchLalorTaskEvent(taskId, lalorTaskAvailableListeners, pendingLalorTasks);
});
ipcRenderer.on('lalorTasks:cancelled', (_event, taskId: unknown) => {
  dispatchLalorTaskEvent(taskId, lalorTaskCancelledListeners, pendingLalorCancellations);
});
// 只有 preload 已注册任务事件缓存后才确认就绪，避免主进程把一次性通知
// 发送到尚未建立监听器的渲染上下文。
ipcRenderer.send('lalorTasks:renderer-ready');

function subscribeLalorTaskEvents(
  handler: LalorTaskListener,
  listeners: Set<LalorTaskListener>,
  pending: Set<string>,
): () => void {
  listeners.add(handler);
  for (const taskId of pending) handler(taskId);
  pending.clear();
  return () => listeners.delete(handler);
}

// ==================== 暴露 API ====================

const electronAPI = {
  control: {
    onCommand: (handler: (command: {
      commandId: string;
      requestId: string;
      action: 'start' | 'pause' | 'cancel' | 'retry';
      projectId: string;
      batchId: string;
      taskId: string;
    }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: Parameters<typeof handler>[0]) => handler(command);
      ipcRenderer.on('control:command', listener);
      return () => ipcRenderer.removeListener('control:command', listener);
    },
    ready: (): void => ipcRenderer.send('control:ready'),
    complete: (result: { commandId: string; ok: boolean; code: string; accepted?: boolean }): void => {
      ipcRenderer.send('control:result', result);
    },
  },
  projects: {
    list: (): Promise<any[]> => ipcRenderer.invoke('projects:list'),
    add: (name: string, description?: string, color?: string): Promise<any> => ipcRenderer.invoke('projects:add', { name, description, color }),
    update: (id: string, updates: Record<string, any>): Promise<any> => ipcRenderer.invoke('projects:update', { id, updates }),
    delete: (id: string): Promise<any> => ipcRenderer.invoke('projects:delete', { id }),
  },
  // ---- 账号管理 ----
  accounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
    refreshDailyQuota: (): Promise<AccountDailyQuotaRefreshResult> => ipcRenderer.invoke('accounts:refreshDailyQuota'),
    add: (name: string, platform?: AccountPlatform): Promise<{ success: boolean; account?: Account; error?: string }> =>
      ipcRenderer.invoke('accounts:add', { name, platform }),
    update: (id: string, name: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('accounts:update', { id, name }),
    delete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('accounts:delete', { id }),
    refresh: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('accounts:refresh', { id }),
    setStatus: (id: string, status: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('accounts:setStatus', { id, status }),
    setPinned: (id: string, pinned: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('accounts:setPinned', { id, pinned }),
    updateSeedanceQuota: (id: string, action: AccountVideoQuotaAction, units?: number): Promise<{ success: boolean; account?: Account; error?: string }> =>
      ipcRenderer.invoke('accounts:updateSeedanceQuota', { id, action, units }),
    setVideoQuotaConfig: (id: string, totalUnits: number, costPerVideoUnits: number): Promise<{ success: boolean; account?: Account; error?: string }> =>
      ipcRenderer.invoke('accounts:setVideoQuotaConfig', { id, totalUnits, costPerVideoUnits }),
    updateHealth: (id: string, action: 'success' | 'failure' | 'verification' | 'login_expired' | 'clear', errorCode?: string): Promise<{ success: boolean; account?: Account }> =>
      ipcRenderer.invoke('accounts:updateHealth', { id, action, errorCode }),
    setAvailability: (id: string, availability: AccountAvailability): Promise<{ success: boolean; account?: Account }> =>
      ipcRenderer.invoke('accounts:setAvailability', { id, availability }),
    updateScheduling: (id: string, updates: Record<string, any>): Promise<any> => ipcRenderer.invoke('accounts:updateScheduling', { id, updates }),
    getDolaProxy: (): Promise<AccountGetProxyResult> => ipcRenderer.invoke('accounts:getDolaProxy'),
    setDolaProxy: (proxy: AccountProxyInput): Promise<DolaProxyResult> => ipcRenderer.invoke('accounts:setDolaProxy', { proxy }),
    testProxy: (proxy: AccountProxyInput): Promise<AccountTestProxyResult> => ipcRenderer.invoke('accounts:testProxy', { proxy }),
    getPartition: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('accounts:getPartition', { id }),
  },

  workbenchCanvas: {
    invoke: (method: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke('workbenchCanvas:invoke', method, payload),
  },
  storyboardBatch: {
    list: (): ReturnType<StoryboardBatchAPI['list']> => ipcRenderer.invoke('storyboardBatch:list'),
    create: (input: Parameters<StoryboardBatchAPI['create']>[0]): ReturnType<StoryboardBatchAPI['create']> => ipcRenderer.invoke('storyboardBatch:create', input),
    prepare: (id: string): ReturnType<StoryboardBatchAPI['prepare']> => ipcRenderer.invoke('storyboardBatch:prepare', id),
    start: (id: string): ReturnType<StoryboardBatchAPI['start']> => ipcRenderer.invoke('storyboardBatch:start', id),
    pause: (id: string): ReturnType<StoryboardBatchAPI['pause']> => ipcRenderer.invoke('storyboardBatch:pause', id),
    recover: (id: string): ReturnType<StoryboardBatchAPI['recover']> => ipcRenderer.invoke('storyboardBatch:recover', id),
    restoreUnsent: (id: string, rowId: string, confirmedNotSent: boolean): ReturnType<StoryboardBatchAPI['restoreUnsent']> => ipcRenderer.invoke('storyboardBatch:restoreUnsent', { id, rowId, confirmedNotSent }),
    open: (id: string): ReturnType<StoryboardBatchAPI['open']> => ipcRenderer.invoke('storyboardBatch:open', id),
    retryDownload: (id: string, rowId: string): ReturnType<StoryboardBatchAPI['retryDownload']> => ipcRenderer.invoke('storyboardBatch:retryDownload', { id, rowId }),
    remove: (id: string): ReturnType<StoryboardBatchAPI['remove']> => ipcRenderer.invoke('storyboardBatch:remove', id),
  },
  // ---- 任务调度 ----
  tasks: {
    list: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
    add: (prompts: string[], mode?: GenerationMode, videoConfig?: any, attachments?: string[], audioAttachment?: string, projectId?: string, targetPlatform?: AccountPlatform, referenceVideos?: string[], audioAttachments?: string[]): Promise<{ success: boolean; tasks?: Task[]; error?: string }> =>
      ipcRenderer.invoke('tasks:add', { prompts, mode, videoConfig, attachments, referenceVideos, audioAttachment, audioAttachments, projectId, targetPlatform }),
    assign: (taskId: string, accountId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:assign', { taskId, accountId }),
    updateStatus: (
      taskId: string,
      status: string,
      result?: string,
      outputs?: string[]
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:updateStatus', { taskId, status, result, outputs }),
    registerArtifact: (params: TaskRegisterArtifactParams): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:registerArtifact', params),
    updateRuntime: (taskId: string, patch: {
      status?: string;
      runtime?: Record<string, any>;
      errorInfo?: Record<string, any> | null;
      result?: string;
    }): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:updateRuntime', { taskId, ...patch }),
    acquireLock: (taskId: string, ownerId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:acquireLock', { taskId, ownerId }),
    renewLock: (taskId: string, ownerId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:renewLock', { taskId, ownerId }),
    releaseLock: (taskId: string, ownerId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:releaseLock', { taskId, ownerId }),
    importCsv: (projectId?: string, filePath?: string): Promise<any> =>
      ipcRenderer.invoke('tasks:importCsv', { projectId, filePath }),
    getPathForDroppedFile: (file: unknown): string => webUtils.getPathForFile(file as File),
    update: (taskId: string, updates: {
      prompt: string;
      videoConfig?: any;
      attachments?: string[];
      referenceVideos?: string[];
      audioAttachment?: string;
      audioAttachments?: string[];
    }): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:update', { taskId, updates }),
    delete: (taskId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:delete', { taskId }),
    retry: (taskId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:retry', { taskId }),
    retryAfterQuotaExhaustion: (params: TaskRetryAfterQuotaExhaustionParams): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:retryAfterQuotaExhaustion', params),
    retryAfterPreSubmitFailure: (params: TaskRetryAfterPreSubmitFailureParams): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:retryAfterPreSubmitFailure', params),
    batchPause: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tasks:batchPause'),
    getCompletedOutputs: (): Promise<Array<{ taskId: string; prompt: string; outputs: string[]; accountId: string | null; mode: GenerationMode }>> =>
      ipcRenderer.invoke('tasks:getCompletedOutputs'),
    selectImages: (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> =>
      ipcRenderer.invoke('tasks:selectImages'),
    selectVideos: (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> =>
      ipcRenderer.invoke('tasks:selectVideos'),
    selectAudio: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:selectAudio'),
    selectAudios: (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> =>
      ipcRenderer.invoke('tasks:selectAudios'),
    readFileAsBase64: (filePath: string): Promise<{ success: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:readFileAsBase64', filePath),
    prepareVideoPreview: (filePath: string): Promise<{ success: boolean; data?: string; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:prepareVideoPreview', filePath),
    downloadOutputs: (
      outputs: Array<{ taskId: string; prompt: string; outputs: string[]; accountId: string | null; mode: GenerationMode }>,
      saveDir?: string
    ): Promise<TaskDownloadOutputsResult> =>
      ipcRenderer.invoke('tasks:downloadOutputs', { outputs, saveDir }),
    downloadPublicShareMedia: (shareUrl: string, saveDir?: string): Promise<any> =>
      ipcRenderer.invoke('tasks:downloadPublicShareMedia', { shareUrl, saveDir }),
    listDownloads: (): Promise<any[]> => ipcRenderer.invoke('tasks:listDownloads'),
    exportDiagnostics: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:exportDiagnostics'),
    validateArtifact: (taskId: string, artifactId: string): Promise<any> =>
      ipcRenderer.invoke('tasks:validateArtifact', { taskId, artifactId }),
    saveAdapterReport: (accountId: string, report: Record<string, any>): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tasks:saveAdapterReport', { accountId, report }),
    selectAdapterRules: (): Promise<any> => ipcRenderer.invoke('tasks:selectAdapterRules'),
    selectSaveDir: (): Promise<{ success: boolean; dirPath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:selectSaveDir'),
  },

  lalorTasks: {
    onTaskAvailable: (handler: LalorTaskListener): (() => void) =>
      subscribeLalorTaskEvents(handler, lalorTaskAvailableListeners, pendingLalorTasks),
    onTaskCancelled: (handler: LalorTaskListener): (() => void) =>
      subscribeLalorTaskEvents(handler, lalorTaskCancelledListeners, pendingLalorCancellations),
  },

  // ---- 设置 ----
  settings: {
    get: (): Promise<Record<string, any>> => ipcRenderer.invoke('settings:get'),
    save: (settings: Record<string, any>): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:save', settings),
  },
  // ---- 工作台可选 Lalor API 配置（Key 只在主进程安全存储） ----
  workbenchApi: {
    get: (): Promise<WorkbenchApiResult> => ipcRenderer.invoke('workbenchApi:get'),
    save: (input: WorkbenchApiSaveInput): Promise<WorkbenchApiResult> => ipcRenderer.invoke('workbenchApi:save', input),
    clear: (): Promise<WorkbenchApiResult> => ipcRenderer.invoke('workbenchApi:clear'),
  },
  logs: {
    list: (): Promise<any[]> => ipcRenderer.invoke('logs:list'),
    append: (entry: Record<string, any>): Promise<any> => ipcRenderer.invoke('logs:append', entry),
    clear: (): Promise<any> => ipcRenderer.invoke('logs:clear'),
  },

  // ---- 本地 Dola 账号池、代理池和窗口绑定 ----
  localManager: {
    snapshot: (): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:snapshot'),
    importDolaCk: (item: DolaCkImportItem): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:importCk', item),
    importDoubaoCk: (item: DoubaoCkImportItem): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:doubao:importCk', item),
    importDolaEmail: (item: DolaEmailImportItem): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:importEmail', item),
    loadDolaCkToAccount: (entryId: string, accountId: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:loadToAccount', { entryId, accountId }),
    reloginDolaCk: (entryId: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:relogin', { entryId }),
    deleteDola: (id: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:delete', { id }),
    clearDola: (): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:clear'),
    retestDola: (): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:dola:retest'),
    loadDoubaoCkToAccount: (entryId: string, accountId: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:doubao:loadToAccount', { entryId, accountId }),
    reloginDoubaoCk: (entryId: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:doubao:relogin', { entryId }),
    deleteDoubao: (id: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:doubao:delete', { id }),
    clearDoubao: (): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:doubao:clear'),
    retestDoubao: (): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:doubao:retest'),
    setConcurrency: (value: number): Promise<LocalManagerResult<{ concurrency: number }>> => ipcRenderer.invoke('localManager:dola:setConcurrency', { value }),
    addProxy: (input: ProxyPoolInput): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:proxy:add', input),
    setProxyEnabled: (id: string, enabled: boolean): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:proxy:setEnabled', { id, enabled }),
    deleteProxy: (id: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:proxy:delete', { id }),
    retestProxy: (): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:proxy:retest'),
    addSubscription: (input: ProxySubscriptionInput): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:subscription:add', input),
    refreshSubscription: (id: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:subscription:refresh', { id }),
    deleteSubscription: (id: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:subscription:delete', { id }),
    bind: (accountId: string, proxyId: string | null): Promise<LocalManagerResult<SessionBinding>> => ipcRenderer.invoke('localManager:binding:bind', { accountId, proxyId }),
    unbind: (accountId: string): Promise<LocalManagerResult<LocalManagerSnapshot>> => ipcRenderer.invoke('localManager:binding:unbind', { accountId }),
    randomAssign: (accountIds: string[], perProxyLimit: number): Promise<LocalManagerResult<SessionBinding[]>> => ipcRenderer.invoke('localManager:binding:randomAssign', { accountIds, perProxyLimit }),
    setRoutingMode: (mode: LocalRoutingMode): Promise<LocalManagerResult<LocalRoutingMode>> => ipcRenderer.invoke('localManager:routing:setMode', { mode }),
    listAssets: (): Promise<LocalManagerResult<LocalAssetMetadata[]>> => ipcRenderer.invoke('localManager:assets:list'),
  },

  // ---- Lalor 会员连接与积分发卡 ----
  lalor: {
    status: (): Promise<LalorOperationResult<LalorConnectionStatus>> => ipcRenderer.invoke('lalor:status'),
    pair: (code: string): Promise<LalorOperationResult<LalorConnectionStatus>> => ipcRenderer.invoke('lalor:pair', code),
    refresh: (): Promise<LalorOperationResult<LalorConnectionStatus>> => ipcRenderer.invoke('lalor:refresh'),
    profile: (): Promise<LalorOperationResult<LalorProfile>> => ipcRenderer.invoke('lalor:profile'),
    catalog: (): Promise<LalorOperationResult<LalorCatalog>> => ipcRenderer.invoke('lalor:catalog'),
    purchase: (productId: string, idempotencyKey: string): Promise<LalorOperationResult<LalorPurchaseResult>> => ipcRenderer.invoke('lalor:purchase', { productId, idempotencyKey }),
    logout: (): Promise<LalorOperationResult<{ serverRevoked: boolean }>> => ipcRenderer.invoke('lalor:logout'),
  },

  // ---- Lalor 会员会话与 Dola 账号商城（完整兼容层） ----
  // 敏感令牌和 CK 内容只在主进程处理，渲染层只接收脱敏资料与短时引用。
  lalorAuth: {
    status: (): Promise<LalorAuthResult<LalorAuthSnapshot>> => ipcRenderer.invoke('lalorAuth:status'),
    pair: (code: string): Promise<LalorAuthResult<LalorAuthSnapshot>> => ipcRenderer.invoke('lalorAuth:pair', code),
    logout: (): Promise<LalorAuthResult<{ ok: boolean }>> => ipcRenderer.invoke('lalorAuth:logout'),
    catalog: (): Promise<LalorAuthResult<LalorCatalog>> => ipcRenderer.invoke('lalorAuth:catalog'),
    orders: (page = 1, limit = 20): Promise<LalorAuthResult<LalorOrderPage>> => ipcRenderer.invoke('lalorAuth:orders', { page, limit }),
    clearOrders: (): Promise<LalorAuthResult<LalorOrderHistoryClearResult>> => ipcRenderer.invoke('lalorAuth:clearOrders'),
    redownloadOrder: (orderId: string): Promise<LalorAuthResult<LalorSaveDeliveryResult>> => ipcRenderer.invoke('lalorAuth:redownloadOrder', orderId),
    purchaseByPoints: (input: LalorPurchasePointsInput): Promise<LalorAuthResult<LalorPurchaseResult>> => ipcRenderer.invoke('lalorAuth:purchaseByPoints', input),
    createCashPurchase: (input: LalorCashPurchaseInput): Promise<LalorAuthResult<LalorPurchaseResult>> => ipcRenderer.invoke('lalorAuth:createCashPurchase', input),
    getCashOrder: (paymentOrderId: string): Promise<LalorAuthResult<LalorPurchaseResult>> => ipcRenderer.invoke('lalorAuth:getCashOrder', paymentOrderId),
    saveDelivery: (deliveryRef: string): Promise<LalorAuthResult<LalorSaveDeliveryResult>> => ipcRenderer.invoke('lalorAuth:saveDelivery', deliveryRef),
    importDelivery: (deliveryRef: string): Promise<LalorAuthResult<LalorImportDeliveryResult>> => ipcRenderer.invoke('lalorAuth:importDelivery', deliveryRef),
  },

  // ---- 系统操作 ----
  system: {
    updateStatus: (): Promise<SoftwareUpdateState> => ipcRenderer.invoke('softwareUpdate:status'),
    checkSoftwareUpdate: (): Promise<SoftwareUpdateResult> => ipcRenderer.invoke('softwareUpdate:check'),
    downloadSoftwareUpdate: (): Promise<SoftwareUpdateResult> => ipcRenderer.invoke('softwareUpdate:download'),
    installSoftwareUpdate: (): Promise<SoftwareUpdateResult> => ipcRenderer.invoke('softwareUpdate:install'),
    onSoftwareUpdate: (handler: (state: SoftwareUpdateState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: SoftwareUpdateState): void => handler(state);
      ipcRenderer.on('softwareUpdate:state', listener);
      return () => { ipcRenderer.removeListener('softwareUpdate:state', listener); };
    },
    getVersion: (): Promise<string> => ipcRenderer.invoke('system:getVersion'),
    checkIntegrity: (): Promise<any> => ipcRenderer.invoke('system:checkIntegrity'),
    exportBackup: (): Promise<any> => ipcRenderer.invoke('system:exportBackup'),
    restoreBackup: (): Promise<any> => ipcRenderer.invoke('system:restoreBackup'),
    exportProject: (projectId: string): Promise<any> => ipcRenderer.invoke('system:exportProject', projectId),
    checkUpdate: (): Promise<any> => ipcRenderer.invoke('system:checkUpdate'),
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close'),
  },
  ziziPlugin: {
    status: () => ipcRenderer.invoke('ziziPlugin:status'),
    savePackage: () => ipcRenderer.invoke('ziziPlugin:savePackage'),
  } satisfies ZiziPluginAPI,
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
