import { safeStorage } from 'electron';
import type { LalorProfile } from '@doubao-studio/contracts';
import { deleteJSON, readJSON, writeJSON } from './store';
import type { SignedDesktopGrant } from '../security/desktopSecurity';

const SESSION_FILE = 'lalor-desktop-session.json';

export interface LalorStoredSession {
  entitlement?: SignedDesktopGrant;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  profile: LalorProfile;
}

interface PersistedSession {
  version: 1;
  encrypted: string;
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function loadLalorSession(): LalorStoredSession | null {
  const stored = readJSON<PersistedSession | null>(SESSION_FILE, null);
  if (!stored || stored.version !== 1 || !stored.encrypted || !encryptionAvailable()) return null;
  try {
    const raw = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'));
    const value = JSON.parse(raw) as Partial<LalorStoredSession>;
    if (!value.accessToken || !value.refreshToken || !value.accessExpiresAt || !value.refreshExpiresAt || !value.profile) return null;
    return value as LalorStoredSession;
  } catch {
    return null;
  }
}

export function saveLalorSession(session: LalorStoredSession): void {
  if (!encryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 Lalor 登录状态');
  const encrypted = safeStorage.encryptString(JSON.stringify(session)).toString('base64');
  if (!writeJSON(SESSION_FILE, { version: 1, encrypted } satisfies PersistedSession)) {
    throw new Error('Lalor 登录状态写入失败');
  }
}

export function clearLalorSession(): void {
  deleteJSON(SESSION_FILE);
}




