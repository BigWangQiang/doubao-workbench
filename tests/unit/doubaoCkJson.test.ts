import { describe, expect, it } from 'vitest';
import { parseDoubaoCkJsonTextEntries, parseDoubaoCkTextEntries } from '../../main/utils/doubaoCkJson';

const COOKIE = { name: 'sessionid', value: 'masked', domain: '.doubao.com', path: '/', secure: true };

describe('Doubao CK JSON/TXT parser', () => {
  it('keeps one top-level cookie array as one account', () => {
    const result = parseDoubaoCkJsonTextEntries(JSON.stringify([COOKIE]));
    expect(result).toHaveLength(1);
    expect(result[0].cookies[0]).toMatchObject({ domain: '.doubao.com' });
  });

  it('splits object-keyed JSON accounts', () => {
    const result = parseDoubaoCkJsonTextEntries(JSON.stringify({ first: [COOKIE], second: [{ ...COOKIE, name: 'sid2' }] }));
    expect(result.map((entry) => entry.label)).toEqual(['CK 1', 'CK 2']);
  });

  it('splits array-of-arrays exports into separate accounts', () => {
    const result = parseDoubaoCkJsonTextEntries(JSON.stringify([[COOKIE], [{ ...COOKIE, name: 'sid2' }]]));
    expect(result).toHaveLength(2);
    expect(result[1].cookies[0]).toMatchObject({ name: 'sid2', domain: '.doubao.com' });
  });

  it('parses JSON content saved with a TXT extension', () => {
    expect(parseDoubaoCkTextEntries(`\n${JSON.stringify({ cookies: [COOKIE] })}\n`)).toHaveLength(1);
  });

  it('splits Cookie Header TXT lines', () => {
    const result = parseDoubaoCkTextEntries('sessionid=one; theme=dark\nsessionid=two; theme=light');
    expect(result).toHaveLength(2);
    expect(result[1].cookies[0]).toMatchObject({ name: 'sessionid', value: 'two', domain: '.doubao.com' });
  });

  it('rejects a non-Doubao cookie export', () => {
    expect(() => parseDoubaoCkJsonTextEntries(JSON.stringify([{ ...COOKIE, domain: '.dola.com' }]))).toThrow('doubao.com');
  });
});
