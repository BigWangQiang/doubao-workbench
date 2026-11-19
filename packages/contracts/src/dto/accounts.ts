/**
 * @doubao-studio/contracts — 账号 IPC DTO
 *
 * 账号管理 IPC 的参数和返回值类型。
 * 复用 domain 中的领域模型，不引入运行时值。
 */

import type { Account, AccountAvailability, AccountProxyConfig, AccountProxyProtocol, AccountScheduling } from '../domain';
import type { AccountPlatform, AccountStatus } from '../enums';

// ==================== 通用返回值 ====================

/** 账号操作简单结果（无数据返回） */
export interface AccountOperationResult {
  success: boolean;
  error?: string;
}

/** 账号操作结果（包含账号数据） */
export interface AccountResult {
  success: boolean;
  account?: Account;
  error?: string;
}

/** 按本机自然日刷新所有账号额度后的轻量结果。 */
export interface AccountDailyQuotaRefreshResult {
  success: boolean;
  accounts?: Account[];
  refreshedAt?: string;
  error?: string;
}

// ==================== IPC 参数 DTO ====================

export interface AccountAddParams {
  name: string;
  platform?: AccountPlatform;
}

export interface AccountUpdateParams {
  id: string;
  name: string;
}

export interface AccountIdParams {
  id: string;
}

export interface AccountSetStatusParams {
  id: string;
  status: AccountStatus;
}

export interface AccountSetPinnedParams {
  id: string;
  pinned: boolean;
}

export type AccountVideoQuotaAction = 'consume' | 'exhausted' | 'reset';

export interface AccountUpdateSeedanceQuotaParams {
  id: string;
  action: AccountVideoQuotaAction;
  units?: number;
}

/** 用户为单个豆包或 Dola 账号设置的视频额度规则。 */
export interface AccountSetVideoQuotaConfigParams {
  id: string;
  totalUnits: number;
  costPerVideoUnits: number;
}

/** 账号健康状态更新动作 */
export type AccountHealthAction = 'success' | 'failure' | 'verification' | 'login_expired' | 'clear';

export interface AccountUpdateHealthParams {
  id: string;
  action: AccountHealthAction;
  /**
   * 错误码。保持 string，不收紧为 TaskErrorCode，
   * 因为历史 JSON 和 IPC 传入的值可能包含未知错误码。
   */
  errorCode?: string;
}

export interface AccountSetAvailabilityParams {
  id: string;
  availability: AccountAvailability;
}

export interface AccountUpdateSchedulingParams {
  id: string;
  updates: Partial<AccountScheduling>;
}

/** 代理配置写入参数；password 仅在 IPC 请求中短暂传递，不会回传。 */
export interface AccountProxyInput {
  enabled: boolean;
  protocol: AccountProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  clearCredentials?: boolean;
}

export interface AccountSetProxyParams {
  id: string;
  proxy: AccountProxyInput;
}

export interface AccountGetProxyResult {
  success: boolean;
  proxy?: AccountProxyConfig;
  username?: string;
  error?: string;
}

/** Dola 全局代理写入结果；配置会应用到所有 Dola 账号 Session。 */
export type DolaProxyResult = AccountGetProxyResult;

export interface AccountTestProxyParams {
  proxy: AccountProxyInput;
}

export interface AccountTestProxyResult {
  success: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}
