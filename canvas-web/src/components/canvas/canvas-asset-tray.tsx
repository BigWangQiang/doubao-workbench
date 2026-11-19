import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Crosshair, FolderOpen, ImageIcon, Images, PanelLeft, PanelLeftClose, Plus, Search, X } from "lucide-react";

import { PersistentResourceImage } from "@/components/persistent-resource-image";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasThemes } from "@/lib/canvas-theme";
import { resourceStorageTitle } from "@/lib/canvas/resource-storage-status";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ImageAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export const CANVAS_IMAGE_ASSET_DND_TYPE = "application/x-infinite-canvas-image-asset";

type TrayTab = "library" | "canvas";

const TRAY_DEFAULT_WIDTH = 320;
const TRAY_MIN_WIDTH = 280;
const TRAY_MAX_WIDTH = 440;

function getMaxTrayWidth() {
    if (typeof window === "undefined") return TRAY_MAX_WIDTH;
    return Math.max(TRAY_MIN_WIDTH, Math.min(TRAY_MAX_WIDTH, window.innerWidth * 0.82));
}

function clampTrayWidth(width: number) {
    return Math.min(Math.max(width, TRAY_MIN_WIDTH), getMaxTrayWidth());
}

type CanvasAssetTrayProps = {
    assetImages: ImageAsset[];
    canvasImages: CanvasNodeData[];
    showLibrary?: boolean;
    activeNodeId?: string | null;
    onInsertAssetImage: (asset: ImageAsset) => void;
    onFocusCanvasImage: (nodeId: string) => void;
};

export function CanvasAssetTray({ assetImages, canvasImages, showLibrary = true, activeNodeId, onInsertAssetImage, onFocusCanvasImage }: CanvasAssetTrayProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const reducedMotion = useReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [hasOpened, setHasOpened] = useState(false);
    const [tab, setTab] = useState<TrayTab>("canvas");
    const [keyword, setKeyword] = useState("");
    const [trayWidth, setTrayWidth] = useState(() => clampTrayWidth(TRAY_DEFAULT_WIDTH));
    const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
    const query = keyword.trim().toLowerCase();
    const filteredAssets = useMemo(() => assetImages.filter((asset) => !query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query)), [assetImages, query]);
    const filteredNodes = useMemo(() => canvasImages.filter((node) => !query || canvasImageTitle(node).toLowerCase().includes(query)), [canvasImages, query]);
    const activeItems = showLibrary && tab === "library" ? filteredAssets : filteredNodes;
    const safeTrayWidth = clampTrayWidth(trayWidth);
    const motionEnabled = !reducedMotion;

    useEffect(() => { if (open) setHasOpened(true); }, [open]);

    const startAssetDrag = (event: DragEvent<HTMLElement>, asset: ImageAsset) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(CANVAS_IMAGE_ASSET_DND_TYPE, asset.id);
        event.dataTransfer.setData("text/plain", asset.title);
    };

    const startResize = useCallback(
        (event: ReactPointerEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            resizeRef.current = { startX: event.clientX, startWidth: safeTrayWidth };

            const updateWidth = (moveEvent: PointerEvent) => {
                if (!resizeRef.current) return;
                setTrayWidth(clampTrayWidth(resizeRef.current.startWidth + moveEvent.clientX - resizeRef.current.startX));
            };
            const stopResize = () => {
                resizeRef.current = null;
                window.removeEventListener("pointermove", updateWidth);
                window.removeEventListener("pointerup", stopResize);
                window.removeEventListener("pointercancel", stopResize);
            };

            window.addEventListener("pointermove", updateWidth);
            window.addEventListener("pointerup", stopResize, { once: true });
            window.addEventListener("pointercancel", stopResize, { once: true });
        },
        [safeTrayWidth],
    );

    useEffect(() => {
        const syncWidth = () => setTrayWidth((width) => clampTrayWidth(width));
        window.addEventListener("resize", syncWidth);
        return () => window.removeEventListener("resize", syncWidth);
    }, []);

    useEffect(() => {
        if (!showLibrary && tab === "library") setTab("canvas");
    }, [showLibrary, tab]);

    useEffect(() => {
        if (!open) return;
        const closeTray = (event: PointerEvent) => {
            const target = event.target instanceof Node ? event.target : null;
            if (target && rootRef.current?.contains(target)) return;
            setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", closeTray, true);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeTray, true);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);

    const assetCount = (showLibrary ? assetImages.length : 0) + canvasImages.length;
    const toggleLabel = open ? "收起资产管理" : `打开资产管理，共 ${assetCount} 项`;

    return (
        <div ref={rootRef} data-canvas-no-zoom className="relative z-[var(--z-panel)] flex items-center" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                {open || hasOpened ? (
                    <motion.aside
                        initial={false}
                        animate={{ opacity: open ? 1 : 0, x: open ? 0 : -18 }}
                        transition={motionEnabled ? { duration: 0.16 } : { duration: 0 }}
                        inert={!open}
                        aria-hidden={!open}
                        aria-label="资产管理面板"
                        className="canvas-reference-asset-panel fixed inset-y-0 left-0 flex origin-left flex-col overflow-hidden border-r p-3"
                        style={{ background: theme.node.panel, borderColor: theme.toolbar.border, color: theme.node.text, width: safeTrayWidth, height: "100dvh", visibility: open ? "visible" : "hidden", pointerEvents: open ? "auto" : "none" }}
                    >
                        <button type="button" className="absolute inset-y-0 right-0 z-10 flex w-2 cursor-ew-resize items-center justify-center opacity-35 transition-opacity hover:opacity-80" onPointerDown={startResize} aria-label="调整资产管理侧栏宽度" title="拖动调整宽度">
                            <span className="h-12 w-px rounded-full bg-current" />
                        </button>

                        <div className="flex items-center justify-between gap-2 px-1 pb-2.5 pt-1.5">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="grid size-8 shrink-0 place-items-center rounded-[var(--dock-item-radius)] border" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border, color: theme.accent.primary }}>
                                    <FolderOpen className="size-3.5" />
                                </span>
                                <span className="min-w-0">
                                    <span className="block text-xs font-semibold">资产管理</span>
                                    <span className="mt-0.5 block truncate text-[var(--fs-micro)]" style={{ color: theme.node.muted }}>管理画布节点和可复用图片</span>
                                </span>
                            </div>
                            <motion.button type="button" whileHover={motionEnabled ? { rotate: -5, scale: 1.05 } : undefined} whileTap={motionEnabled ? { scale: 0.92 } : undefined} className="grid size-7 shrink-0 place-items-center rounded-full border outline-none focus-visible:ring-2" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border, color: theme.node.muted }} onClick={() => setOpen(false)} aria-label="收起素材空间">
                                <PanelLeftClose className="size-3" />
                            </motion.button>
                        </div>

                        <div role="tablist" aria-label="素材来源" className={cn("relative grid gap-1 rounded-[var(--r-lg)] p-0.5", showLibrary ? "grid-cols-2" : "grid-cols-1")} style={{ background: theme.spatial.surface }}>
                            <TrayTabButton active={tab === "canvas"} label={`画布 ${canvasImages.length}`} theme={theme} onClick={() => setTab("canvas")} />
                            {showLibrary ? <TrayTabButton active={tab === "library"} label={`资产 ${assetImages.length}`} theme={theme} onClick={() => setTab("library")} /> : null}
                        </div>

                        <label className="mt-3 flex h-9 items-center gap-2 rounded-[var(--r-lg)] border px-2.5 focus-within:ring-2" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}>
                            <Search className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                            <input type="search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索节点或图片..." className="min-w-0 flex-1 bg-transparent text-[var(--fs-tiny)] outline-none placeholder:opacity-55" aria-label="搜索节点或图片" />
                            {keyword ? <button type="button" className="grid size-6 shrink-0 place-items-center rounded-full opacity-55 hover:opacity-100" onClick={() => setKeyword("")} aria-label="清空搜索"><X className="size-3" /></button> : null}
                        </label>

                        <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                            {showLibrary ? <div hidden={tab !== "library"} role="tabpanel" aria-label="可复用图片">
                                {filteredAssets.length ? (
                                    <div className="space-y-1">
                                        {filteredAssets.map((asset) => (
                                            <AssetTrayRow key={asset.id} title={asset.title} imageUrl={asset.coverUrl || asset.data.dataUrl} storageKey={asset.data.storageKey} draggable motionEnabled={motionEnabled} onDragStart={(event) => startAssetDrag(event, asset)} onClick={() => onInsertAssetImage(asset)} icon={<Plus className="size-3.5" />} />
                                        ))}
                                    </div>
                                ) : (
                                    <TrayEmpty text="没有匹配的图片素材" theme={theme} />
                                )}
                            </div> : null}
                            <div hidden={showLibrary && tab !== "canvas"} role="tabpanel" aria-label="画布图片">
                            {filteredNodes.length ? (
                                <div className="space-y-1">
                                    {filteredNodes.map((node) => (
                                        <AssetTrayRow key={node.id} title={canvasImageTitle(node)} imageUrl={node.metadata?.content || ""} storageKey={node.metadata?.storageKey} active={activeNodeId === node.id} motionEnabled={motionEnabled} onClick={() => onFocusCanvasImage(node.id)} icon={<Crosshair className="size-3.5" />} />
                                    ))}
                                </div>
                            ) : (
                                <TrayEmpty text="当前画布没有匹配图片" theme={theme} />
                            )}
                            </div>
                        </div>

                        <div className="flex items-center justify-between px-1 pt-2.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                            <span>{showLibrary && tab === "library" ? "点击插入 · 拖拽定位" : "点击回到节点"}</span>
                            <span className="rounded-full border px-2 py-0.5 tabular-nums" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}>{activeItems.length} 项</span>
                        </div>
                    </motion.aside>
                ) : null}
            <button
                type="button"
                data-dock-command="asset-tray-toggle"
                aria-label={toggleLabel}
                aria-expanded={open}
                title={toggleLabel}
                className="canvas-reference-asset-toggle inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[var(--r-lg)] px-2 text-sm font-normal outline-none transition-colors focus-visible:ring-2"
                style={{ color: open ? theme.node.text : theme.node.muted, "--asset-toggle-hover": theme.toolbar.itemHover } as CSSProperties}
                onClick={() => setOpen((value) => !value)}
            >
                <PanelLeft className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span>资产管理</span>
                <span className="canvas-reference-asset-count" aria-hidden="true">{assetCount}</span>
            </button>
        </div>
    );
}

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

function TrayTabButton({ active, label, theme, onClick }: { active: boolean; label: string; theme: CanvasTheme; onClick: () => void }) {
    return (
        <button type="button" role="tab" aria-selected={active} className={cn("relative z-10 h-8 rounded-[var(--dock-item-radius)] px-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2", active ? "" : "opacity-55 hover:opacity-90")} style={{ color: active ? theme.node.text : theme.node.muted }} onClick={onClick}>
            {active ? <motion.span layoutId="canvas-asset-tray-active-tab" className="absolute inset-0 -z-10 rounded-[var(--dock-item-radius)] border" style={{ background: theme.node.panel, borderColor: theme.toolbar.border, boxShadow: `0 6px 16px ${theme.spatial.shadow}` }} transition={aceternityMotion.spring.dock} /> : null}
            {label}
        </button>
    );
}

function AssetTrayRow({ title, imageUrl, storageKey, icon, active = false, draggable = false, motionEnabled, onClick, onDragStart }: { title: string; imageUrl: string; storageKey?: string; icon: ReactNode; active?: boolean; draggable?: boolean; motionEnabled: boolean; onClick: () => void; onDragStart?: (event: DragEvent<HTMLElement>) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <motion.button
            type="button"
            draggable={draggable}
            whileTap={motionEnabled ? { scale: 0.99 } : undefined}
            transition={aceternityMotion.spring.dock}
            className="canvas-asset-row group flex h-12 w-full items-center gap-2 rounded-[var(--r-lg)] px-2 text-left outline-none focus-visible:ring-2"
            style={{ background: active ? theme.toolbar.activeBg : undefined, color: theme.node.text, "--asset-row-hover": theme.toolbar.itemHover } as CSSProperties}
            title={`${title} · ${resourceStorageTitle(storageKey)}`}
            aria-pressed={active}
            onClick={onClick}
            onDragStartCapture={onDragStart}
        >
            <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[var(--dock-item-radius)] border" style={{ background: theme.node.fill, borderColor: theme.toolbar.border }}>
                {imageUrl || storageKey ? <PersistentResourceImage src={imageUrl} storageKey={storageKey} thumbnail loading="lazy" alt="" width={36} height={36} className="size-full object-cover" draggable={false} /> : <ImageIcon className="size-3.5 opacity-55" />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{title}</span>
            </span>
            <span className="grid size-6 shrink-0 place-items-center opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70">{icon}</span>
        </motion.button>
    );
}

function TrayEmpty({ text, theme }: { text: string; theme: CanvasTheme }) {
    return (
        <div className="grid h-full min-h-[200px] place-items-center rounded-[var(--dock-radius)] border border-dashed text-center" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border, color: theme.node.muted }}>
            <span><Images className="mx-auto size-5 opacity-35" /><span className="mt-2 block text-xs opacity-55">{text}</span></span>
        </div>
    );
}

function canvasImageTitle(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Image) return node.title;
    return node.title || node.metadata?.prompt || "图片节点";
}
