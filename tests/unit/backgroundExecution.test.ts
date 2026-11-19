import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('最小化后台执行契约', () => {
  const mainSource = readFileSync(resolve(__dirname, '..', '..', 'main', 'main.ts'), 'utf8');
  const panelSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'BrowserPanel.tsx'), 'utf8');
  const stylesSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'styles', 'global.css'), 'utf8');
  const hydrationSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'utils', 'webviewHydration.ts'), 'utf8');

  it('主窗口关闭后台节流，并为每个账号 guest webview 关闭节流', () => {
    expect(mainSource).toContain('backgroundThrottling: false');
    expect(mainSource).toContain("win.webContents.on('did-attach-webview'");
    expect(mainSource).toContain('guestWebContents.setBackgroundThrottling(false)');
  });

  it('最小化不会卸载 BrowserPanel；只有组件卸载才中止自动化并移除 webview', () => {
    expect(mainSource).toContain('minimizable: true');
    expect(panelSource).toContain("code: 'component_unmounted'");
    expect(panelSource).toContain('registry.forEach((webview) => webview.remove())');
  });

  it('关闭最后一个窗口仍然退出应用，后台策略不改变安全退出边界', () => {
    expect(mainSource).toContain("app.on('window-all-closed'");
    expect(mainSource).toContain('app.quit()');
  });

  it('keeps hidden execution webviews laid out instead of moving them offscreen', () => {
    expect(stylesSource).not.toContain('translate3d(-200vw, 0, 0)');
    expect(hydrationSource).toContain("style.transform = 'translate3d(0, 0, 0)'");
  });
});
