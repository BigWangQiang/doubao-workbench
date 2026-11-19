import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveUserDataLocation } from '../../main/utils/userDataLocation';

const temporary: string[] = [];
function directory(): string { const result = fs.mkdtempSync(path.join(os.tmpdir(), 'lalor-update-data-')); temporary.push(result); return result; }
afterEach((): void => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('升级数据目录兼容', (): void => {
  it('品牌改名仍使用旧包名目录', (): void => {
    const root = directory();
    expect(resolveUserDataLocation(root, undefined)).toBe(path.join(root, 'doubao-studio-desktop'));
  });
  it('记住自定义目录，自动更新无启动参数时仍使用原账号库', (): void => {
    const root = directory();
    const data = path.join(root, 'custom', 'data');
    expect(resolveUserDataLocation(root, data)).toBe(data);
    expect(resolveUserDataLocation(root, undefined)).toBe(data);
  });
  it('迁移旧临时版本路径，只读取已有标记，不移动或覆写用户文件', (): void => {
    const root = directory();
    const legacy = path.join(root, 'legacy');
    const accounts = path.join(legacy, 'DoubaoStudioData', 'accounts.json');
    fs.mkdirSync(path.dirname(accounts), { recursive: true });
    fs.writeFileSync(accounts, '[{"id":"preserve-me"}]');
    expect(resolveUserDataLocation(path.join(root, 'roaming'), undefined, legacy)).toBe(legacy);
    expect(fs.readFileSync(accounts, 'utf8')).toBe('[{"id":"preserve-me"}]');
  });
});
