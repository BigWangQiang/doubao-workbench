import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { publishLocalControlDiscovery } from '../../main/utils/localControlDiscovery';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('插件连接发现', () => {
  it('自定义目录和旧插件标准目录指向同一服务，退出时清理本次入口', () => {
    const root = mkdtempSync(join(tmpdir(), 'lalor-discovery-')); roots.push(root);
    const info = { protocolVersion: 'v1', address: '127.0.0.1', port: 50001, pid: 123,
      tokenFile: 'control-token', startedAt: 'start', expiresAt: 'end' } as const;
    const clean = publishLocalControlDiscovery(join(root, 'custom'), join(root, 'appdata'), 'private-token', info);
    for (const directory of [join(root, 'custom/DoubaoStudioControl'), join(root, 'appdata/doubao-studio-desktop/DoubaoStudioControl')]) {
      expect(JSON.parse(readFileSync(join(directory, 'control-info.json'), 'utf8'))).toEqual(info);
      expect(readFileSync(join(directory, 'control-token'), 'utf8')).toBe('private-token');
    }
    const newer = join(root, 'appdata/doubao-studio-desktop/DoubaoStudioControl/control-info.json');
    writeFileSync(newer, JSON.stringify({ ...info, pid: 456 }));
    clean();
    expect(existsSync(join(root, 'custom/DoubaoStudioControl/control-info.json'))).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });
});
