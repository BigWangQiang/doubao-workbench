import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('豆包 CK 独立入口', () => {
  it('侧边栏、工作区路由和账号池视图保持同一入口合同', () => {
    const rail = readFileSync(resolve(__dirname, '../../src/components/WorkspaceRail.tsx'), 'utf8');
    const app = readFileSync(resolve(__dirname, '../../src/App.tsx'), 'utf8');
    const manager = readFileSync(resolve(__dirname, '../../src/components/LocalManagerModal.tsx'), 'utf8');

    expect(rail).toContain("'doubao-login'");
    expect(rail).toContain("label: '豆包登录'");
    expect(app).toContain("activeWorkspacePane === 'doubao-login'");
    expect(app).toContain('view="doubao"');
    expect(manager).toContain("view === 'doubao'");
    expect(manager).toContain('managerTabs[1].children');
  });

  it('豆包和 Dola 的任务表单都展示 30 秒选项', () => {
    const taskConsole = readFileSync(resolve(__dirname, '../../src/components/TaskConsole.tsx'), 'utf8');
    expect(taskConsole).toContain("const durations = [...STANDARD_VIDEO_DURATIONS, '30s' as const]");
    expect(taskConsole).not.toContain("platform === 'doubao' && next.duration === '30s'");
  });
});
