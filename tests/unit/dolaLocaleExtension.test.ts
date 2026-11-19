import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOLA_LOCALE_COOKIE_DOMAINS,
  DOLA_LOCALE_COOKIE_NAMES,
  DOLA_LOCALE_PRELOAD_SCRIPT,
  dolaLocaleCookieUrl,
  isDolaLocaleCookie,
} from '../../main/utils/dolaLocalePreload';

const browserPanelSource = readFileSync(resolve(process.cwd(), 'src/components/BrowserPanel.tsx'), 'utf8');

describe('Dola locale extension refresh guard', () => {
  it('只识别 Dola 语言 Cookie，并能按原 domain/path 生成删除地址', () => {
    expect(DOLA_LOCALE_COOKIE_NAMES).toContain('i18next');
    expect(DOLA_LOCALE_COOKIE_DOMAINS).toEqual(expect.arrayContaining([undefined, '.dola.com', '.www.dola.com']));
    expect(isDolaLocaleCookie({ name: 'i18next', domain: '.www.dola.com' })).toBe(true);
    expect(isDolaLocaleCookie({ name: 'sessionid', domain: '.www.dola.com' })).toBe(false);
    expect(isDolaLocaleCookie({ name: 'i18next', domain: '.example.com' })).toBe(false);
    expect(dolaLocaleCookieUrl({ domain: '.www.dola.com', path: '/chat' })).toBe('https://www.dola.com/chat');
    expect(dolaLocaleCookieUrl({ domain: undefined, path: '/' })).toBe('https://www.dola.com/');
  });

  it('提供文档前主世界初始化且不拦截页面事件', () => {
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain('localStorage.setItem');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain('document.cookie');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain('clearLocaleCookies');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain('Domain=');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain('.www.dola.com');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain("return 'zh-CN'");
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain("return ['zh-CN', 'zh']");
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).toContain('__lalorDolaLocaleBootstrapV1');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).not.toContain('Location.prototype');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).not.toContain('Storage.prototype');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).not.toContain('addEventListener');
    expect(DOLA_LOCALE_PRELOAD_SCRIPT).not.toMatch(/event\.type\s*===\s*['"](?:input|beforeinput|keydown|keyup)['"]/);
  });

  it('网络桥不再通过 dom-ready 重复补注入', () => {
    const networkSource = readFileSync(resolve(process.cwd(), 'main/utils/dolaExtensionNetwork.ts'), 'utf8');
    expect(networkSource).not.toContain("contents.on('dom-ready'");
    expect(networkSource).not.toContain("injectDolaLocaleGuard(contents, 'dom-ready')");
    expect(networkSource).toContain('localeGuardInjectionAttempted');
  });

  it('Dola 可用性检查和任务初始化不触发豆包推广弹窗清理器', () => {
    expect(browserPanelSource).toContain("account.platform !== 'dola' && !isDolaUrl(currentUrl)");
    expect(browserPanelSource).toContain('availabilityCheckRunning');
    expect(browserPanelSource).toContain('dolaStartupAvailabilityScheduled');
    expect(browserPanelSource).toContain("targetPlatform === 'dola' || currentAccount?.platform === 'dola' || isDolaUrl(currentUrl)");
  });
});
