/**
 * @doubao-studio/contracts
 * 跨进程共享类型契约包 — 仅类型声明，不含运行时 JS。
 *
 * 消费方必须使用 `import type` 导入，禁止普通 import。
 */

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
} from './enums';

export type {
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
} from './domain';

// ==================== IPC DTO ====================

export type {
  AccountOperationResult,
  AccountResult,
  AccountDailyQuotaRefreshResult,
  AccountAddParams,
  AccountUpdateParams,
  AccountIdParams,
  AccountSetStatusParams,
  AccountSetPinnedParams,
  AccountUpdateSeedanceQuotaParams,
  AccountVideoQuotaAction,
  AccountSetVideoQuotaConfigParams,
  AccountHealthAction,
  AccountUpdateHealthParams,
  AccountSetAvailabilityParams,
  AccountUpdateSchedulingParams,
  AccountProxyInput,
  AccountSetProxyParams,
  AccountGetProxyResult,
  DolaProxyResult,
  AccountTestProxyParams,
  AccountTestProxyResult,
} from './dto/accounts';

export type {
  TaskOperationResult,
  TaskResult,
  TaskAddResult,
  TaskAddParams,
  TaskAssignParams,
  TaskUpdateStatusParams,
  TaskRegisterArtifactParams,
  TaskUpdateRuntimeParams,
  TaskAcquireLockParams,
  TaskRenewLockParams,
  TaskReleaseLockParams,
  TaskImportCsvParams,
  TaskUpdateInput,
  TaskUpdateParams,
  TaskIdParams,
  TaskRetryAfterQuotaExhaustionParams,
  TaskRetryAfterPreSubmitFailureParams,
  CsvImportResult,
  CompletedOutput,
  TaskDownloadOutputsParams,
  TaskDownloadOutputsResult,
  PublicShareMediaDownloadResult,
  FileSelectResult,
  AudioSelectResult,
  ReadFileAsBase64Result,
  PrepareVideoPreviewResult,
  SelectSaveDirResult,
  TaskValidateArtifactParams,
  TaskValidateArtifactResult,
  TaskSaveAdapterReportParams,
  TaskSelectAdapterRulesResult,
  AdapterSelfCheckItem,
  AdapterSelfCheckReport,
  AdapterRuleBundle,
  ExportDiagnosticsResult,
} from './dto/tasks';

export type {
  ProjectOperationResult,
  ProjectResult,
  ProjectAddParams,
  ProjectUpdateParams,
  ProjectIdParams,
} from './dto/projects';

export type {
  IntegrityCheckResult,
  ExportBackupResult,
  RestoreBackupResult,
  ExportProjectResult,
  CheckUpdateResult,
} from './dto/system';

export type {
  LogOperationResult,
  LogAppendParams,
  LogListResult,
} from './dto/logs';

export type {
  LocalCheckState,
  LocalRoutingMode,
  ProxyPoolProtocol,
  ProxySubscriptionState,
  DolaCookie,
  DolaPoolEntry,
  DolaCkImportItem,
  DoubaoPoolEntry,
  DoubaoCkImportItem,
  DolaEmailImportItem,
  ProxyPoolEntry,
  ProxyPoolInput,
  ProxySubscriptionInput,
  ProxySubscriptionEntry,
  SessionBinding,
  LocalManagerSnapshot,
  LocalManagerResult,
  LocalAssetMetadata,
  DolaCapabilityPolicy,
} from './dto/localManager';

export type {
  LalorMembership,
  LalorProfile,
  LalorAuthSnapshot,
  LalorAuthResult,
  LalorPairingCode,
  LalorCatalogProduct,
  LalorCatalog,
  LalorPaymentOrder,
  LalorDeliveryMetadata,
  LalorPurchaseResult,
  LalorOrder,
  LalorOrderPage,
  LalorOrderHistoryClearResult,
  LalorPurchasePointsInput,
  LalorCashPurchaseInput,
  LalorSaveDeliveryResult,
  LalorImportDeliveryResult,
} from './dto/lalorAuth';

// 保留旧版 Lalor IPC 的操作结果契约，供已有界面/调用方兼容。
export type {
  LalorConnectionStatus,
  LalorOperationResult,
} from './dto/lalor';

export type { ElectronAPI } from './dto/electron-api';
export type { WorkbenchApiConfig, WorkbenchApiSaveInput, WorkbenchApiResult } from './dto/workbench';
export type { SoftwareUpdatePhase, SoftwareUpdateState, SoftwareUpdateResult } from './dto/softwareUpdate';
export type { StoryboardInput, StoryboardRow, StoryboardRowState, StoryboardBatchInput, StoryboardBatch, StoryboardBatchAPI } from './storyboardBatch';
export type { ZiziConnectionState, ZiziPluginStatus, ZiziPluginSaveResult, ZiziPluginAPI } from './dto/ziziPlugin';
