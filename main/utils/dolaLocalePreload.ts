/** Dola 语言 Cookie 的最小白名单；其他 Cookie 一律不触碰。 */
export const DOLA_LOCALE_COOKIE_NAMES = [
  'i18nextLng',
  'user_language_code',
  'browser_language',
  'i18next',
] as const;

/** 页面可能遗留的域名变体；undefined 表示当前 host-only Cookie。 */
export const DOLA_LOCALE_COOKIE_DOMAINS: ReadonlyArray<string | undefined> = [
  undefined,
  '.dola.com',
  '.www.dola.com',
];

export const DOLA_LOCALE_COOKIE_VALUE = 'zh';
export const DOLA_LOCALE_COOKIE_MAX_AGE_SECONDS = 31_536_000;

export interface DolaLocaleCookieLike {
  name: string;
  value?: string;
  domain?: string;
  path?: string;
}

export function normalizeDolaCookieDomain(domain: string | undefined): string {
  return String(domain || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
}

export function isDolaHostname(hostname: string): boolean {
  const normalized = normalizeDolaCookieDomain(hostname);
  return normalized === 'dola.com' || normalized.endsWith('.dola.com');
}

export function isDolaLocaleCookie(cookie: DolaLocaleCookieLike): boolean {
  return DOLA_LOCALE_COOKIE_NAMES.includes(cookie.name as (typeof DOLA_LOCALE_COOKIE_NAMES)[number])
    && isDolaHostname(cookie.domain || 'www.dola.com');
}

/** 生成能精确命中 Electron Cookie domain/path 的删除 URL。 */
export function dolaLocaleCookieUrl(cookie: Pick<DolaLocaleCookieLike, 'domain' | 'path'>): string {
  const domain = normalizeDolaCookieDomain(cookie.domain) || 'www.dola.com';
  const cookiePath = cookie.path && cookie.path.startsWith('/') ? cookie.path : `/${cookie.path || ''}`;
  return `https://${domain}${cookiePath === '/' ? '/' : cookiePath}`;
}

/**
 * Dola 文档前语言初始化脚本。
 *
 * 这里只写入一次性语言状态，不改写 Location、History、Storage 原型，
 * 也不拦截任何页面事件。这样页面自己的登录、输入和路由生命周期保持
 * 原生行为，避免语言守卫与 Dola 初始化逻辑互相触发刷新。
 */
export const DOLA_LOCALE_PRELOAD_SCRIPT = String.raw`(function () {
  var host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (host !== 'dola.com' && host.slice(-9) !== '.dola.com') return;
  if (window.__lalorDolaLocaleBootstrapV1) return;

  var localeKeys = ['i18nextLng', 'user_language_code', 'browser_language', 'i18next'];
  var cookieDomains = ['', 'dola.com', '.dola.com', 'www.dola.com', '.www.dola.com'];
  var isChinese = function (value) {
    return /^(?:zh|zh-cn|zh_cn)(?:[-_].*)?$/i.test(String(value || '').trim());
  };
  var canUseDomain = function (domain) {
    var normalized = String(domain || '').replace(/^\.+/, '').toLowerCase();
    return !normalized || host === normalized || host.slice(-(normalized.length + 1)) === '.' + normalized;
  };
  var cookieSuffix = function (domain) {
    return domain && canUseDomain(domain) ? '; Domain=' + domain : '';
  };
  var clearLocaleCookies = function () {
    var expires = '; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0';
    localeKeys.forEach(function (name) {
      cookieDomains.forEach(function (domain) {
        document.cookie = name + '=;' + cookieSuffix(domain) + '; Path=/' + expires;
      });
    });
  };
  var writeLocaleCookies = function () {
    localeKeys.forEach(function (name) {
      cookieDomains.forEach(function (domain) {
        if (!canUseDomain(domain)) return;
        document.cookie = name + '=zh' + cookieSuffix(domain) + '; Path=/; Max-Age=31536000; SameSite=Lax';
      });
    });
  };
  var writeLocaleOnce = function () {
    try {
      localeKeys.forEach(function (key) {
        var current = localStorage.getItem(key);
        if (!isChinese(current)) localStorage.setItem(key, 'zh');
      });
      // 旧版曾把 i18next 写入 .www.dola.com；先清掉所有域变体，
      // 再写入同一份值，避免 Cookie 同名冲突触发站点自带 reload。
      clearLocaleCookies();
      writeLocaleCookies();
      if (document.documentElement) document.documentElement.lang = 'zh-CN';
    } catch (_) {
      // 隔离存储或极早期 DOM 不可用时，不阻断页面登录和输入。
    }
  };

  // document_start 通常已经创建了根节点；若尚未创建，则本次只完成
  // Cookie/Storage 初始化，不为了语言状态注册任何页面事件监听。
  writeLocaleOnce();

  // 仅提供只读的浏览器语言提示，不拦截刷新、路由、存储或输入事件。
  try {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      get: function () { return 'zh-CN'; },
    });
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: function () { return ['zh-CN', 'zh']; },
    });
  } catch (_) {
    // 某些 Chromium 版本禁止覆盖实例属性，保留原生 navigator 即可。
  }

  try {
    Object.defineProperty(window, '__lalorDolaLocaleBootstrapV1', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    });
  } catch (_) {
    try { window.__lalorDolaLocaleBootstrapV1 = true; } catch (_) {}
  }
})();`;
