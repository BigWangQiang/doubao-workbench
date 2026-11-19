import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import type { CanvasNodeData, Position } from "@/types/canvas";

const ASSET_COLUMNS = 4;
const ASSET_GAP = 64;
const ANALYSIS_GAP = 80;

export function layoutViralVideoAssets(analysisNode: CanvasNodeData, assets: CanvasNodeData[], obstacles: CanvasNodeData[]) {
    const positions = new Map<string, Position>();
    if (!assets.length) return { positions, right: analysisNode.position.x + analysisNode.width };

    const columns = Math.min(ASSET_COLUMNS, assets.length);
    const cellWidth = Math.max(...assets.map((node) => node.width));
    const rowHeights = Array.from({ length: Math.ceil(assets.length / ASSET_COLUMNS) }, (_, row) =>
        Math.max(...assets.slice(row * ASSET_COLUMNS, (row + 1) * ASSET_COLUMNS).map((node) => node.height)),
    );
    const size = {
        width: columns * cellWidth + (columns - 1) * ASSET_GAP,
        height: rowHeights.reduce((sum, height) => sum + height, 0) + (rowHeights.length - 1) * ASSET_GAP,
    };
    // 整组避让已有节点，行间预留标题空间；只改位置，保留图片原始比例。
    const origin = findAvailableGenerationGroupPosition(obstacles, {
        x: analysisNode.position.x,
        y: analysisNode.position.y + analysisNode.height + ANALYSIS_GAP,
    }, size);
    let y = origin.y;
    rowHeights.forEach((height, row) => {
        assets.slice(row * ASSET_COLUMNS, (row + 1) * ASSET_COLUMNS).forEach((node, column) => {
            positions.set(node.id, {
                x: origin.x + column * (cellWidth + ASSET_GAP) + (cellWidth - node.width) / 2,
                y,
            });
        });
        y += height + ASSET_GAP;
    });
    return { positions, right: origin.x + size.width };
}
