export type SoftwareUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'latest' | 'error' | 'installing' | 'unsupported';

export interface SoftwareUpdateState {
  phase: SoftwareUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  progress: number;
  message: string;
  checkedAt?: string;
  /** 本次版本的变更摘要；不包含账号、CK 或本地任务数据。 */
  releaseNotes?: string;
  /** 安装前给用户的操作说明。 */
  userInstructions?: string;
}

export interface SoftwareUpdateResult {
  success: boolean;
  state: SoftwareUpdateState;
  error?: string;
}
