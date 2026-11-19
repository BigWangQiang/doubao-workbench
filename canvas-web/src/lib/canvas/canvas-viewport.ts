import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasBounds = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

export type CanvasViewportSize = {
    width: number;
    height: number;
};

export function canvasNodeIntersectsViewport(
    node: Pick<CanvasNodeData, "position" | "width" | "height">,
    viewport: ViewportTransform,
    viewportSize: CanvasViewportSize,
    padding = 0,
): boolean {
    const scale = Math.max(viewport.k, 0.05);
    const viewLeft = -viewport.x / scale - padding;
    const viewTop = -viewport.y / scale - padding;
    const viewRight = viewLeft + viewportSize.width / scale + padding * 2;
    const viewBottom = viewTop + viewportSize.height / scale + padding * 2;

    return node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom;
}

export function getCanvasNodesBounds(nodes: CanvasNodeData[]): CanvasBounds | null {
    if (!nodes.length) return null;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    nodes.forEach((node) => {
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    });

    return { left, top, right, bottom };
}

export function viewportForBounds(bounds: CanvasBounds, viewportSize: CanvasViewportSize, options: { padding?: number; minScale?: number; maxScale?: number } = {}): ViewportTransform {
    const padding = options.padding ?? 96;
    const minScale = options.minScale ?? 0.05;
    const maxScale = options.maxScale ?? 1;
    const boundsWidth = Math.max(1, bounds.right - bounds.left);
    const boundsHeight = Math.max(1, bounds.bottom - bounds.top);
    const availableWidth = Math.max(1, viewportSize.width - padding * 2);
    const availableHeight = Math.max(1, viewportSize.height - padding * 2);
    const k = Math.min(maxScale, Math.max(minScale, Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight)));
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    return {
        x: viewportSize.width / 2 - centerX * k,
        y: viewportSize.height / 2 - centerY * k,
        k,
    };
}

export function viewportAtScale(viewport: ViewportTransform, viewportSize: CanvasViewportSize, scale: number): ViewportTransform {
    const k = Math.min(2, Math.max(0.05, scale));
    const centerWorldX = (viewportSize.width / 2 - viewport.x) / viewport.k;
    const centerWorldY = (viewportSize.height / 2 - viewport.y) / viewport.k;
    return {
        x: viewportSize.width / 2 - centerWorldX * k,
        y: viewportSize.height / 2 - centerWorldY * k,
        k,
    };
}

export function viewportExceedsCanvasNodeRenderBuffer(renderedViewport: ViewportTransform, nextViewport: ViewportTransform, viewportSize: CanvasViewportSize): boolean {
    const scale = Math.max(renderedViewport.k, 0.05);
    const nextScale = Math.max(nextViewport.k, 0.05);
    const maxDimension = Math.max(viewportSize.width, viewportSize.height);
    const minimumPadding = Math.max(240, maxDimension * 0.4) / scale;
    const renderedLeft = -renderedViewport.x / scale - minimumPadding;
    const renderedTop = -renderedViewport.y / scale - minimumPadding;
    const renderedRight = (viewportSize.width - renderedViewport.x) / scale + minimumPadding;
    const renderedBottom = (viewportSize.height - renderedViewport.y) / scale + minimumPadding;
    const nextLeft = -nextViewport.x / nextScale;
    const nextTop = -nextViewport.y / nextScale;
    const nextRight = (viewportSize.width - nextViewport.x) / nextScale;
    const nextBottom = (viewportSize.height - nextViewport.y) / nextScale;

    return nextLeft < renderedLeft || nextTop < renderedTop || nextRight > renderedRight || nextBottom > renderedBottom;
}

export function interpolateViewport(from: ViewportTransform, to: ViewportTransform, progress: number): ViewportTransform {
    const t = 1 - Math.pow(1 - Math.min(1, Math.max(0, progress)), 3);
    return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        k: from.k + (to.k - from.k) * t,
    };
}
