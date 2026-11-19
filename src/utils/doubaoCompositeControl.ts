import { buildComposerRootProbe } from './uploadReadiness';

export interface DoubaoCompositeControlSnapshot {
  text: string;
  expanded: boolean;
  actionable: boolean;
  activated: boolean;
}

/** 组合参数的语义解析同时用于等待、定位与最终回读，避免三套规则漂移。 */
export function parseVideoCompositeControlText(text: string): { ratio: string; duration: string } | null {
  const compact = text
    .normalize('NFKC')
    .replace(/：/g, ':')
    .replace(/[／/×xX＊*]/g, ':')
    .replace(/秒/g, 's')
    .replace(/\s+/g, '')
    .replace(/[﹒•⋅]/g, '·');
  const ratio = compact.match(/(?:自动|auto|[0-9]+:[0-9]+)/i)?.[0]?.toLowerCase();
  const duration = compact.match(/(?:[4-9]|1[0-5]|30)s/i)?.[0];
  return ratio && duration ? { ratio, duration: duration.toLowerCase() } : null;
}

/**
 * 仅操作当前创作栏的可见参数入口。定位与点击在同一次页内执行，避免 React
 * 重挂载后使用旧坐标；已展开时只回读，不重复点击把弹层关掉。
 */
export function buildDoubaoCompositeControlProbe(action: 'read' | 'open'): string {
  // 解析器必须保持自包含；编译后的函数源码可直接在页面上下文运行。
  return `(function () {
    var parseText = ${parseVideoCompositeControlText.toString()};
    var selector = '[data-creation-params-panel-id]';
    function inspect(el) {
      if (!el || el.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
      var r = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (r.width <= 20 || r.height <= 20 || r.width >= 480 || text.length > 80 ||
          style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ||
          el.disabled || el.getAttribute('aria-disabled') === 'true' || !parseText(text)) return null;
      var x = Math.round(r.left + r.width / 2);
      var y = Math.round(r.top + r.height / 2);
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
      var hit = document.elementFromPoint(x, y);
      return { el: el, text: text, x: x, y: y, area: r.width * r.height,
        expanded: el.getAttribute('aria-expanded') === 'true' || el.getAttribute('data-state') === 'open',
        actionable: !!hit && (hit === el || el.contains(hit)) };
    }
    var candidates = Array.from(document.querySelectorAll(selector)).map(inspect).filter(Boolean);
    if (!candidates.length) {
      // 旧页面的文字回退仅限输入区，不把聊天正文里的比例/时长当成按钮。
      var composer = ${buildComposerRootProbe()};
      if (composer) candidates = Array.from(composer.querySelectorAll('button,[role="button"],[aria-haspopup]'))
        .map(inspect).filter(Boolean);
    }
    candidates.sort(function(a, b) { return Number(b.actionable) - Number(a.actionable) || a.area - b.area; });
    var candidate = candidates[0];
    if (!candidate) return { text: '', expanded: false, actionable: false, activated: false };
    var result = { text: candidate.text, expanded: candidate.expanded, actionable: candidate.actionable, activated: false };
    if (${JSON.stringify(action)} !== 'open') return result;
    if (candidate.expanded) { result.activated = true; return result; }
    if (!candidate.actionable) return result;
    var target = candidate.el;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: candidate.x, clientY: candidate.y, button: 0 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    try { target.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    result.activated = true;
    return result;
  })()`;
}
