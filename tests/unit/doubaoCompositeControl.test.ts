import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildDoubaoCompositeControlProbe } from '../../src/utils/doubaoCompositeControl';
import type { DoubaoCompositeControlSnapshot } from '../../src/utils/doubaoCompositeControl';

interface Control {
  innerText: string;
  hidden: boolean;
  covered: boolean;
  expanded: boolean;
  clicks: number;
  disabled: boolean;
  closest: () => object | null;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
  getAttribute: (name: string) => string | null;
  contains: (target: unknown) => boolean;
  dispatchEvent: (event: { type: string }) => boolean;
}

function makeControl(text: string, top = 680): Control {
  const node: Control = {
    innerText: text,
    hidden: false,
    covered: false,
    expanded: false,
    clicks: 0,
    disabled: false,
    closest: (): object | null => node.hidden ? {} : null,
    getBoundingClientRect: (): { width: number; height: number; left: number; top: number } =>
      ({ width: 160, height: 40, left: 120, top }),
    getAttribute: (name: string): string | null => name === 'aria-expanded' ? String(node.expanded) : null,
    contains: (target: unknown): boolean => target === node,
    dispatchEvent: (event: { type: string }): boolean => {
      if (event.type === 'click') {
        node.clicks += 1;
        node.expanded = !node.expanded;
      }
      return true;
    },
  };
  return node;
}

function runProbe(nodes: Control[], action: 'read' | 'open'): DoubaoCompositeControlSnapshot {
  class PageEvent {
    constructor(readonly type: string) {}
  }
  return runInNewContext(buildDoubaoCompositeControlProbe(action), {
    document: {
      querySelectorAll: (selector: string): Control[] =>
        selector === '[data-creation-params-panel-id]' ? nodes : [],
      elementFromPoint: (): object | null => {
        const node = nodes.find((candidate) => !candidate.hidden);
        return node?.covered ? {} : node || null;
      },
    },
    window: {
      innerWidth: 1200,
      innerHeight: 900,
      getComputedStyle: (): object => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
    MouseEvent: PageEvent,
    PointerEvent: PageEvent,
  }) as DoubaoCompositeControlSnapshot;
}

describe('豆包组合参数入口', () => {
  it.each(['9:16 · 10s', '9：16\n•\n10 秒', '画面比例 9:16 / 10s', 'Auto · 10s'])(
    '等待可识别的文字同样能打开：%s', (text) => {
      const node = makeControl(text);
      expect(runProbe([node], 'read').text).not.toBe('');
      expect(node.clicks).toBe(0);
      expect(runProbe([node], 'open').activated).toBe(true);
      expect(node.clicks).toBe(1);
    },
  );

  it('跳过旧的隐藏入口，使用重新挂载后的可见入口', () => {
    const oldNode = makeControl('16:9 · 5s');
    oldNode.hidden = true;
    const newNode = makeControl('9:16 · 10s');
    expect(runProbe([oldNode, newNode], 'open').activated).toBe(true);
    expect(oldNode.clicks).toBe(0);
    expect(newNode.clicks).toBe(1);
  });

  it('明确的原生入口位于页面上半部时仍可操作', () => {
    const node = makeControl('9:16 · 10s', 120);
    expect(runProbe([node], 'open').activated).toBe(true);
  });

  it('入口尚未挂载或被遮挡时不点击，恢复后才打开', () => {
    expect(runProbe([], 'open').activated).toBe(false);
    const node = makeControl('9:16 · 10s');
    node.covered = true;
    expect(runProbe([node], 'open').activated).toBe(false);
    expect(node.clicks).toBe(0);
    node.covered = false;
    expect(runProbe([node], 'open').activated).toBe(true);
    expect(node.clicks).toBe(1);
  });

  it('弹层已打开时不重复点击关闭，也不会把文字回读当作点击', () => {
    const node = makeControl('9:16 · 10s');
    runProbe([node], 'open');
    expect(runProbe([node], 'open').activated).toBe(true);
    expect(node.expanded).toBe(true);
    expect(node.clicks).toBe(1);
    expect(runProbe([node], 'read').activated).toBe(false);
    expect(node.clicks).toBe(1);
  });

  it('不点击禁用控件或没有完整参数的控件', () => {
    const disabled = makeControl('9:16 · 10s');
    disabled.disabled = true;
    const invalid = makeControl('选择比例和时长');
    expect(runProbe([disabled, invalid], 'open').activated).toBe(false);
    expect(disabled.clicks + invalid.clicks).toBe(0);
  });
});
