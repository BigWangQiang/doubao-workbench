import { useState, type RefObject } from "react";
import { Dropdown, type MenuProps } from "antd";
import { ChevronDown, Grid3X3, Group } from "lucide-react";

import { CanvasSelectionToolbar } from "@/components/canvas/canvas-workspace-overlays";
import { defaultToolbarPrefs, readToolbarPrefs, resolveToolbarTools, type ToolContext, type ToolDefinition, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import type { CanvasAlignmentMode } from "@/lib/canvas/canvas-layout";

type CanvasProjectSelectionToolbarProps = {
    anchorRef: RefObject<HTMLDivElement | null>;
    containerRef: RefObject<HTMLDivElement | null>;
    count: number;
    selectedVideoCount: number;
    mergingVideos: boolean;
    onAlign: (mode: CanvasAlignmentMode) => void;
    onArrange: (mode: "row" | "column" | "grid" | "flow") => void;
    onCreateStoryboard: () => void;
    onCreateReferenceGroup: () => void;
    onMergeVideos: () => void;
};

export function CanvasProjectSelectionToolbar({ anchorRef, containerRef, count, selectedVideoCount, mergingVideos, onAlign, onArrange, onCreateStoryboard, onCreateReferenceGroup, onMergeVideos }: CanvasProjectSelectionToolbarProps) {
    const [openMenu, setOpenMenu] = useState<"layout" | "group" | null>(null);

    const handlers = {
        onAlign, onArrange, onCreateStoryboard, onCreateReferenceGroup, onMergeVideos,
    } as Partial<ToolbarHandlers> as ToolbarHandlers;

    const ctx: ToolContext = {
        selectedCount: count,
        selectedNodeTypes: new Set(),
        selectedVideoCount,
        canvasTool: "move",
        workspaceMode: "professional",
        isProjectLinked: false,
        canUndo: false,
        canRedo: false,
        extractingVideoFrame: false,
        extractingAudio: false,
        trimmingVideo: false,
        mergingVideos,
        addPanelOpen: false,
        appearancePanelOpen: false,
        settingsPanelOpen: false,
        handlers,
    };

    const prefs = readToolbarPrefs("selection") ?? defaultToolbarPrefs("selection");
    const tools = resolveToolbarTools("selection", ctx, prefs);
    const arrangeTools = tools.filter((tool) => tool.category === "arrange");
    const alignTools = tools.filter((tool) => tool.category === "layout");
    const groupTools = tools.filter((tool) => tool.id.startsWith("selection-create-"));
    const actionTools = tools.filter((tool) => tool.category !== "arrange" && tool.category !== "layout" && !tool.id.startsWith("selection-create-"));
    // 菜单继续使用注册表的可见性、禁用状态和执行入口，避免样式改版丢失原有工具。
    const menuItems = (entries: ToolDefinition[]): NonNullable<MenuProps["items"]> => entries.map((tool) => ({
        key: tool.id,
        label: typeof tool.label === "function" ? tool.label(ctx) : tool.label,
        icon: typeof tool.icon === "function" ? tool.icon(ctx) : tool.icon,
        disabled: tool.disabled?.(ctx),
        onClick: () => { setOpenMenu(null); tool.run(ctx); },
    }));
    const layoutItems: MenuProps["items"] = [
        ...menuItems([...arrangeTools.filter((tool) => tool.id === "selection-arrange-grid"), ...arrangeTools.filter((tool) => tool.id !== "selection-arrange-grid")]),
        ...(arrangeTools.length && alignTools.length ? [{ type: "divider" as const }] : []),
        ...menuItems(alignTools),
    ];
    const menuClassNames = { root: "canvas-media-tools-menu canvas-selection-menu", item: "canvas-media-tools-menu-item", itemIcon: "canvas-media-tools-menu-icon" };

    return (
        <CanvasSelectionToolbar anchorRef={anchorRef} containerRef={containerRef} count={count}>
            <div className="canvas-media-toolbar canvas-selection-toolbar" role="toolbar" aria-label={`多选节点工具，已选 ${count} 项`}>
                {layoutItems.length ? <Dropdown trigger={["click"]} placement="bottomLeft" open={openMenu === "layout"} onOpenChange={(open) => setOpenMenu(open ? "layout" : null)} classNames={menuClassNames} menu={{ items: layoutItems }}>
                    <button type="button" className="canvas-media-tool" aria-label="排列与对齐" aria-haspopup="menu" aria-expanded={openMenu === "layout"}>
                        <Grid3X3 aria-hidden /><span>排列</span><ChevronDown className="size-4" aria-hidden />
                    </button>
                </Dropdown> : null}
                {groupTools.length ? <>
                    <span className="canvas-media-toolbar-divider" aria-hidden />
                    <Dropdown trigger={["click"]} placement="bottomLeft" open={openMenu === "group"} onOpenChange={(open) => setOpenMenu(open ? "group" : null)} classNames={menuClassNames} menu={{ items: menuItems(groupTools) }}>
                        <button type="button" className="canvas-media-tool" aria-haspopup="menu" aria-expanded={openMenu === "group"}>
                            <Group aria-hidden /><span>打组</span><ChevronDown className="size-4" aria-hidden />
                        </button>
                    </Dropdown>
                </> : null}
                {actionTools.map((tool) => <button key={tool.id} type="button" className="canvas-media-tool" disabled={tool.disabled?.(ctx)} onClick={() => tool.run(ctx)}>
                    {typeof tool.icon === "function" ? tool.icon(ctx) : tool.icon}
                    <span>{typeof tool.label === "function" ? tool.label(ctx) : tool.label}</span>
                </button>)}
                <span className="canvas-selection-count" aria-live="polite">已选 {count}</span>
            </div>
        </CanvasSelectionToolbar>
    );
}
