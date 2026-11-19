import type { ViewportTransform } from "@/types/canvas";
import type { CanvasViewportSize } from "@/lib/canvas/canvas-viewport";

const MIN_VIEWPORT_SCALE = 0.05;
const MIN_PREVIEW_RATIO = 0.85;
const MAX_PREVIEW_RATIO = 1.25;

export function calculateCanvasPreviewTransform(viewport: ViewportTransform, rasterViewport: ViewportTransform) {
    const ratio = viewport.k / Math.max(rasterViewport.k, MIN_VIEWPORT_SCALE);
    // 将旧 backing store 的屏幕坐标映射到实时视口，避免缩放手势逐帧触发矢量重绘。
    return {
        ratio,
        x: viewport.x - rasterViewport.x * ratio,
        y: viewport.y - rasterViewport.y * ratio,
    };
}

export function shouldRebaseCanvasRaster(viewport: ViewportTransform, rasterViewport: ViewportTransform, size: CanvasViewportSize) {
    const { ratio, x, y } = calculateCanvasPreviewTransform(viewport, rasterViewport);
    if (ratio < MIN_PREVIEW_RATIO || ratio > MAX_PREVIEW_RATIO) return true;
    // 缓存只包含旧视口内的像素，平移或缩小时不能把未绘制区域当作已有画面复用。
    // 只容忍浮点计算误差，露出任意一侧就先重绘，避免连线被旧位图边缘截断。
    const epsilon = 0.001;
    return x > epsilon || y > epsilon
        || x + size.width * ratio < size.width - epsilon
        || y + size.height * ratio < size.height - epsilon;
}

export function sameCanvasViewport(left: ViewportTransform, right: ViewportTransform) {
    return left.x === right.x && left.y === right.y && left.k === right.k;
}
