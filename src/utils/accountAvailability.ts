import type {
  AccountAvailability,
  AccountAvailabilitySource,
  AccountPlatform,
} from '../types';

export interface AccountAvailabilityEvidence {
  platform: AccountPlatform;
  url: string;
  bodyText?: string;
  visibleLayerText?: string;
  iframeSources?: string[];
  hasUsableEditor?: boolean;
  hasLoginControl?: boolean;
  hasAuthenticatedControl?: boolean;
  /** 图像/视频创作页的已登录控件；新版页面可能隐藏旧导航项。 */
  hasCreationControls?: boolean;
  documentReady?: boolean;
  loadError?: boolean;
}

interface AvailabilityWebview {
  getURL: () => string;
  executeJavaScript: (code: string) => Promise<unknown>;
}

const VERIFICATION_PHRASES = [
  '请完成验证', '安全验证', '机器人验证', '拖动滑块', '点击进行验证',
  '验证后继续', '人机验证', 'verify to continue', 'security verification',
];

const LOGIN_PHRASES = [
  '请先登录', '登录后继续', '登录即可使用', '扫码登录', '手机号登录',
  '验证码登录', 'log in to continue', 'sign in to continue',
];

const PAGE_ERROR_PHRASES = [
  '页面走丢了', '页面不存在', '服务暂不可用', '网络异常', '网络连接失败',
  '页面加载失败', '访问过于频繁', '操作过于频繁', '账号异常', '账号已冻结',
  '当前功能受限', 'something went wrong', 'service unavailable',
];

/**
 * 平台登录可能暂时跳转到的受信任身份提供商。
 *
 * 这里只允许明确的登录提供商主机参与“登录中”判定；普通第三方页面仍
 * 按 platform_mismatch 处理。主机名采用精确匹配，避免把任意
 * `*.google.com` 页面误当成 OAuth 页面。
 */
const TRUSTED_LOGIN_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  'accounts.google.com',
]);

/**
 * 账号列表的本次启动预热优先级：已确认可用最靠前，已完成检测但需处理居中，
 * 尚未确认或仍在预热的账号靠后。调用方应在同一等级内保留用户原顺序。
 */
export function getAccountWarmupSortRank(
  availability: Pick<AccountAvailability, 'state'> | undefined,
): number {
  if (availability?.state === 'ready') return 0;
  if (availability && ['action_required', 'login_required', 'unavailable'].includes(availability.state)) {
    return 1;
  }
  return 2;
}

function includesAny(text: string, phrases: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return phrases.some((phrase) => normalized.includes(phrase.toLowerCase()));
}

function result(
  state: AccountAvailability['state'],
  reason: string,
  message: string,
  checkedAt: string,
  source: AccountAvailabilitySource,
): AccountAvailability {
  return { state, reason, message, checkedAt, source };
}

function classifyPageHost(
  platform: AccountPlatform,
  hostname: string,
): { expected: boolean; trustedLoginProvider: boolean } {
  const expectedHost = platform === 'dola' ? 'dola.com' : 'doubao.com';
  return {
    expected: hostname === expectedHost || hostname.endsWith(`.${expectedHost}`),
    trustedLoginProvider: TRUSTED_LOGIN_PROVIDER_HOSTS.has(hostname),
  };
}

function isLoginRequiredPage(
  parsed: URL,
  evidence: AccountAvailabilityEvidence,
  trustedLoginProvider: boolean,
  allText: string,
): boolean {
  const loginPath = /\/(login|signin|passport|auth)(\/|$)/i.test(parsed.pathname);
  return trustedLoginProvider || loginPath || evidence.hasLoginControl === true ||
    (!evidence.hasUsableEditor && includesAny(allText, LOGIN_PHRASES));
}

/**
 * 将页面可见证据归类为账号可用性。未知状态不会被伪装成可用；调用方可
 * 在受控导航后再次探测，以免把普通落地页误判成登录失效。
 */
export function classifyAccountAvailability(
  evidence: AccountAvailabilityEvidence,
  source: AccountAvailabilitySource,
  checkedAt: string = new Date().toISOString(),
): AccountAvailability {
  if (evidence.loadError) {
    return result('unavailable', 'network_error', '页面加载失败，请检查网络后重新检测', checkedAt, source);
  }

  const url = evidence.url.trim();
  if (!url || url === 'about:blank') {
    return result('unknown', 'page_loading', '页面仍在加载，稍后会自动复检', checkedAt, source);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return result('unavailable', 'invalid_page_url', '当前页面地址异常，请刷新后重新检测', checkedAt, source);
  }

  const normalizedHostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const hostClassification = classifyPageHost(evidence.platform, normalizedHostname);
  if (!hostClassification.expected && !hostClassification.trustedLoginProvider) {
    return result('unavailable', 'platform_mismatch', '当前页面不属于该账号平台，自动化已停用', checkedAt, source);
  }

  const allText = `${evidence.visibleLayerText || ''}\n${evidence.bodyText || ''}`;
  const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
  const iframeSources = (evidence.iframeSources || []).join('\n').toLowerCase();

  if (
    path.includes('region-restricted') || path.includes('region_restricted') ||
    includesAny(allText, ['当前地区不可用', '所在地区暂不可用', 'not available in your region'])
  ) {
    return result('unavailable', 'region_restricted', '平台限制当前地区访问，无法自动化生产', checkedAt, source);
  }

  if (
    includesAny(iframeSources, ['captcha', 'verify', 'challenge', 'secsdk']) ||
    includesAny(evidence.visibleLayerText || '', VERIFICATION_PHRASES)
  ) {
    return result('action_required', 'human_verification', '需要在右侧页面完成人机验证，然后重新检测', checkedAt, source);
  }

  // 异常页/风控层要先于公共页的“登录”入口判定，否则会把平台故障误报为仅需登录。
  if (
    includesAny(evidence.visibleLayerText || '', PAGE_ERROR_PHRASES) ||
    (!evidence.hasUsableEditor && includesAny(evidence.bodyText || '', PAGE_ERROR_PHRASES))
  ) {
    return result('unavailable', 'page_error', '平台页面异常或账号受限，请在右侧页面核对后重新检测', checkedAt, source);
  }

  // Dola/豆包的 Google OAuth 流程会把当前 webview 导航到
  // accounts.google.com。该页即使出现同名输入框，也不是平台编辑器；
  // 只要仍处于受信任提供商就保持 login_required，而不是 platform_mismatch。
  // 这样会保持 fail-closed，不会放行自动化。
  // 受信任身份提供商本身仍是外部登录页，即使其 DOM 恰好包含输入框，
  // 也不能把它当作 Dola/豆包编辑器放行。回到平台域名后才会再次探测 ready。
  if (isLoginRequiredPage(parsed, evidence, hostClassification.trustedLoginProvider, allText)) {
    return result('login_required', 'login_required', '账号需要重新登录，登录完成后请重新检测', checkedAt, source);
  }

  // 新版图像/视频创作页可能在挂载创作面板时暂时没有传统聊天输入框；
  // 只要平台域名正确、没有登录/验证阻断，明确可见的创作控件本身就是
  // 可执行页面证据。这样不会把图片任务误停在“未识别到输入区域”。
  const hasCreationSurface = evidence.platform === 'doubao' && evidence.hasCreationControls === true;
  if (evidence.hasUsableEditor || hasCreationSurface) {
    // 豆包匿名页也提供输入框，“登录”按钮却可能在 SPA 启动后数秒才出现。
    // 新版图像/视频创作页可能隐藏“退出登录/云盘”等旧导航项；只要页面
    // 同时有明确的创作控件，就可作为同等强度的已登录证据。匿名页若有
    // 登录按钮会在前面的 isLoginRequiredPage 分支被拦截。
    if (evidence.platform === 'doubao' && !evidence.hasAuthenticatedControl && !evidence.hasCreationControls) {
      return result('unknown', 'authentication_unconfirmed', '已看到输入区，但尚未确认登录身份，正在自动复检', checkedAt, source);
    }
    return result('ready', 'ready', '账号页面正常，可执行自动化', checkedAt, source);
  }

  return result(
    'unknown',
    evidence.documentReady ? 'page_unrecognized' : 'page_loading',
    evidence.documentReady ? '未识别到可用输入区域，请打开对话页后重新检测' : '页面仍在加载，稍后会自动复检',
    checkedAt,
    source,
  );
}

const PAGE_EVIDENCE_SCRIPT = `
  (function() {
    function visible(node) {
      if (!node) return false;
      var rect = node.getBoundingClientRect();
      var style = window.getComputedStyle(node);
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    var editor = null;
    var candidates = document.querySelectorAll('textarea:not([disabled]), input:not([disabled]), [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!visible(candidate)) continue;
      if (candidate.getAttribute && candidate.getAttribute('aria-disabled') === 'true') continue;
      if (candidate.getAttribute && candidate.getAttribute('aria-readonly') === 'true') continue;
      if (candidate.tagName === 'INPUT' && candidate.type !== 'text' && candidate.type !== '') continue;
      editor = candidate;
      break;
    }
    var layerTexts = [];
    var layers = document.querySelectorAll('[role="dialog"], [role="alert"], [class*="captcha"], [class*="verify"], [class*="Verify"], [class*="login"], [class*="Login"], [class*="toast"], [class*="Toast"], [class*="modal"], [class*="Modal"], [class*="error"], [class*="Error"]');
    for (var j = 0; j < layers.length && j < 30; j++) {
      if (visible(layers[j])) layerTexts.push(String(layers[j].innerText || '').slice(0, 1000));
    }
    var frameSources = [];
    var frames = document.querySelectorAll('iframe');
    for (var k = 0; k < frames.length && k < 20; k++) {
      if (visible(frames[k])) frameSources.push(String(frames[k].src || '').slice(0, 1000));
    }
    var hasLoginControl = false;
    var hasAuthenticatedControl = false;
    var hasCreationControls = false;
    // 新版匿名页把“登录”渲染成普通 div/span，而非 button。必须扫描精确
    // 叶子文本；已登录证据仍只接受受限的导航动作，不能用任意页面文字猜测。
    var controls = document.querySelectorAll('button, a, [role="button"], div, span');
    for (var c = 0; c < controls.length && c < 800; c++) {
      if (!visible(controls[c])) continue;
      var controlText = String(controls[c].innerText || controls[c].textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      var childHasSameText = Array.from(controls[c].children || []).some(function (child) {
        return String(child.innerText || child.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === controlText;
      });
      if (!childHasSameText && (controlText === '登录' || controlText === '立即登录' || controlText === 'log in' || controlText === 'sign in')) {
        hasLoginControl = true;
      }
      if (controlText === '定时任务' || controlText === '云盘' || controlText === '退出登录' || controlText === 'log out' || controlText === 'sign out') {
        hasAuthenticatedControl = true;
      }
      if (controlText === '图像生成' || controlText === '图片生成' || controlText === '生成图片' ||
          controlText === '视频生成' || controlText === '生成视频' || controlText === 'ai创作') {
        hasCreationControls = true;
      }
    }
    return {
      bodyText: String(document.body ? document.body.innerText || '' : '').slice(0, 6000),
      visibleLayerText: layerTexts.join('\\n'),
      iframeSources: frameSources,
      hasUsableEditor: !!editor,
      hasLoginControl: hasLoginControl,
      hasAuthenticatedControl: hasAuthenticatedControl,
      hasCreationControls: hasCreationControls,
      documentReady: document.readyState === 'interactive' || document.readyState === 'complete'
    };
  })();
`;

/** 读取当前 webview 的脱敏可见证据并给出确定性可用性结果。 */
export async function probeAccountAvailability(
  webview: AvailabilityWebview,
  platform: AccountPlatform,
  source: AccountAvailabilitySource,
  timeoutMs: number = 6000,
): Promise<AccountAvailability> {
  const checkedAt = new Date().toISOString();
  let url = '';
  try {
    url = webview.getURL() || '';
    const page = await Promise.race([
      webview.executeJavaScript(PAGE_EVIDENCE_SCRIPT),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('availability_probe_timeout')), timeoutMs)),
    ]) as Omit<AccountAvailabilityEvidence, 'platform' | 'url'>;
    return classifyAccountAvailability({ ...page, platform, url }, source, checkedAt);
  } catch {
    // executeJavaScript 暂不可用不等于网络失败；只有 Webview 的 did-fail-load
    // 事件能提供权威加载失败证据。正确平台 URL 下继续保持 unknown 并复检。
    return classifyAccountAvailability({ platform, url, documentReady: false }, source, checkedAt);
  }
}

export function availabilityBlocksAutomation(availability: AccountAvailability | undefined): boolean {
  return !!availability && availability.state !== 'ready';
}

/**
 * 持久化的 ready 只能证明上一次运行时可用。每次打开软件必须先改为待复检，
 * 避免在 webview 尚未稳定时把任何旧结果用于自动指派。网络错误、登录状态与
 * 验证弹窗都可能在应用关闭期间被用户修复，因此必须由本次运行的真实页面重新判定。
 */
export function requireStartupAvailabilityRecheck(
  availability: AccountAvailability | undefined,
  checkedAt: string = new Date().toISOString(),
): AccountAvailability {
  return result(
    'unknown',
    'startup_recheck_required',
    '正在重新核对登录与验证状态，检测完成前不会自动执行',
    checkedAt,
    'startup',
  );
}

const AVAILABILITY_BLOCK_LABELS: Record<AccountAvailability['state'], string | null> = {
  unknown: '自动化可用性尚未确认',
  ready: null,
  action_required: '等待人工验证',
  login_required: '登录已失效',
  unavailable: '平台页面不可用',
};

/** 供调度器消费的统一阻断说明，避免调度与 UI 各自解释状态。 */
export function getAvailabilityBlockReason(availability: AccountAvailability | undefined): string | null {
  if (!availability) return null;
  if (availability.state === 'unavailable') return availability.message || AVAILABILITY_BLOCK_LABELS.unavailable;
  return AVAILABILITY_BLOCK_LABELS[availability.state];
}
