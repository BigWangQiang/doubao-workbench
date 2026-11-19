export type CanvasAgentFloatingOffset = { x: number; y: number };

export type CanvasAgentFloatingSize = { width: number; height: number };

export const DEFAULT_CANVAS_AGENT_FLOATING_SIZE: CanvasAgentFloatingSize = { width: 640, height: 680 };

const PREVIOUS_DEFAULT_CANVAS_AGENT_FLOATING_SIZE: CanvasAgentFloatingSize = { width: 720, height: 760 };

export function normalizeCanvasAgentFloatingSize(size: Partial<CanvasAgentFloatingSize>): CanvasAgentFloatingSize {
    const width = Number(size.width);
    const height = Number(size.height);
    return {
        width: Math.max(480, Math.min(1120, Number.isFinite(width) ? width : DEFAULT_CANVAS_AGENT_FLOATING_SIZE.width)),
        height: Math.max(440, Math.min(1000, Number.isFinite(height) ? height : DEFAULT_CANVAS_AGENT_FLOATING_SIZE.height)),
    };
}

export function restoreCanvasAgentFloatingSize(value: unknown): CanvasAgentFloatingSize {
    const size = value && typeof value === "object"
        ? normalizeCanvasAgentFloatingSize(value as Partial<CanvasAgentFloatingSize>)
        : DEFAULT_CANVAS_AGENT_FLOATING_SIZE;

    if (size.width === PREVIOUS_DEFAULT_CANVAS_AGENT_FLOATING_SIZE.width && size.height === PREVIOUS_DEFAULT_CANVAS_AGENT_FLOATING_SIZE.height) {
        return DEFAULT_CANVAS_AGENT_FLOATING_SIZE;
    }

    return size;
}

export function clampCanvasAgentFloatingOffset(
    offset: CanvasAgentFloatingOffset,
    container: CanvasAgentFloatingSize,
    panel: CanvasAgentFloatingSize,
    headerHeight = 64,
    minimumVisibleWidth = 120,
): CanvasAgentFloatingOffset {
    const visibleWidth = Math.min(minimumVisibleWidth, container.width, panel.width);
    const maxX = Math.max(0, (container.width + panel.width) / 2 - visibleWidth);
    const panelTop = (container.height - panel.height) / 2;
    const minY = -panelTop;
    const maxY = Math.max(minY, container.height - headerHeight - panelTop);

    return {
        x: Math.max(-maxX, Math.min(maxX, offset.x)),
        y: Math.max(minY, Math.min(maxY, offset.y)),
    };
}
