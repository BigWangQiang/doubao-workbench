/** 入口按豆包真实工作模式执行；创建只点击一次，超时不自动重建。 */
export const STORYBOARD_PAGE_NAVIGATION = String.raw`
  const expandCanvas = async () => {
    const expand = [...document.querySelectorAll('button[aria-label="全屏查看"]')].find(visible);
    if (expand) {
      expand.click();
      await waitFor(() => [...document.querySelectorAll('button[aria-label="退出全屏"]')].find(visible), '画布全屏展开');
    }
    return identity();
  };
  const enterCanvas = async () => {
    let current;
    try { current = identity(); } catch {}
    if (current) return expandCanvas();
    const work = await waitFor(() => [...document.querySelectorAll('button,[role="button"]')]
      .find(el => visible(el) && /^新工作任务(?:\s|Ctrl|$)/.test(el.textContent.trim())), '新工作任务入口（请确认已登录）', 30000);
    work.click();
    const skills = await waitFor(() => [...document.querySelectorAll('[data-testid="general-agent-skill-button"]')].find(visible), '工作任务技能入口', 30000);
    skills.click();
    const create = await waitFor(() => [...document.querySelectorAll('span')]
      .find(el => visible(el) && el.textContent.trim() === '创建画布'), '技能中的创建画布');
    create.click();
    await waitFor(() => { try { return identity(); } catch { return undefined; } }, '新画布加载（不会重复创建）', 45000);
    return expandCanvas();
  };
  const reopenCanvas = async input => {
    let current;
    try { current = identity(); } catch {}
    if (!current) {
      const card = await waitFor(() => {
        const cards = [...document.querySelectorAll('button')].filter(el => visible(el) && el.textContent.includes('创建时间：'));
        if (cards.length > 1) throw Error('此对话包含多个画布，请先手动打开本批次原画布');
        return cards[0];
      }, '对话中的原画布入口', 20000);
      card.click();
      current = await waitFor(() => { try { return identity(); } catch { return undefined; } }, '原画布加载', 30000);
    }
    if (current.canvasId !== input.canvasId) throw Error('当前页面与批次原画布不一致，未修改节点');
    return expandCanvas();
  };
`;
