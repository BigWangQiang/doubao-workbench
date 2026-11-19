import { describe, expect, it } from 'vitest';
import {
  cookieHeader,
  cookieExpiryIsUsable,
  maskDolaEmail,
  normalizeDolaCkJson,
  normalizeDolaCkJsonEntries,
  parseDolaEmailCredentials,
  parseDolaCkTextEntries,
  parseDolaCkJsonText,
} from '../../main/utils/dolaCkJson';

const COOKIE = {
  name: 'sessionid',
  value: 'secret-value',
  domain: '.dola.com',
  path: '/',
  secure: true,
};

describe('Dola CK JSON parser', () => {
  it('accepts a direct cookie array', () => {
    const result = normalizeDolaCkJson([COOKIE]);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]).toMatchObject({ name: 'sessionid', domain: '.dola.com' });
  });

  it('accepts an object with cookies array', () => {
    expect(normalizeDolaCkJson({ cookies: [COOKIE] }).cookies).toHaveLength(1);
  });

  it('保留 Chrome 导出的 expires 字段，避免 CK 重启后退化为会话 Cookie', () => {
    const expires = 1_790_000_000;
    const result = normalizeDolaCkJson([{ ...COOKIE, expires, session: false }]);
    expect(result.cookies[0].expirationDate).toBe(expires);
  });

  it('保留 Chrome 导出的 session Cookie，不把 expires=-1 当作失效 Cookie', () => {
    const result = normalizeDolaCkJson([{ ...COOKIE, expires: -1, session: true }]);
    expect(result.cookies[0]).not.toHaveProperty('expirationDate');
  });

  it('splits an object keyed by two accounts into two independent CK entries', () => {
    const result = normalizeDolaCkJsonEntries({ first: [COOKIE], second: [{ ...COOKIE, name: 'sessionid2' }] });
    expect(result.map((entry) => entry.label)).toEqual(['CK 1', 'CK 2']);
    expect(result.map((entry) => entry.cookies.length)).toEqual([1, 1]);
  });

  it('parses the required account----password format without exposing values', () => {
    const result = parseDolaEmailCredentials('a@example.com----one\nb@example.com----two');
    expect(result.map((item) => item.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(result.map((item) => item.password)).toEqual(['one', 'two']);
    expect(() => parseDolaEmailCredentials('a@example.com')).toThrow('账号----密码');
  });

  it('parses JSON text and deduplicates the same cookie key', () => {
    const result = parseDolaCkJsonText(JSON.stringify({ cookies: [COOKIE, COOKIE] }));
    expect(result.cookies).toHaveLength(1);
    expect(cookieHeader(result.cookies)).toBe('sessionid=secret-value');
  });

  it('splits each non-empty TXT line into an independent Cookie Header account', () => {
    const result = parseDolaCkTextEntries('\uFEFFsessionid=first=token; theme=dark\n\nsessionid=second; theme=light');
    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.label)).toEqual(['CK 1', 'CK 2']);
    expect(result[0].cookies).toEqual([
      expect.objectContaining({ name: 'sessionid', value: 'first=token', domain: '.dola.com' }),
      expect.objectContaining({ name: 'theme', value: 'dark', domain: '.dola.com' }),
    ]);
  });

  it('keeps JSON text compatible and rejects malformed TXT cookie segments', () => {
    expect(parseDolaCkTextEntries(JSON.stringify({ cookies: [COOKIE] }))).toHaveLength(1);
    expect(() => parseDolaCkTextEntries('sessionid=valid; malformed')).toThrow('第 1 行第 2 项名称无效');
  });

  it.each([
    ['empty', []],
    ['missing domain', [{ name: 'x', value: 'y' }]],
    ['invalid domain', [{ ...COOKIE, domain: 'https://dola.com' }]],
  ])('rejects %s input', (_label, value) => {
    expect(() => normalizeDolaCkJson(value)).toThrow();
  });

  it('masks email and checks cookie expiry without exposing the value', () => {
    expect(maskDolaEmail('alice@example.com')).toBe('al***@example.com');
    expect(cookieExpiryIsUsable({ ...COOKIE, expirationDate: 1 }, 2_000)).toBe(false);
    expect(cookieExpiryIsUsable(COOKIE)).toBe(true);
  });
});
