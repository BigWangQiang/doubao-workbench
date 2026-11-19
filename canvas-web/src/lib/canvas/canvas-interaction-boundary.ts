export const CANVAS_OVERLAY_SELECTOR = ".ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown";

export function isCanvasOverlayTarget(target: Element | null, boundary: Element): boolean {
    // Portal 的 React 事件仍会经过画布祖先；捕获指针前先排除浮层，避免菜单点击变成拖拽。
    return !target || !boundary.contains(target) || Boolean(target.closest(CANVAS_OVERLAY_SELECTOR));
}
