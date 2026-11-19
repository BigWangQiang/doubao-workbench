import type { DolaCookie } from '@doubao-studio/contracts';
import type { DolaCkEntryParseResult } from './dolaCkJson';
import { normalizeDolaCkJson, normalizeDolaCkJsonEntries } from './dolaCkJson';

/** 豆包 Cookie 导出的默认域；JSON 导出中的具体子域会原样保留。 */
const DEFAULT_DOUBAO_COOKIE_DOMAIN = '.doubao.com';
const MAX_COOKIE_VALUE_LENGTH = 16 * 1024;
const MAX_CK_TEXT_ENTRIES = 500;

function isDoubaoDomain(value: string | undefined): boolean {
  const domain = String(value || '').trim().toLowerCase().replace(/^\./, '');
  return domain === 'doubao.com' || domain.endsWith('.doubao.com');
}

function assertDoubaoCookies(entries: readonly DolaCkEntryParseResult[]): DolaCkEntryParseResult[] {
  if (entries.length === 0) throw new Error('豆包 CK 未包含账号 Cookie');
  if (entries.length > MAX_CK_TEXT_ENTRIES) throw new Error(`豆包 CK 一次最多导入 ${MAX_CK_TEXT_ENTRIES} 个账号`);
  for (const entry of entries) {
    if (!entry.cookies.some((cookie) => isDoubaoDomain(cookie.domain))) {
      throw new Error('豆包 CK 未包含 doubao.com Cookie，已阻止导入');
    }
  }
  return [...entries];
}

function normalizeDoubaoEntries(raw: unknown): DolaCkEntryParseResult[] {
  // 部分导出工具用“数组套数组”表示多个账号；共享 Dola 解析器会把
  // 顶层数组当成一套 Cookie，因此在豆包边界先拆开每个账号。
  if (Array.isArray(raw) && raw.length > 0 && raw.every((value) => Array.isArray(value))) {
    return raw.map((value, index) => ({
      label: `CK ${index + 1}`,
      cookies: normalizeDolaCkJson(value).cookies,
    }));
  }
  return normalizeDolaCkJsonEntries(raw);
}

function parseHeaderLine(line: string, lineIndex: number): DolaCkEntryParseResult {
  const segments = line.split(';').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error(`豆包 CK TXT 第 ${lineIndex + 1} 行为空`);
  const cookies: DolaCookie[] = segments.map((segment, cookieIndex) => {
    const separator = segment.indexOf('=');
    const name = separator > 0 ? segment.slice(0, separator).trim() : '';
    const value = separator > 0 ? segment.slice(separator + 1).trim() : '';
    if (!name || !/^[^\s;=]{1,256}$/.test(name)) {
      throw new Error(`豆包 CK TXT 第 ${lineIndex + 1} 行第 ${cookieIndex + 1} 项名称无效`);
    }
    if (value.length > MAX_COOKIE_VALUE_LENGTH) {
      throw new Error(`豆包 CK TXT 第 ${lineIndex + 1} 行第 ${cookieIndex + 1} 项内容过长`);
    }
    return {
      name,
      value,
      domain: DEFAULT_DOUBAO_COOKIE_DOMAIN,
      path: '/',
      secure: true,
    };
  });
  return { label: `CK ${lineIndex + 1}`, cookies: normalizeDolaCkJson(cookies).cookies };
}

/** 解析一个豆包 JSON 文本，并保留对象键下的多账号分组。 */
export function parseDoubaoCkJsonTextEntries(text: string): DolaCkEntryParseResult[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('豆包 CK JSON 文本为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '').trim()) as unknown;
  } catch {
    throw new Error('豆包 CK JSON 文本格式无效');
  }
  return assertDoubaoCookies(normalizeDoubaoEntries(parsed));
}

/**
 * 解析豆包 CK 的 JSON/TXT 输入。
 * TXT 优先按完整 JSON 解析，因此把 JSON 内容保存为 .txt 也能自动拆分；
 * 只有不是 JSON 时才按“每行一套 Cookie Header”处理。
 */
export function parseDoubaoCkTextEntries(text: string): DolaCkEntryParseResult[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('豆包 CK 文本为空');
  const normalized = text.replace(/^\uFEFF/, '').trim();
  if (/^[\[{]/.test(normalized)) return parseDoubaoCkJsonTextEntries(normalized);

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > MAX_CK_TEXT_ENTRIES) throw new Error(`豆包 CK TXT 一次最多导入 ${MAX_CK_TEXT_ENTRIES} 个账号`);
  return assertDoubaoCookies(lines.map((line, index) => parseHeaderLine(line, index)));
}
