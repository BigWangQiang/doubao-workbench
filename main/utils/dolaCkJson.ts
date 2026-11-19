import type { DolaCookie } from '@doubao-studio/contracts';

const MAX_COOKIE_COUNT = 256;
const MAX_COOKIE_VALUE_LENGTH = 16 * 1024;
const MAX_CK_TEXT_ENTRIES = 500;
const DEFAULT_DOLA_COOKIE_DOMAIN = '.dola.com';
const DOMAIN_PATTERN = /^\.?[A-Za-z0-9][A-Za-z0-9.-]{0,251}$/;

export interface DolaCkParseResult {
  cookies: DolaCookie[];
}

export interface DolaCkEntryParseResult extends DolaCkParseResult {
  label: string;
}

export interface DolaEmailCredential {
  email: string;
  password: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeSameSite(value: unknown): DolaCookie['sameSite'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase().replace(/[-_]/g, '');
  if (normalized === 'none' || normalized === 'norestriction') return 'no_restriction';
  if (normalized === 'lax') return 'lax';
  if (normalized === 'strict') return 'strict';
  if (normalized === 'unspecified') return 'unspecified';
  return undefined;
}

function normalizeExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeCookie(value: unknown, index: number): DolaCookie {
  const record = asRecord(value);
  if (!record) throw new Error(`CK JSON 第 ${index + 1} 项不是对象`);

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const cookieValue = typeof record.value === 'string' ? record.value : '';
  const domainValue = typeof record.domain === 'string' ? record.domain.trim().toLowerCase() : '';
  if (!name || !/^[^\s;=]{1,256}$/.test(name)) throw new Error(`CK JSON 第 ${index + 1} 项的 name 无效`);
  if (cookieValue.length > MAX_COOKIE_VALUE_LENGTH) throw new Error(`CK JSON 第 ${index + 1} 项的 value 过长`);
  if (!domainValue || !DOMAIN_PATTERN.test(domainValue)) throw new Error(`CK JSON 第 ${index + 1} 项的 domain 无效`);

  const path = typeof record.path === 'string' && record.path.startsWith('/') ? record.path.slice(0, 2048) : '/';
  // Chrome/Chromium 导出通常使用 `expires`（Unix 秒）；保留有效值，
  // 否则导入后的 Cookie 会被误当成仅本次运行有效的会话 Cookie。
  // `session=true, expires=-1` 是合法的会话 Cookie，不应被当成过期项丢弃。
  const explicitExpiry = record.expirationDate ?? record.expiry ?? record.expiration;
  const normalizedExplicitExpiry = normalizeExpiry(explicitExpiry);
  const normalizedChromeExpiry = normalizeExpiry(record.expires);
  const expiry = normalizedExplicitExpiry ?? (
    normalizedChromeExpiry !== undefined && normalizedChromeExpiry > 0
      ? normalizedChromeExpiry
      : undefined
  );
  const cookie: DolaCookie = {
    name,
    value: cookieValue,
    domain: domainValue,
    path,
    secure: record.secure !== false,
    httpOnly: record.httpOnly === true,
    ...(expiry !== undefined ? { expirationDate: expiry } : {}),
    ...(normalizeSameSite(record.sameSite) ? { sameSite: normalizeSameSite(record.sameSite) } : {}),
  };
  return cookie;
}

/**
 * Normalize common browser cookie export shapes without logging the secret.
 * Supported shapes are a direct array or an object with a cookies array.
 */
export function normalizeDolaCkJson(raw: unknown): DolaCkParseResult {
  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else {
    const record = asRecord(raw);
    if (!record || !Array.isArray(record.cookies)) throw new Error('CK JSON 必须是 Cookie 数组或包含 cookies 数组的对象');
    items = record.cookies;
  }
  if (items.length === 0) throw new Error('CK JSON 不能为空');
  if (items.length > MAX_COOKIE_COUNT) throw new Error(`CK JSON Cookie 数量不能超过 ${MAX_COOKIE_COUNT}`);

  const cookies = items.map((item, index) => normalizeCookie(item, index));
  const unique = new Map<string, DolaCookie>();
  for (const cookie of cookies) unique.set(`${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`, cookie);
  return { cookies: [...unique.values()] };
}

/**
 * 兼容导出工具把多个账号放在对象键下的格式：
 * { "account-a": [cookie...], "account-b": [cookie...] }。
 * 标签使用稳定序号，避免把手机号/账号键写入 UI 或日志。
 */
export function normalizeDolaCkJsonEntries(raw: unknown): DolaCkEntryParseResult[] {
  if (Array.isArray(raw)) return [{ label: 'CK 1', cookies: normalizeDolaCkJson(raw).cookies }];
  const record = asRecord(raw);
  if (!record) throw new Error('CK JSON 必须是 Cookie 数组或账号对象');
  if (Array.isArray(record.cookies)) return [{ label: 'CK 1', cookies: normalizeDolaCkJson(record).cookies }];
  const entries = Object.values(record);
  if (entries.length === 0) throw new Error('CK JSON 未包含账号 Cookie');
  return entries.map((value, index) => ({
    label: `CK ${index + 1}`,
    cookies: normalizeDolaCkJson(value).cookies,
  }));
}

export function parseDolaCkJsonText(text: string): DolaCkParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('CK JSON 文件为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('CK JSON 格式无效');
  }
  return normalizeDolaCkJson(parsed);
}

/** 解析商城或文件导入的原始 CK JSON 文本，并保留多账号分组。 */
export function parseDolaCkJsonTextEntries(text: string): DolaCkEntryParseResult[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('CK JSON 文本为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('CK JSON 文本格式无效');
  }
  return normalizeDolaCkJsonEntries(parsed);
}

/** 将每行一套的 Cookie Header 文本拆成独立 Dola CK。 */
export function parseDolaCkHeaderTextEntries(text: string): DolaCkEntryParseResult[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('CK TXT 文件为空');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > MAX_CK_TEXT_ENTRIES) throw new Error(`CK TXT 一次最多导入 ${MAX_CK_TEXT_ENTRIES} 个账号`);

  return lines.map((line, lineIndex) => {
    const segments = line.split(';').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) throw new Error(`CK TXT 第 ${lineIndex + 1} 行为空`);
    if (segments.length > MAX_COOKIE_COUNT) {
      throw new Error(`CK TXT 第 ${lineIndex + 1} 行 Cookie 数量不能超过 ${MAX_COOKIE_COUNT}`);
    }
    const cookies = segments.map((segment, cookieIndex) => {
      const separator = segment.indexOf('=');
      const name = separator > 0 ? segment.slice(0, separator).trim() : '';
      const value = separator > 0 ? segment.slice(separator + 1).trim() : '';
      if (!name || !/^[^\s;=]{1,256}$/.test(name)) {
        throw new Error(`CK TXT 第 ${lineIndex + 1} 行第 ${cookieIndex + 1} 项名称无效`);
      }
      if (value.length > MAX_COOKIE_VALUE_LENGTH) {
        throw new Error(`CK TXT 第 ${lineIndex + 1} 行第 ${cookieIndex + 1} 项内容过长`);
      }
      return {
        name,
        value,
        domain: DEFAULT_DOLA_COOKIE_DOMAIN,
        path: '/',
        secure: true,
      };
    });
    return { label: `CK ${lineIndex + 1}`, cookies: normalizeDolaCkJson(cookies).cookies };
  });
}

/** JSON 继续走原解析器；TXT 使用每行一套 Cookie Header 的格式。 */
export function parseDolaCkTextEntries(text: string): DolaCkEntryParseResult[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('CK 文本为空');
  const normalized = text.replace(/^\uFEFF/, '').trim();
  return normalized.startsWith('{') || normalized.startsWith('[')
    ? parseDolaCkJsonTextEntries(normalized)
    : parseDolaCkHeaderTextEntries(normalized);
}

export function parseDolaEmailCredentials(text: string): DolaEmailCredential[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('邮箱账号不能为空');
  const lines = text.split(/[\r\n,，;；]+/).map((line) => line.trim()).filter(Boolean);
  const result: DolaEmailCredential[] = [];
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf('----');
    if (separator <= 0 || separator + 4 >= line.length) {
      throw new Error(`第 ${index + 1} 行必须使用“账号----密码”格式`);
    }
    const email = line.slice(0, separator).trim();
    const password = line.slice(separator + 4).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`第 ${index + 1} 行邮箱格式无效`);
    if (!password) throw new Error(`第 ${index + 1} 行密码不能为空`);
    result.push({ email, password });
  }
  return result;
}

export function maskDolaEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '***';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function cookieHeader(cookies: readonly DolaCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function cookieExpiryIsUsable(cookie: DolaCookie, nowMs = Date.now()): boolean {
  if (cookie.expirationDate === undefined) return true;
  const expiryMs = cookie.expirationDate < 10_000_000_000
    ? cookie.expirationDate * 1000
    : cookie.expirationDate;
  return expiryMs > nowMs;
}
