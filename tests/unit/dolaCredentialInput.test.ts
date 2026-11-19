import { describe, expect, it } from 'vitest';
import { parseDolaEmailCredentialInput, splitDolaCkJsonEntries, splitDolaCkTxtEntries } from '../../src/utils/dolaCredentialInput';

describe('renderer Dola import input parsing', () => {
  it('splits object-keyed CK exports into stable labels', () => {
    const result = splitDolaCkJsonEntries({ one: [{ name: 'a' }], two: [{ name: 'b' }] }, '1-2');
    expect(result.map((item) => ({ label: item.label, source: item.source }))).toEqual([
      { label: '1-2 1', source: 'ck_json' },
      { label: '1-2 2', source: 'ck_json' },
    ]);
  });

  it('splits every non-empty TXT line into an independent import item', () => {
    const result = splitDolaCkTxtEntries('\uFEFFa=one; b=two\n\na=three; b=four', 'ck10');
    expect(result).toEqual([
      { label: 'ck10 1', source: 'ck_txt', ckJson: 'a=one; b=two' },
      { label: 'ck10 2', source: 'ck_txt', ckJson: 'a=three; b=four' },
    ]);
  });

  it('parses one credential per line', () => {
    expect(parseDolaEmailCredentialInput('a@example.com----p1\nb@example.com----p2')).toEqual([
      { email: 'a@example.com', password: 'p1' },
      { email: 'b@example.com', password: 'p2' },
    ]);
  });
});
