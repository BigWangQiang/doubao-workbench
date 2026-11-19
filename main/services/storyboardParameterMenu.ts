/** 同一参数面板会随宽度在顶栏与“更多”子菜单之间移动，不能只定位 button。 */
export const STORYBOARD_PARAMETER_MENU = String.raw`
  const getParamTrigger = () => [...document.querySelectorAll(
    'button[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"], [role="menuitem"][data-creation-params-panel-id]'
  )].find(visible);
  const findParamsMenu = () => [...document.querySelectorAll('[role="menu"][data-creation-params-panel-id][data-state="open"]')].find(visible);
  const openParameters = async () => {
    const deadline = Date.now() + 12000;
    let attempt = 0, nextAction = 0;
    while (Date.now() < deadline) {
      if (state.stopped) throw Error('已停止后续页面操作');
      const existing = findParamsMenu();
      if (existing) return existing;
      if (Date.now() < nextAction) { await delay(100); continue; }
      const trigger = getParamTrigger();
      if (trigger) {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        if (trigger.getAttribute('role') === 'menuitem') {
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
        } else if (trigger.getAttribute('aria-expanded') !== 'true') {
          if (attempt++ % 2 === 0) trigger.click();
          else trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
        }
        nextAction = Date.now() + 700;
        await delay(100);
        continue;
      }
      const model = [...document.querySelectorAll('button[data-input-engine-actionbar-control-key="video-model"]')].find(visible);
      const bar = model?.closest('.bp5-overflow-list');
      const candidates = [...(bar?.querySelectorAll('button[data-slot="dropdown-menu-trigger"]') || [])]
        .filter(el => visible(el) && !el.textContent.trim() && !el.hasAttribute('data-input-engine-actionbar-control-key'));
      // 更多菜单在首次悬停后才挂载 Radix trigger，直接找 data-slot 会漏掉冷启动状态。
      if (!candidates.length) {
        const lazy = [...(bar?.querySelectorAll('button[aria-hidden="false"]') || [])].filter(el => visible(el) && !el.textContent.trim());
        if (lazy.length === 1) lazy[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      }
      if (candidates.length > 1) throw Error('无法唯一定位视频参数的更多菜单，请展开当前节点');
      if (candidates[0]?.getAttribute('aria-expanded') === 'false') {
        candidates[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
        nextAction = Date.now() + 700;
      }
      await delay(100);
    }
    throw Error('等待比例、时长、分辨率参数菜单超时，请检查当前节点');
  };
  const readOpenParameters = menu => {
    // 豆包比例按钮用高亮边框表示选择，分辨率用 aria-pressed；不假定两者都是 aria-selected。
    const selected = [...menu.querySelectorAll('button')]
      .filter(button => button.getAttribute('aria-selected') === 'true' || button.getAttribute('aria-pressed') === 'true' || button.classList.contains('border-dbx-text-highlight'))
      .map(button => button.textContent.trim());
    const slider = menu.querySelector('[role="slider"]');
    return { ratio: selected.find(text => /^(自动|\d+:\d+)$/.test(text)),
      duration: slider ? Number(slider.getAttribute('aria-valuenow')) + 4 : undefined,
      resolution: selected.find(text => /^\d+P$/i.test(text)) };
  };
  const readParameters = async () => readOpenParameters(await openParameters());
  const closeParameters = async () => {
    const menu = findParamsMenu();
    if (menu?.dataset.slot === 'dropdown-menu-sub-content') {
      menu.focus();
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true, cancelable: true }));
      await waitFor(() => !findParamsMenu(), '参数子菜单关闭');
    }
    const direct = getParamTrigger();
    const model = [...document.querySelectorAll('button[data-input-engine-actionbar-control-key="video-model"]')].find(visible);
    const more = [...(model?.closest('.bp5-overflow-list')?.querySelectorAll('button[data-slot="dropdown-menu-trigger"]') || [])].find(el => visible(el) && !el.textContent.trim());
    const trigger = direct?.tagName === 'BUTTON' ? direct : more;
    if (trigger?.getAttribute('aria-expanded') === 'true') {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
      await waitFor(() => !visible(trigger) || trigger.getAttribute('aria-expanded') !== 'true', '参数菜单关闭');
    }
  };
`;
