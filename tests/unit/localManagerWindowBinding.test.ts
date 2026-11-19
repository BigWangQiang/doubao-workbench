import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('窗口绑定展示', () => {
  const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'LocalManagerModal.tsx'), 'utf8');

  it('绑定列表展示窗口名称，不把 UUID 作为用户可见标题', () => {
    expect(source).toContain("title: '窗口名称'");
    expect(source).toContain("accounts.find((account) => account.id === value)?.name || '未命名窗口'");
    expect(source).not.toContain("{ title: '账号 ID', dataIndex: 'accountId', key: 'accountId' }");
  });

  it('解绑仍使用内部 accountId，不改变绑定数据契约', () => {
    expect(source).toContain('onClick={() => void unbind(row.accountId)}');
    expect(source).toContain('rowKey="accountId"');
  });
});
