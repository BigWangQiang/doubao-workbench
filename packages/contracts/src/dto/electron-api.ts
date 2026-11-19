/**
 * @doubao-studio/contracts — ElectronAPI 桌面内部预加载契约
 *
 * 定义 contextBridge.exposeInMainWorld('electronAPI', ...) 暴露的对象类型。
 * 方法名、参数和返回值必须与 main/preload.ts 的实际暴露对象一致。
 *
 * 这是桌面内部契约，不是对外 Agent API。
 * 禁止将 Cookie、Session、文件路径、内部下载 URL 等字段暴露到公共 Capability Schema。
 */

import type { StoryboardBatchAPI } from '../storyboardBatch';
import type { ZiziPluginAPI } from './ziziPlugin';
import type {
  Account,
  Task,
  Project,
  TaskErrorInfo,
  TaskRunSnapshot,
  DownloadJob,
  AccountAvailability,
  AccountScheduling,
} from '../domain';
import type {
  GenerationMode,
  AccountPlatform,
  TaskStatus,
} from '../enums';

import type {
  AccountResult,
  AccountOperationResult,
  AccountDailyQuotaRefreshResult,
  AccountVideoQuotaAction,
  AccountHealthAction,
  AccountProxyInput,
  AccountGetProxyResult,
  DolaProxyResult,
  AccountTestProxyResult,
} from './accounts';

import type {
  TaskResult,
  TaskRetryAfterQuotaExhaustionParams,
  TaskRetryAfterPreSubmitFailureParams,
  TaskAddResult,
  TaskOperationResult,
  TaskUpdateInput,
  TaskRegisterArtifactParams,
  CsvImportResult,
  CompletedOutput,
  TaskDownloadOutputsResult,
  PublicShareMediaDownloadResult,
  FileSelectResult,
  AudioSelectResult,
  ReadFileAsBase64Result,
  PrepareVideoPreviewResult,
  SelectSaveDirResult,
  TaskValidateArtifactResult,
  TaskSelectAdapterRulesResult,
  ExportDiagnosticsResult,
  AdapterSelfCheckReport,
} from './tasks';

import type {
  ProjectResult,
  ProjectOperationResult,
} from './projects';

import type {
  IntegrityCheckResult,
  ExportBackupResult,
  RestoreBackupResult,
  ExportProjectResult,
  CheckUpdateResult,
} from './system';

import type { SoftwareUpdateState, SoftwareUpdateResult } from './softwareUpdate';
import type {
  LogOperationResult,
  LogAppendParams,
  LogListResult,
} from './logs';

import type {
  DolaCkImportItem,
  DoubaoCkImportItem,
  DolaEmailImportItem,
  LocalAssetMetadata,
  LocalManagerResult,
  LocalManagerSnapshot,
  LocalRoutingMode,
  ProxyPoolInput,
  ProxySubscriptionInput,
  SessionBinding,
} from './localManager';

import type {
  LalorAuthResult,
  LalorAuthSnapshot,
  LalorCashPurchaseInput,
  LalorCatalog,
  LalorImportDeliveryResult,
  LalorOrderHistoryClearResult,
  LalorOrderPage,
  LalorPurchasePointsInput,
  LalorPurchaseResult,
  LalorSaveDeliveryResult,
} from './lalorAuth';
import type {
  LalorConnectionStatus,
  LalorOperationResult,
  LalorProfile,
} from './lalor';
import type { WorkbenchApiResult, WorkbenchApiSaveInput } from './workbench';

/**
 * 桌面内部预加载契约。
 *
 * 消费方：
 * - main/preload.ts 通过 `satisfies ElectronAPI` 约束暴露对象
 * - src/types/electron.d.ts 通过 `import type { ElectronAPI }` 声明全局 Window
 */
export interface ElectronAPI {
  workbenchCanvas: {
    invoke: (method: string, payload?: unknown) => Promise<unknown>;
  };
  // ---- 本机受控自动化桥（不暴露网页、Cookie、Session 或任意脚本能力） ----
  control: {
    onCommand: (handler: (command: {
      commandId: string;
      requestId: string;
      action: 'start' | 'pause' | 'cancel' | 'retry';
      projectId: string;
      batchId: string;
      taskId: string;
    }) => void) => () => void;
    ready: () => void;
    complete: (result: {
      commandId: string;
      ok: boolean;
      code: string;
      accepted?: boolean;
    }) => void;
  };

  // ---- 项目管理 ----
  projects: {
    list: () => Promise<Project[]>;
    add: (name: string, description?: string, color?: string) => Promise<ProjectResult>;
    update: (id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'color' | 'archived'>>) => Promise<ProjectResult>;
    delete: (id: string) => Promise<ProjectOperationResult>;
  };

  // ---- 账号管理 ----
  accounts: {
    list: () => Promise<Account[]>;
    /** 仅归一化并返回账号额度，不重建 WebView 或修改代理/登录状态。 */
    refreshDailyQuota: () => Promise<AccountDailyQuotaRefreshResult>;
    add: (name: string, platform?: AccountPlatform) => Promise<AccountResult>;
    update: (id: string, name: string) => Promise<AccountOperationResult>;
    delete: (id: string) => Promise<AccountOperationResult>;
    refresh: (id: string) => Promise<AccountOperationResult>;
    setStatus: (id: string, status: string) => Promise<{ success: boolean }>;
    setPinned: (id: string, pinned: boolean) => Promise<{ success: boolean }>;
    updateSeedanceQuota: (id: string, action: AccountVideoQuotaAction, units?: number) => Promise<AccountResult>;
    setVideoQuotaConfig: (id: string, totalUnits: number, costPerVideoUnits: number) => Promise<AccountResult>;
    updateHealth: (id: string, action: AccountHealthAction, errorCode?: string) => Promise<AccountResult>;
    setAvailability: (id: string, availability: AccountAvailability) => Promise<AccountResult>;
    updateScheduling: (id: string, updates: Partial<AccountScheduling>) => Promise<AccountResult>;
    /** 读取 Dola 全局代理；豆包账号不提供代理配置。 */
    getDolaProxy: () => Promise<AccountGetProxyResult>;
    /** 保存 Dola 全局代理，并应用到所有 Dola Session。 */
    setDolaProxy: (proxy: AccountProxyInput) => Promise<DolaProxyResult>;
    testProxy: (proxy: AccountProxyInput) => Promise<AccountTestProxyResult>;
    getPartition: (id: string) => Promise<string | null>;
  };

  // ---- 任务调度 ----
  storyboardBatch: StoryboardBatchAPI;
  tasks: {
    list: () => Promise<Task[]>;
    add: (
      prompts: string[],
      mode?: GenerationMode,
      videoConfig?: Task['videoConfig'],
      attachments?: string[],
      audioAttachment?: string,
      projectId?: string,
      targetPlatform?: AccountPlatform,
      referenceVideos?: string[],
      audioAttachments?: string[]
    ) => Promise<TaskAddResult>;
    assign: (taskId: string, accountId: string) => Promise<TaskOperationResult>;
    updateStatus: (
      taskId: string,
      status: string,
      result?: string,
      outputs?: string[]
    ) => Promise<TaskOperationResult>;
    registerArtifact: (params: TaskRegisterArtifactParams) => Promise<TaskResult>;
    updateRuntime: (taskId: string, patch: {
      status?: TaskStatus;
      runtime?: Partial<TaskRunSnapshot>;
      errorInfo?: TaskErrorInfo | null;
      result?: string;
    }) => Promise<TaskResult>;
    acquireLock: (taskId: string, ownerId: string) => Promise<TaskResult>;
    renewLock: (taskId: string, ownerId: string) => Promise<TaskResult>;
    releaseLock: (taskId: string, ownerId: string) => Promise<TaskOperationResult>;
    importCsv: (projectId?: string, filePath?: string) => Promise<CsvImportResult>;
    getPathForDroppedFile: (file: unknown) => string;
    update: (taskId: string, updates: TaskUpdateInput) => Promise<TaskResult>;
    delete: (taskId: string) => Promise<TaskOperationResult>;
    retry: (taskId: string) => Promise<TaskResult>;
    retryAfterQuotaExhaustion: (params: TaskRetryAfterQuotaExhaustionParams) => Promise<TaskResult>;
    retryAfterPreSubmitFailure: (params: TaskRetryAfterPreSubmitFailureParams) => Promise<TaskResult>;
    batchPause: () => Promise<{ success: boolean }>;
    getCompletedOutputs: () => Promise<CompletedOutput[]>;
    selectImages: () => Promise<FileSelectResult>;
    selectVideos: () => Promise<FileSelectResult>;
    selectAudio: () => Promise<AudioSelectResult>;
    selectAudios: () => Promise<FileSelectResult>;
    readFileAsBase64: (filePath: string) => Promise<ReadFileAsBase64Result>;
    prepareVideoPreview: (filePath: string) => Promise<PrepareVideoPreviewResult>;
    downloadOutputs: (outputs: CompletedOutput[], saveDir?: string) => Promise<TaskDownloadOutputsResult>;
    downloadPublicShareMedia: (shareUrl: string, saveDir?: string) => Promise<PublicShareMediaDownloadResult>;
    listDownloads: () => Promise<DownloadJob[]>;
    exportDiagnostics: () => Promise<ExportDiagnosticsResult>;
    validateArtifact: (taskId: string, artifactId: string) => Promise<TaskValidateArtifactResult>;
    saveAdapterReport: (accountId: string, report: AdapterSelfCheckReport) => Promise<{ success: boolean }>;
    selectAdapterRules: () => Promise<TaskSelectAdapterRulesResult>;
    selectSaveDir: () => Promise<SelectSaveDirResult>;
  };

  // ---- Lalor 远程任务通知（只传本地任务 ID，不暴露令牌或租约） ----
  lalorTasks: {
    onTaskAvailable: (handler: (taskId: string) => void) => () => void;
    onTaskCancelled: (handler: (taskId: string) => void) => () => void;
  };

  // ---- 设置 ----
  settings: {
    get: () => Promise<Record<string, any>>;
    save: (settings: Record<string, any>) => Promise<{ success: boolean; error?: string }>;
  };

  // ---- 工作台可选的 Lalor API 配置（Key 仅在主进程安全存储） ----
  workbenchApi: {
    get: () => Promise<WorkbenchApiResult>;
    save: (input: WorkbenchApiSaveInput) => Promise<WorkbenchApiResult>;
    clear: () => Promise<WorkbenchApiResult>;
  };

  // ---- 日志 ----
  logs: {
    list: () => Promise<LogListResult>;
    append: (entry: LogAppendParams) => Promise<LogOperationResult>;
    clear: () => Promise<LogOperationResult>;
  };

  // ---- 本地 Dola 账号池、代理池和 Session 绑定 ----
  localManager: {
    snapshot: () => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    importDolaCk: (item: DolaCkImportItem) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    importDoubaoCk: (item: DoubaoCkImportItem) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    importDolaEmail: (item: DolaEmailImportItem) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    loadDolaCkToAccount: (entryId: string, accountId: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    /** 重新将已保存的 CK 写入其已关联的 Dola Session，不清空 Session 数据。 */
    reloginDolaCk: (entryId: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    deleteDola: (id: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    clearDola: () => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    retestDola: () => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    loadDoubaoCkToAccount: (entryId: string, accountId: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    reloginDoubaoCk: (entryId: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    deleteDoubao: (id: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    clearDoubao: () => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    retestDoubao: () => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    setConcurrency: (value: number) => Promise<LocalManagerResult<{ concurrency: number }>>;
    addProxy: (input: ProxyPoolInput) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    setProxyEnabled: (id: string, enabled: boolean) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    deleteProxy: (id: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    retestProxy: () => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    addSubscription: (input: ProxySubscriptionInput) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    refreshSubscription: (id: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    deleteSubscription: (id: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    bind: (accountId: string, proxyId: string | null) => Promise<LocalManagerResult<SessionBinding>>;
    unbind: (accountId: string) => Promise<LocalManagerResult<LocalManagerSnapshot>>;
    randomAssign: (accountIds: string[], perProxyLimit: number) => Promise<LocalManagerResult<SessionBinding[]>>;
    setRoutingMode: (mode: LocalRoutingMode) => Promise<LocalManagerResult<LocalRoutingMode>>;
    listAssets: () => Promise<LocalManagerResult<LocalAssetMetadata[]>>;
  };

  // ---- Lalor 会员连接与积分发卡 ----
  lalor: {
    status: () => Promise<LalorOperationResult<LalorConnectionStatus>>;
    pair: (code: string) => Promise<LalorOperationResult<LalorConnectionStatus>>;
    refresh: () => Promise<LalorOperationResult<LalorConnectionStatus>>;
    profile: () => Promise<LalorOperationResult<LalorProfile>>;
    catalog: () => Promise<LalorOperationResult<LalorCatalog>>;
    purchase: (productId: string, idempotencyKey: string) => Promise<LalorOperationResult<LalorPurchaseResult>>;
    logout: () => Promise<LalorOperationResult<{ serverRevoked: boolean }>>;
  };

  // ---- Lalor 会员会话与 Dola 账号商城（完整兼容层） ----
  // 令牌和 CK 内容只在主进程处理；渲染进程仅收到脱敏资料和短时交付引用。
  lalorAuth: {
    status: () => Promise<LalorAuthResult<LalorAuthSnapshot>>;
    pair: (code: string) => Promise<LalorAuthResult<LalorAuthSnapshot>>;
    logout: () => Promise<LalorAuthResult<{ ok: boolean }>>;
    catalog: () => Promise<LalorAuthResult<LalorCatalog>>;
    orders: (page?: number, limit?: number) => Promise<LalorAuthResult<LalorOrderPage>>;
    clearOrders: () => Promise<LalorAuthResult<LalorOrderHistoryClearResult>>;
    redownloadOrder: (orderId: string) => Promise<LalorAuthResult<LalorSaveDeliveryResult>>;
    purchaseByPoints: (input: LalorPurchasePointsInput) => Promise<LalorAuthResult<LalorPurchaseResult>>;
    createCashPurchase: (input: LalorCashPurchaseInput) => Promise<LalorAuthResult<LalorPurchaseResult>>;
    getCashOrder: (paymentOrderId: string) => Promise<LalorAuthResult<LalorPurchaseResult>>;
    saveDelivery: (deliveryRef: string) => Promise<LalorAuthResult<LalorSaveDeliveryResult>>;
    importDelivery: (deliveryRef: string) => Promise<LalorAuthResult<LalorImportDeliveryResult>>;
  };

  // ---- 系统操作 ----
  ziziPlugin: ZiziPluginAPI;

  system: {
    updateStatus: () => Promise<SoftwareUpdateState>;
    checkSoftwareUpdate: () => Promise<SoftwareUpdateResult>;
    downloadSoftwareUpdate: () => Promise<SoftwareUpdateResult>;
    installSoftwareUpdate: () => Promise<SoftwareUpdateResult>;
    onSoftwareUpdate: (handler: (state: SoftwareUpdateState) => void) => (() => void);
    getVersion: () => Promise<string>;
    checkIntegrity: () => Promise<IntegrityCheckResult>;
    exportBackup: () => Promise<ExportBackupResult>;
    restoreBackup: () => Promise<RestoreBackupResult>;
    exportProject: (projectId: string) => Promise<ExportProjectResult>;
    checkUpdate: () => Promise<CheckUpdateResult>;
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
  };
}
