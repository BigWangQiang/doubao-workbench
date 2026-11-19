import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, Clipboard, Copy, FolderPlus, Image as ImageIcon, Layers3, Link2, Maximize2, PanelTop, Pencil, Tags, Trash2, UserRound } from "lucide-react";

import { CanvasCreateMenu, type CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasNodeAssetCategory } from "@/lib/canvas/canvas-node-asset";
import { resolveAddNodeMenuCommands, type AddNodeMenuContext } from "@/lib/canvas/tool-registry";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasWorkspaceMode, type ContextMenuState, type Position } from "@/types/canvas";

type CanvasAssetCategory = NonNullable<NonNullable<CanvasNodeData["metadata"]>["assetCategory"]>;

const assetCategoryOptions: Array<{ value: CanvasAssetCategory; label: string }> = [
    { value: "character", label: "角色" },
    { value: "environment", label: "场景" },
    { value: "wardrobe", label: "服饰" },
    { value: "prop", label: "道具" },
    { value: "weapon", label: "武器" },
    { value: "style", label: "画风" },
    { value: "other", label: "其他" },
];

type CanvasNodeContextMenuProps = {
    menu: ContextMenuState;
    node?: CanvasNodeData | null;
    workspaceMode?: CanvasWorkspaceMode;
    isProjectLinked?: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canPaste: boolean;
    onClose: () => void;
    onAddNode: (type: CanvasNodeType) => void;
    onChooseStyle: () => void;
    onOpenDirector: (position: Position) => void;
    onOpenViralVideo: () => void;
    onOpenScreenplay: () => void;
    onUpload: () => void;
    onOpenAssets: () => void;
    onOpenProjectCharacters: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onPaste: () => void;
    onCopyNode: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onSaveAsset: () => void;
    onViewMedia: () => void;
    onEditText: () => void;
    onOpenDrawing: () => void;
    onGenerateImage: () => void;
    onCopyContent: () => void;
    onCopyMediaUrl: () => void;
    onSetAssetCategory: (category: CanvasAssetCategory) => void;
    onToggleFrame: () => void;
};

export function CanvasNodeContextMenu({
    menu,
    node,
    workspaceMode = "professional",
    isProjectLinked = false,
    canUndo,
    canRedo,
    canPaste,
    onClose,
    onAddNode,
    onChooseStyle,
    onOpenDirector,
    onOpenViralVideo,
    onOpenScreenplay,
    onUpload,
    onOpenAssets,
    onOpenProjectCharacters,
    onUndo,
    onRedo,
    onPaste,
    onCopyNode,
    onDuplicate,
    onDelete,
    onSaveAsset,
    onViewMedia,
    onEditText,
    onOpenDrawing,
    onGenerateImage,
    onCopyContent,
    onCopyMediaUrl,
    onSetAssetCategory,
    onToggleFrame,
}: CanvasNodeContextMenuProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const reducedMotion = useReducedMotion();
    const [addOpen, setAddOpen] = useState(false);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ left: menu.x, top: menu.y, width: 0 });

    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        // 按实际菜单尺寸避让边界，避免新增条目后继续使用过期的估算高度。
        const place = () => {
            const next = { ...getContextMenuPosition(menu, panel.offsetWidth, panel.offsetHeight), width: panel.offsetWidth };
            setPosition((current) => current.left === next.left && current.top === next.top && current.width === next.width ? current : next);
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(panel);
        window.addEventListener("resize", place);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", place);
        };
    }, [menu.x, menu.y, menu.type]);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (categoryOpen) setCategoryOpen(false);
            else if (addOpen) setAddOpen(false);
            else onClose();
        };
        window.addEventListener("pointerdown", close);
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            window.removeEventListener("pointerdown", close);
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [addOpen, categoryOpen, onClose]);

    useEffect(() => {
        setAddOpen(false);
        setCategoryOpen(false);
    }, [menu.type, menu.x, menu.y]);

    const runAction = (action: () => void) => {
        action();
        onClose();
    };
    const nodeContent = typeof node?.metadata?.content === "string" ? node.metadata.content : "";
    const isImage = node?.type === CanvasNodeType.Image;
    const isText = node?.type === CanvasNodeType.Text;
    const isCharacterReference = Boolean(isText && node?.metadata?.workflowKind === "character" && node.metadata.characterAssetId);
    const isDrawing = node?.type === CanvasNodeType.Drawing;
    const isVideo = node?.type === CanvasNodeType.Video;
    const isMedia = isImage || isVideo;
    const isAudio = node?.type === CanvasNodeType.Audio;
    const isFrame = node?.type === CanvasNodeType.Frame;
    const hasNodeContent = isText ? Boolean(nodeContent.trim()) : Boolean(nodeContent);
    const canSaveAsset = Boolean(node && !isCharacterReference && (isText ? hasNodeContent : hasNodeContent && (isImage || isVideo || isAudio)));
    const canOpenPreview = Boolean(isMedia && hasNodeContent);
    const canGenerateFromText = Boolean(isText && !isCharacterReference && hasNodeContent);
    const canCopyMediaUrl = Boolean(isMedia && hasNodeContent);
    const assetCategory = node ? canvasNodeAssetCategory(node) : "other";

    return (
        <>
            <motion.div
                ref={panelRef}
                data-canvas-context-menu
                data-canvas-no-zoom
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, x: -3, y: -3 }}
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
                className="canvas-command-panel canvas-command-context"
                style={{
                    left: position.left,
                    top: position.top,
                    "--canvas-command-bg": theme.toolbar.panel,
                    "--canvas-command-border": theme.toolbar.border,
                    "--canvas-command-text": theme.node.text,
                    "--canvas-command-muted": theme.node.muted,
                    "--canvas-command-hover": theme.toolbar.itemHover,
                    "--canvas-command-active": theme.toolbar.activeBg,
                } as CSSProperties}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
                <div className="canvas-command-list thin-scrollbar" data-canvas-wheel-scroll>
                    {menu.type === "node" && isMedia && categoryOpen ? (
                        <>
                            <MenuHeader title="设置资产分类" description={node?.title || nodeTypeLabel(node)} onBack={() => setCategoryOpen(false)} />
                            <MenuSection label="项目用途" />
                            {assetCategoryOptions.map((option) => (
                                <MenuButton
                                    key={option.value}
                                    icon={assetCategory === option.value ? <Check /> : <Tags />}
                                    label={option.label}
                                    active={assetCategory === option.value}
                                    onClick={() => runAction(() => onSetAssetCategory(option.value))}
                                />
                            ))}
                        </>
                    ) : menu.type === "canvas" ? (
                        <>
                            <MenuButton label="上传" onClick={() => runAction(onUpload)} />
                            <MenuButton label="保存到我的素材" disabled />
                            <MenuButton label="添加节点" chevron active={addOpen} expanded={addOpen} onClick={() => setAddOpen((value) => !value)} />
                            <MenuDivider />
                            <MenuButton label="撤销" shortcut="⌘Z" disabled={!canUndo} onClick={() => runAction(onUndo)} />
                            <MenuButton label="重做" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => runAction(onRedo)} />
                            <MenuDivider />
                            <MenuButton label="粘贴" shortcut="⌘V" disabled={!canPaste} onClick={() => runAction(onPaste)} />
                        </>
                    ) : menu.type === "node" ? (
                        <>
                            {isCharacterReference ? (
                                <>
                                    <MenuHeader title="角色卡" description={node?.metadata?.characterName || node?.title} />
                                    <MenuSection label="角色引用" />
                                    <MenuButton icon={<UserRound />} label="查看角色详情" onClick={() => runAction(onEditText)} />
                                    <MenuDivider />
                                    <MenuSection label="节点" />
                                    <MenuButton icon={<Copy />} label="复制角色引用" shortcut="⌘C" onClick={() => runAction(onCopyNode)} />
                                    <MenuButton icon={<Layers3 />} label="创建引用副本" shortcut="⌘D" onClick={() => runAction(onDuplicate)} />
                                    <MenuButton icon={<Trash2 />} label="删除节点" danger onClick={() => runAction(onDelete)} />
                                </>
                            ) : isMedia ? (
                                <>
                                    <MenuHeader title={isImage ? "图片" : "视频"} description={node?.title || nodeTypeLabel(node)} />
                                    <MenuSection label="查看与归档" />
                                    <MenuButton icon={<Maximize2 />} label="进入全景预览" disabled={!canOpenPreview} onClick={() => runAction(onViewMedia)} />
                                    <MenuButton icon={<Tags />} label="设置资产分类" chevron onClick={() => setCategoryOpen(true)} />
                                    <MenuDivider />
                                    <MenuSection label="节点" />
                                    <MenuButton icon={<Copy />} label="复制节点" shortcut="⌘C" onClick={() => runAction(onCopyNode)} />
                                    <MenuButton icon={<Link2 />} label={isImage ? "复制图片地址" : "复制视频地址"} disabled={!canCopyMediaUrl} onClick={() => runAction(onCopyMediaUrl)} />
                                    <MenuButton icon={<Layers3 />} label="创建参数变体" shortcut="⌘D" onClick={() => runAction(onDuplicate)} />
                                    <MenuButton icon={<Trash2 />} label="删除节点" danger onClick={() => runAction(onDelete)} />
                                </>
                            ) : (
                                <>
                                    <MenuHeader title={node?.title || nodeTypeLabel(node)} />
                                    <MenuSection label="节点操作" />
                                    {isFrame ? <MenuButton icon={<PanelTop />} label={node?.metadata?.frame?.collapsed ? "展开背板" : "折叠背板"} onClick={() => runAction(onToggleFrame)} /> : <MenuButton icon={<FolderPlus />} label="保存到我的素材" disabled={!canSaveAsset} onClick={() => runAction(onSaveAsset)} />}
                                    {isText ? <MenuButton icon={<Maximize2 />} label="放大编辑" onClick={() => runAction(onEditText)} /> : null}
                                    {isDrawing ? <MenuButton icon={<Pencil />} label="打开绘图" onClick={() => runAction(onOpenDrawing)} /> : null}
                                    {isText ? <MenuButton icon={<ImageIcon />} label="用文本生图" disabled={!canGenerateFromText} onClick={() => runAction(onGenerateImage)} /> : null}
                                    <MenuDivider />
                                    <MenuSection label="副本与内容" />
                                    <MenuButton icon={<Copy />} label={isFrame ? "复制背板及内容" : "复制节点"} shortcut="⌘C" onClick={() => runAction(onCopyNode)} />
                                    {isText ? <MenuButton icon={<Clipboard />} label="复制文本" disabled={!hasNodeContent} onClick={() => runAction(onCopyContent)} /> : null}
                                    <MenuButton icon={<Copy />} label={isFrame ? "创建背板副本" : "创建参数变体"} shortcut="⌘D" onClick={() => runAction(onDuplicate)} />
                                    <MenuButton icon={<Clipboard />} label="粘贴" shortcut="⌘V" disabled={!canPaste} onClick={() => runAction(onPaste)} />
                                    <MenuButton icon={<Trash2 />} label={isFrame ? "删除背板" : "删除节点"} danger onClick={() => runAction(onDelete)} />
                                </>
                            )}
                        </>
                    ) : (
                        <>
                            <MenuHeader title="连接" />
                            <MenuButton icon={<Trash2 className="size-4" />} label="删除连接" danger onClick={() => runAction(onDelete)} />
                        </>
                    )}
                </div>
            </motion.div>

            <AnimatePresence>
                {menu.type === "canvas" && addOpen ? (
                    <AddNodeContextMenu
                        parentPosition={position}
                        workspaceMode={workspaceMode}
                        isProjectLinked={isProjectLinked}
                        reducedMotion={Boolean(reducedMotion)}
                        onAddNode={(type) => runAction(() => onAddNode(type))}
                        onChooseStyle={() => runAction(onChooseStyle)}
                        onOpenDirector={() => runAction(() => onOpenDirector(menu.position))}
                        onOpenViralVideo={() => runAction(onOpenViralVideo)}
                        onOpenScreenplay={() => runAction(onOpenScreenplay)}
                        onUpload={() => runAction(onUpload)}
                        onOpenAssets={() => runAction(onOpenAssets)}
                        onOpenProjectCharacters={() => runAction(onOpenProjectCharacters)}
                    />
                ) : null}
            </AnimatePresence>
        </>
    );
}

function AddNodeContextMenu({ parentPosition, workspaceMode, isProjectLinked, reducedMotion, onAddNode, onChooseStyle, onOpenDirector, onOpenViralVideo, onOpenScreenplay, onUpload, onOpenAssets, onOpenProjectCharacters }: { parentPosition: { left: number; top: number; width: number }; workspaceMode: CanvasWorkspaceMode; isProjectLinked: boolean; reducedMotion: boolean; onAddNode: (type: CanvasNodeType) => void; onChooseStyle: () => void; onOpenDirector: () => void; onOpenViralVideo: () => void; onOpenScreenplay: () => void; onUpload: () => void; onOpenAssets: () => void; onOpenProjectCharacters: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panelRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState(parentPosition);

    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const place = () => {
            const left = getSubmenuLeft(parentPosition, panel.offsetWidth);
            const top = clamp(parentPosition.top, 12, Math.max(12, window.innerHeight - panel.offsetHeight - 12));
            setPosition((current) => current.left === left && current.top === top ? current : { ...current, left, top });
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(panel);
        window.addEventListener("resize", place);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", place);
        };
    }, [parentPosition.left, parentPosition.top, parentPosition.width]);
    const createContext: AddNodeMenuContext = {
        workspaceMode,
        isProjectLinked,
        handlers: {
            onAddText: () => onAddNode(CanvasNodeType.Text),
            onAddImage: () => onAddNode(CanvasNodeType.Image),
            onAddVideo: () => onAddNode(CanvasNodeType.Video),
            onAddAudio: () => onAddNode(CanvasNodeType.Audio),
            onAddScript: () => onAddNode(CanvasNodeType.Script),
            onAddFrame: () => onAddNode(CanvasNodeType.Frame),
            onAddDrawing: () => onAddNode(CanvasNodeType.Drawing),
            onChooseStyle,
            onOpenDirector,
            onOpenViralVideo,
            onOpenScreenplay,
            onUpload,
            onOpenMyAssets: onOpenAssets,
            onOpenProjectCharacters,
        },
    };
    const commands: CanvasCreateCommand[] = resolveAddNodeMenuCommands(createContext).map((command) => ({
        id: command.id,
        label: command.label,
        icon: command.icon,
        badge: command.badge,
        badgeTone: command.badgeTone,
        section: command.section,
        onClick: () => command.run(createContext),
    }));

    return (
        <motion.div
            ref={panelRef}
            data-canvas-context-menu
            data-canvas-no-zoom
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
            className="canvas-command-panel canvas-command-submenu"
            style={{
                left: position.left,
                top: position.top,
                "--canvas-command-bg": theme.toolbar.panel,
                "--canvas-command-border": theme.toolbar.border,
                "--canvas-command-text": theme.node.text,
                "--canvas-command-muted": theme.node.muted,
                "--canvas-command-hover": theme.toolbar.itemHover,
                "--canvas-command-active": theme.toolbar.activeBg,
            } as CSSProperties}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasCreateMenu commands={commands} />
        </motion.div>
    );
}

function MenuHeader({ title, description, onBack }: { title: string; description?: string; onBack?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="mb-0.5 flex items-start gap-1 px-1.5 py-1.5">
            {onBack ? <button type="button" onClick={onBack} className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md outline-none hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/8" aria-label="返回媒体操作"><ArrowLeft className="size-3.5" /></button> : null}
            <span className="min-w-0"><span className="block truncate text-xs font-semibold">{title}</span>{description && description !== title ? <span className="mt-0.5 block truncate text-[var(--fs-micro)]" style={{ color: theme.node.muted }}>{description}</span> : null}</span>
        </div>
    );
}

function MenuSection({ label }: { label: string }) {
    return <div className="px-2 pb-1 pt-1.5 text-[var(--fs-micro)] font-medium opacity-45">{label}</div>;
}

function MenuButton({ icon, label, detail, shortcut, badge, chevron = false, active = false, expanded, disabled = false, danger = false, onClick }: { icon?: ReactNode; label: string; detail?: string; shortcut?: string; badge?: string; chevron?: boolean; active?: boolean; expanded?: boolean; disabled?: boolean; danger?: boolean; onClick?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const color = danger ? theme.accent.danger : theme.node.text;
    return (
        <button
            type="button"
            className="canvas-command-row"
            style={danger ? { color } : undefined}
            data-active={active || undefined}
            aria-expanded={expanded}
            disabled={disabled}
            onClick={onClick}
        >
            {icon ? <span className="canvas-command-icon" aria-hidden="true">{icon}</span> : null}
            <span className="canvas-command-label">{label}{detail ? <span className="block text-xs" style={{ color: theme.node.muted }}>{detail}</span> : null}</span>
            {badge ? <span className="canvas-command-badge">{badge}</span> : null}
            {shortcut ? <kbd className="canvas-command-shortcut">{shortcut}</kbd> : null}
            {chevron ? <ChevronRight className="canvas-command-chevron" aria-hidden="true" /> : null}
        </button>
    );
}

function MenuDivider() {
    return <div className="canvas-command-divider" role="separator" />;
}

function getContextMenuPosition(menu: ContextMenuState, width: number, height: number) {
    if (typeof window === "undefined") return { left: menu.x, top: menu.y };
    return {
        left: clamp(menu.x, 12, Math.max(12, window.innerWidth - width - 12)),
        top: clamp(menu.y, 12, Math.max(12, window.innerHeight - height - 12)),
    };
}

function getSubmenuLeft(parent: { left: number; width: number }, width: number) {
    const right = parent.left + parent.width + 8;
    if (typeof window === "undefined" || right + width <= window.innerWidth - 12) return right;
    return clamp(parent.left - width - 8, 12, Math.max(12, window.innerWidth - width - 12));
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function nodeTypeLabel(node?: CanvasNodeData | null) {
    if (!node) return "节点";
    if (node.type === CanvasNodeType.Image) return "图片节点";
    if (node.type === CanvasNodeType.Text) return "文本节点";
    if (node.type === CanvasNodeType.Script) return "分镜脚本节点";
    if (node.type === CanvasNodeType.Skill) return "技能节点";
    if (node.type === CanvasNodeType.Video) return "视频节点";
    if (node.type === CanvasNodeType.Audio) return "音频节点";
    if (node.type === CanvasNodeType.Drawing) return "绘图节点";
    if (node.type === CanvasNodeType.Frame) return "背板";
    return "生成配置节点";
}
