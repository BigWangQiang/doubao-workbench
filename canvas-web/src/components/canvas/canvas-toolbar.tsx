import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Hand, MousePointer2, History, Keyboard, HelpCircle } from "lucide-react";

import { FloatingDock, type FloatingDockEntry } from "@/components/ui/aceternity/floating-dock";
import { CanvasCreateMenu, type CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { defaultToolbarPrefs, resolveAddNodeMenuCommands, resolveToolbarEntries, type AddNodeMenuCommand, type ToolContext, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import type { CanvasToolMode, CanvasWorkspaceMode } from "@/types/canvas";

export function CanvasToolbar({
    selectedCount,
    workspaceMode,
    canvasTool,
    onToolChange,
    isProjectLinked,
    canUndo,
    canRedo,
    onAddImage,
    onAddVideo,
    onAddAudio,
    onAddText,
    onChooseStyle,
    onAddScript,
    onAddFrame,
    onAddDrawing,
    onOpenDirector,
    onOpenViralVideo,
    onOpenScreenplay,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onClear,
    onArrangeAll,
    onDeselect,
    onOpenMyAssets,
    onOpenProjectCharacters,
    agentOpen,
    onOpenAgent,
    onOpenShortcuts,
}: {
    selectedCount: number;
    workspaceMode: CanvasWorkspaceMode;
    canvasTool: CanvasToolMode;
    onToolChange: (tool: CanvasToolMode) => void;
    isProjectLinked: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onChooseStyle: () => void;
    onAddScript: () => void;
    onAddFrame: () => void;
    onAddDrawing: () => void;
    onOpenDirector: () => void;
    onOpenViralVideo: () => void;
    onOpenScreenplay: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onArrangeAll: () => void;
    onDeselect: () => void;
    onOpenMyAssets: () => void;
    onOpenProjectCharacters: () => void;
    agentOpen: boolean;
    onOpenAgent: () => void;
    onOpenShortcuts: () => void;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const dockRef = useRef<HTMLDivElement>(null);
    const theme = canvasThemes.dark;
    const [addOpen, setAddOpen] = useState(false);
    const [toolMenu, setToolMenu] = useState<"pointer" | "history" | "help" | null>(null);
    const [panelX, setPanelX] = useState(0);

    const placePanel = (event: ReactMouseEvent<HTMLElement>) => setPanelX(getPanelX(dockRef.current, event.currentTarget));
    const runAddAction = (action: () => void) => {
        action();
        setAddOpen(false);
    };

    // 点击外部关闭浮层面板
    useEffect(() => {
        if (!addOpen && !toolMenu) return;
        const closeFloatingPanels = (event: PointerEvent) => {
            const target = event.target instanceof Node ? event.target : null;
            if (target && rootRef.current?.contains(target)) return;
            setAddOpen(false);
            setToolMenu(null);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") { setAddOpen(false); setToolMenu(null); }
        };
        document.addEventListener("pointerdown", closeFloatingPanels, true);
        document.addEventListener("keydown", closeOnEscape);
        return () => { document.removeEventListener("pointerdown", closeFloatingPanels, true); document.removeEventListener("keydown", closeOnEscape); };
    }, [addOpen, toolMenu]);

    // 构建 handlers（主工具栏只需要部分回调，其余用 no-op 占位满足类型）
    const handlers: ToolbarHandlers = {
        onToolChange,
        onDeselect,
        onUndo,
        onRedo,
        onClear,
        onArrangeAll,
        onAddText,
        onAddImage,
        onAddVideo,
        onAddAudio,
        onAddScript,
        onAddFrame,
        onAddDrawing,
        onChooseStyle,
        onOpenDirector,
        onOpenViralVideo,
        onOpenScreenplay,
        onUpload,
        onOpenMyAssets,
        onOpenProjectCharacters,
        onBackgroundModeChange: () => {},
        onShowImageInfoChange: () => {},
        onToggleAddPanel: (event: ReactMouseEvent<HTMLElement>) => { placePanel(event); setToolMenu(null); setAddOpen((value) => !value); },
        onToggleAppearancePanel: () => {},
        onToggleSettingsPanel: () => { setAddOpen(false); setToolMenu("help"); },
        onDeleteSelected: onDelete,
        // 以下为多选/节点悬停工具栏回调，主工具栏不使用，用 no-op 占位
        onAlign: () => {}, onArrange: () => {}, onCreateStoryboard: () => {}, onCreateReferenceGroup: () => {}, onMergeVideos: () => {},
        onNodeInfo: () => {}, onNodeDelete: () => {}, onNodeRetry: () => {}, onNodeEditText: () => {}, onNodeDecreaseFont: () => {}, onNodeIncreaseFont: () => {},
        onNodeToggleDialog: () => {}, onNodeAnnotate: () => {}, onNodeGenerateImage: () => {}, onNodeUpload: () => {}, onNodeDownload: () => {}, onNodeSaveAsset: () => {},
        onNodeMaskEdit: () => {}, onNodeEmotion: () => {}, onNodePortraitTexture: () => {}, onNodeCrop: () => {}, onNodeSplit: () => {}, onNodeUpscale: () => {},
        onNodeSuperResolve: () => {}, onNodeAngle: () => {}, onNodeViewImage: () => {}, onNodeExtractVideoLastFrame: () => {}, onNodeAnalyzeVideoFrames: () => {}, onNodeExtractAudioFromVideo: () => {}, onNodeRemoveVideoSubtitles: () => {}, onNodeTrimVideoRegenerate: () => {}, onNodeSubtitles: () => {}, onNodeTimeline: () => {}, onNodeReversePrompt: () => {},
        onNodeToggleFreeResize: () => {}, onNodeToggleLocked: () => {}, onNodeCopyPrompt: () => {},
    } as ToolbarHandlers;

    const ctx: ToolContext = {
        selectedCount,
        selectedNodeTypes: new Set(),
        selectedVideoCount: 0,
        canvasTool,
        workspaceMode,
        isProjectLinked,
        canUndo,
        canRedo,
        extractingVideoFrame: false,
        extractingAudio: false,
        trimmingVideo: false,
        mergingVideos: false,
        addPanelOpen: addOpen,
        appearancePanelOpen: false,
        settingsPanelOpen: false,
        handlers,
    };

    const entries = resolveToolbarEntries("main", ctx, defaultToolbarPrefs("main"));
    const findEntry = (id: string) => entries.find((entry) => entry.id === id && entry.kind !== "separator");
    const toggleToolMenu = (menu: NonNullable<typeof toolMenu>, event: ReactMouseEvent<HTMLElement>) => {
        placePanel(event); setAddOpen(false);
        setToolMenu((current) => current === menu ? null : menu);
    };
    const primaryItems: Array<FloatingDockEntry | undefined> = [
        findEntry("tool-add"),
        { id: "tool-pointer", label: canvasTool === "move" ? "抓手工具（H）" : "移动（V）", icon: canvasTool === "move" ? <Hand /> : <MousePointer2 />, expands: true, active: toolMenu === "pointer", onClick: (event) => toggleToolMenu("pointer", event) },
        { id: "tool-history", label: "撤销与重做", icon: <History />, expands: true, active: toolMenu === "history", onClick: (event) => toggleToolMenu("history", event) },
        { kind: "separator", id: "tool-utility-divider" },
        { id: "tool-shortcuts", label: "快捷键", icon: <Keyboard />, onClick: onOpenShortcuts },
        { id: "tool-help", label: "画布帮助", icon: <HelpCircle />, expands: true, active: toolMenu === "help", onClick: (event) => toggleToolMenu("help", event) },
    ];
    const items = primaryItems.filter((entry): entry is FloatingDockEntry => Boolean(entry));

    // 解析添加节点菜单命令——onClick 绑定到 runAddAction 以在执行后关闭面板
    const addNodeCommands = resolveAddNodeMenuCommands(ctx).filter((command) => command.id !== "assets");
    const toCommand = (cmd: AddNodeMenuCommand): CanvasCreateCommand => ({
        id: cmd.id,
        label: cmd.label,
        icon: cmd.icon,
        badge: cmd.badge,
        badgeTone: cmd.badgeTone,
        section: cmd.section,
        onClick: () => runAddAction(() => cmd.run(ctx)),
    });
    const createCommands = addNodeCommands.map(toCommand);

    return (
        <div ref={rootRef} data-canvas-no-zoom className="canvas-reference-toolbar pointer-events-none absolute inset-x-[var(--canvas-inset-x)] bottom-[var(--canvas-inset-y)] z-[var(--z-toolbar)] flex items-center justify-center">
            <AnimatePresence>
                {addOpen ? (
                    <AddNodeMenu
                        x={panelX}
                        theme={theme}
                        commands={createCommands}
                    />
                ) : null}
            </AnimatePresence>

            <FloatingDock ref={dockRef} items={items} magnify={false} className="canvas-floating-dock canvas-reference-primary-dock pointer-events-auto max-w-full" style={{ ...canvasDockStyle(theme), background: theme.toolbar.panel, boxShadow: "var(--shadow-sm)" }} />
            <CanvasAgentLauncher open={agentOpen} theme={theme} onOpen={onOpenAgent} />

            {toolMenu ? (
                <div role="menu" aria-label={toolMenu === "pointer" ? "移动工具" : toolMenu === "history" ? "撤销与重做" : "画布帮助"} className="canvas-reference-tool-menu pointer-events-auto absolute" style={{ left: panelX || "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}>
                    {toolMenu === "pointer" ? [
                        { mode: "box-select" as const, label: "移动", key: "V", icon: <MousePointer2 /> },
                        { mode: "move" as const, label: "抓手工具", key: "H", icon: <Hand /> },
                    ].map((item) => (
                        <button key={item.mode} type="button" role="menuitemradio" aria-checked={canvasTool === item.mode} className="canvas-reference-menu-row" style={{ background: canvasTool === item.mode ? theme.toolbar.activeBg : undefined }} onClick={() => { onToolChange(item.mode); setToolMenu(null); }}>
                            {item.icon}<span>{item.label}</span><kbd>{item.key}</kbd>
                        </button>
                    )) : toolMenu === "history" ? entries.filter((entry) => entry.id === "tool-undo" || entry.id === "tool-redo").map((entry) => entry.kind !== "separator" ? (
                        <button key={entry.id} type="button" role="menuitem" disabled={entry.disabled} className="canvas-reference-menu-row" onClick={(event) => { entry.onClick?.(event); setToolMenu(null); }}>{entry.icon}<span>{entry.label}</span></button>
                    ) : null) : (
                        <>
                            <div className="canvas-reference-help-copy">V 移动并框选节点，H 拖动画布。按住空格可临时使用抓手，滚轮缩放。</div>
                            {entries.filter((entry) => entry.id === "tool-delete" || entry.id === "tool-clear").map((entry) => entry.kind !== "separator" ? (
                                <button key={entry.id} type="button" role="menuitem" className="canvas-reference-menu-row" disabled={entry.disabled} onClick={(event) => { setToolMenu(null); entry.onClick?.(event); }}>{entry.icon}<span>{entry.label}</span></button>
                            ) : null)}
                        </>
                    )}
                </div>
            ) : null}

        </div>
    );
}

function CanvasAgentLauncher({ open, theme, onOpen }: { open: boolean; theme: CanvasTheme; onOpen: () => void }) {
    const reducedMotion = useReducedMotion();

    return (
        <span className="group/agent pointer-events-auto relative ml-2 flex size-12 shrink-0 items-center justify-center">
            <motion.button
                type="button"
                aria-label="打开 Agent"
                aria-expanded={open}
                title="打开 Agent"
                className="grid size-12 place-items-center rounded-full border outline-none backdrop-blur-2xl transition-colors focus-visible:ring-2"
                style={{
                    // 外层只保留点击区域，视觉上只显示圆形 Agent 光标，避免出现方形底框。
                    background: "transparent",
                    borderColor: open ? theme.accent.primary : "transparent",
                    boxShadow: open ? `0 0 0 2px ${theme.accent.primarySoft}` : "none",
                }}
                whileHover={reducedMotion ? undefined : { y: -2, scale: 1.03 }}
                whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                transition={aceternityMotion.spring.dock}
                onClick={onOpen}
            >
                <motion.span
                    aria-hidden="true"
                    className="relative grid size-8 place-items-center overflow-hidden rounded-full"
                    style={{
                        background: `conic-gradient(from 30deg, ${theme.accent.primary}, ${theme.timeline.clipAudio}, ${theme.timeline.clipSubtitle}, ${theme.spatial.glowStrong}, ${theme.accent.primary})`,
                        boxShadow: `inset 0 0 0 1px ${theme.toolbar.border}, 0 0 14px ${theme.spatial.glowStrong}`,
                    }}
                    animate={reducedMotion ? { rotate: 0 } : { rotate: 360 }}
                    transition={reducedMotion ? undefined : { duration: 6, ease: "linear", repeat: Infinity }}
                >
                    <span
                        className="absolute inset-1 rounded-full"
                        style={{ background: `radial-gradient(circle at 34% 28%, ${theme.toolbar.panel}, transparent 38%), radial-gradient(circle at 58% 68%, ${theme.accent.primarySoft}, transparent 66%)` }}
                    />
                    <span className="relative size-2 rounded-full" style={{ background: theme.toolbar.activeText, boxShadow: `0 0 10px ${theme.toolbar.panel}` }} />
                </motion.span>
            </motion.button>
            <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium opacity-0 shadow-sm transition-opacity group-hover/agent:opacity-100 group-focus-within/agent:opacity-100"
                style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text }}
            >
                打开 Agent
            </span>
        </span>
    );
}

function AddNodeMenu({ x, theme, commands }: {
    x: number;
    theme: CanvasTheme;
    commands: CanvasCreateCommand[];
}) {
    const reducedMotion = useReducedMotion();
    const panelRef = useRef<HTMLDivElement>(null);
    const [left, setLeft] = useState(x);

    useLayoutEffect(() => {
        const panel = panelRef.current;
        const parent = panel?.parentElement;
        if (!panel || !parent) return;
        const place = () => {
            const halfWidth = panel.offsetWidth / 2;
            setLeft(Math.max(halfWidth, Math.min(x || parent.clientWidth / 2, parent.clientWidth - halfWidth)));
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(parent);
        observer.observe(panel);
        return () => observer.disconnect();
    }, [x]);

    return (
        <motion.div ref={panelRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: aceternityMotion.duration.instant }} className="canvas-reference-create-panel pointer-events-auto absolute bottom-[var(--canvas-dock-popover-offset)] z-[var(--dock-z-popover)] w-[var(--canvas-create-menu-width)] max-w-full -translate-x-1/2" style={{ left: left || "50%" }}>
            <motion.div
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
                className="canvas-command-panel canvas-command-dock"
                style={{
                    "--canvas-command-bg": theme.toolbar.panel,
                    "--canvas-command-border": theme.toolbar.border,
                    "--canvas-command-text": theme.node.text,
                    "--canvas-command-muted": theme.node.muted,
                    "--canvas-command-hover": theme.toolbar.itemHover,
                    "--canvas-command-active": theme.toolbar.activeBg,
                } as CSSProperties}
                data-canvas-no-zoom
                onWheel={(event) => event.stopPropagation()}
            >
                <CanvasCreateMenu commands={commands} />
            </motion.div>
        </motion.div>
    );
}

function getPanelX(dock: HTMLDivElement | null, target: HTMLElement) {
    if (!dock) return 0;
    const rootBox = dock.parentElement?.getBoundingClientRect() || dock.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - rootBox.left + box.width / 2;
}
