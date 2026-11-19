// 展开画布不一定改变 URL；工具按钮也可能晚于画布挂载。探测和解析共用同一份 runtime 查找规则。
const findVisibleCanvases = `(() => {
  const canvases = new Map(), visited = new Set();
  const selector = 'button[aria-label="视频生成"],.react-flow,.react-flow__pane,.react-flow__node,[data-canvas-generation-composer]';
  for (const element of document.querySelectorAll(selector)) {
    if (!element.isConnected || !element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') continue;
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
    for (let depth = 0; fiber && depth < 90 && !visited.has(fiber); depth++, fiber = fiber.return) {
      visited.add(fiber);
      const props = fiber.memoizedProps || {};
      for (const api of [props, props.value]) {
        const canvasId = api?.runtime?.key?.canvasId;
        if (typeof canvasId === 'string' && canvasId && typeof api.binding?.getProjectionState === 'function') canvases.set(canvasId, api);
      }
    }
  }
  return canvases;
})()`;

/** 不以聊天页 URL 或文字猜画布身份，也不读取视频正文。 */
export function canvasParserCanvasProbeScript(expectedCanvasId?: string): string {
  return `(() => {
    const expected = ${JSON.stringify(expectedCanvasId ?? null)};
    const canvases = ${findVisibleCanvases};
    const canvasId = canvases.size === 1 ? canvases.keys().next().value : undefined;
    return { isCanvas: Boolean(canvasId) && (expected === null || canvasId === expected), canvasId };
  })()`;
}

/** 只读取当前可见画布；提取视频不安装批量生成脚本，也不改变选择、视口或请求。 */
export function canvasParserSnapshotScript(expectedCanvasId?: string): string {
  return `(() => {
    const expected = ${JSON.stringify(expectedCanvasId ?? null)};
    const canvases = ${findVisibleCanvases};
    if (!canvases.size) throw Error('请先打开要提取视频的豆包画布');
    if (canvases.size !== 1) throw Error('检测到多个画布，请只打开一个画布后再解析');
    const [canvasId, api] = canvases.entries().next().value;
    if (expected !== null && canvasId !== expected) throw Error('当前画布已切换，请重新打开本批次原画布');
    const items = api.binding.getProjectionState()?.document?.itemsById;
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw Error('画布数据尚未加载完成，请稍后再解析');
    return { canvasId, items: Object.values(items) };
  })()`;
}
