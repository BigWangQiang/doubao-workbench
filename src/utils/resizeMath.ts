/** 包含平台自身侧栏在内，保留底部模型、比例和时长的完整桌面布局。 */
export const MIN_BROWSER_PANE_WIDTH = 1120;
export const FIXED_WORKSPACE_SHELL_WIDTH = 118;

export function clampSidebarWidth(width: number, min = 220, max = 500): number {
  return Math.min(max, Math.max(min, width));
}

/**
 * 根据当前窗口宽度限制左侧栏，始终为右侧平台创作控件保留完整视口。
 */
export function calculateSidebarMaxWidth(
  viewportWidth: number,
  minBrowserWidth = MIN_BROWSER_PANE_WIDTH,
  fixedShellWidth = FIXED_WORKSPACE_SHELL_WIDTH,
  minSidebarWidth = 220,
  maxSidebarWidth = 500,
): number {
  if (!Number.isFinite(viewportWidth)) return minSidebarWidth;
  const available = viewportWidth - minBrowserWidth - fixedShellWidth;
  return Math.max(minSidebarWidth, Math.min(maxSidebarWidth, available));
}

/** 小屏上账号列表覆盖平台侧栏，不能继续占用浏览器的横向空间。 */
export function shouldOverlaySidebar(
  viewportWidth: number,
  minBrowserWidth = MIN_BROWSER_PANE_WIDTH,
  fixedShellWidth = FIXED_WORKSPACE_SHELL_WIDTH,
  minSidebarWidth = 220,
): boolean {
  return !Number.isFinite(viewportWidth)
    || viewportWidth < minBrowserWidth + fixedShellWidth + minSidebarWidth;
}

export function calculateSidebarSplitRatio(
  pointerY: number,
  containerTop: number,
  containerHeight: number,
  min = 0.2,
  max = 0.7,
): number {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) return min;
  return Math.min(max, Math.max(min, (pointerY - containerTop) / containerHeight));
}

