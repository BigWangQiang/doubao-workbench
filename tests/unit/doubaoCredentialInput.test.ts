import { describe, expect, it } from 'vitest';
import { splitDoubaoCkJsonEntries, splitDoubaoCkTxtEntries } from '../../src/utils/doubaoCredentialInput';

describe('renderer Doubao CK import input parsing', () => {
  it('splits a top-level cookie array into one import item', () => {
    expect(splitDoubaoCkJsonEntries([{ name: 'sid' }], 'doubao')).toEqual([
      { label: 'doubao 1', source: 'ck_json', ckJson: [{ name: 'sid' }] },
    ]);
  });

  it('splits object-keyed accounts', () => {
    const result = splitDoubaoCkJsonEntries({ first: [{ name: 'a' }], second: [{ name: 'b' }] }, 'ck');
    expect(result.map((item) => item.label)).toEqual(['ck 1', 'ck 2']);
  });

  it('recognizes JSON stored in a TXT file', () => {
    expect(splitDoubaoCkTxtEntries(JSON.stringify({ cookies: [{ name: 'sid' }] }), 'ck')).toHaveLength(1);
  });

  it('splits ordinary TXT cookie header lines', () => {
    expect(splitDoubaoCkTxtEntries('sid=one\nsid=two', 'ck').map((item) => item.ckJson)).toEqual(['sid=one', 'sid=two']);
  });
});

