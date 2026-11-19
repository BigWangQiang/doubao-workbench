import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Compass, Focus, LayoutGrid, Minus, Plus } from "lucide-react";

import { FloatingDock, type FloatingDockEntry } from "@/components/ui/aceternity/floating-dock";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import { canvasThemes } from "@/lib/canvas-theme";
import { subscribeCanvasViewportPreview } from "@/lib/canvas/canvas-live-viewport";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasZoomControlsProps = {
    scale: number;
    onScaleChange: (scale: number) => void;
    onReset: () => void;
    isMiniMapOpen: boolean;
    onToggleMiniMap: () => void;
    onArrange?: () => void;
    containerRef?: RefObject<HTMLDivElement | null>;
};

const QUICK_ZOOM_LEVELS = [0.25, 0.5, 1, 2] as const;

export function CanvasZoomControls({ scale, onScaleChange, onReset, isMiniMapOpen, onToggleMiniMap, onArrange, containerRef }: CanvasZoomControlsProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const rootRef = useRef<HTMLDivElement>(null);
    const liveScaleRef = useRef(scale);
    const rangeRef = useRef<HTMLInputElement>(null);
    const dockLabelRef = useRef<HTMLSpanElement>(null);
    const panelLabelRef = useRef<HTMLSpanElement>(null);
    const [precisionOpen, setPrecisionOpen] = useState(false);

    useEffect(() => updateScaleDisplay(scale), [scale]);

    useEffect(() => {
        const container = containerRef?.current;
        if (!container) return;
        return subscribeCanvasViewportPreview(container, (viewport) => updateScaleDisplay(viewport.k));
    }, [containerRef]);

    useEffect(() => {
        if (!precisionOpen) return;
        const close = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setPrecisionOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setPrecisionOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", close, true);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [precisionOpen]);

    function updateScaleDisplay(nextScale: number) {
        liveScaleRef.current = nextScale;
        const percent = String(Math.round(nextScale * 100));
        if (rangeRef.current) rangeRef.current.value = percent;
        if (dockLabelRef.current) dockLabelRef.current.textContent = percent;
        if (panelLabelRef.current) panelLabelRef.current.textContent = `${percent}%`;
    }

    function commitScale(nextScale: number) {
        const clampedScale = Math.min(2, Math.max(0.05, nextScale));
        updateScaleDisplay(clampedScale);
        onScaleChange(clampedScale);
    }

    const items: FloatingDockEntry[] = [
        { id: "zoom-minimap", label: isMiniMapOpen ? "关闭小地图" : "打开小地图", icon: <Compass />, active: isMiniMapOpen, onClick: onToggleMiniMap },
        { id: "zoom-fit", label: "适应全部内容", icon: <Focus />, onClick: onReset },
        {
            id: "zoom-precision",
            label: "精确缩放",
            wide: true,
            quiet: true,
            icon: <span className="inline-flex h-full items-center justify-center whitespace-nowrap text-sm font-medium leading-none tabular-nums"><span ref={dockLabelRef}>{Math.round(scale * 100)}</span><span>%</span></span>,
            active: precisionOpen,
            expands: true,
            onClick: () => setPrecisionOpen((value) => !value),
        },
        ...(onArrange ? [{ id: "zoom-arrange", label: "一键整理画布", icon: <LayoutGrid />, onClick: onArrange }] : []),
    ];

    return (
        <div ref={rootRef} data-canvas-no-zoom className="relative z-[var(--z-toolbar)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <AnimatePresence>
                {precisionOpen ? (
                    <motion.div
                        initial={{ opacity: 0, y: 14, scale: 0.92 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 9, scale: 0.96 }}
                        transition={aceternityMotion.spring.panel}
                        className="aceternity-floating-panel absolute bottom-[var(--canvas-dock-popover-offset)] left-0 w-[220px] overflow-hidden rounded-[var(--panel-radius)] border p-2.5 backdrop-blur-2xl"
                        style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 28px 80px ${theme.spatial.shadow}` }}
                    >
                        <div className="absolute inset-x-10 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${theme.spatial.glowStrong}, transparent)` }} />
                        <div className="flex items-center justify-between gap-3">
                            <span>
                                <span className="block text-[var(--fs-tiny)] font-semibold">画布尺度</span>
                                <span className="mt-0.5 block text-[var(--fs-micro)]" style={{ color: theme.node.muted }}>精确控制视野密度</span>
                            </span>
                            <span ref={panelLabelRef} className="rounded-full border px-2 py-0.5 text-[var(--fs-tiny)] font-semibold tabular-nums" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border, color: theme.accent.primary }}>
                                {Math.round(scale * 100)}%
                            </span>
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                            <button type="button" className="grid size-7 shrink-0 place-items-center rounded-[var(--dock-item-radius)] border outline-none hover:brightness-110 focus-visible:ring-2" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }} onClick={() => commitScale(liveScaleRef.current - 0.1)} aria-label="缩小画布" title="缩小画布">
                                <Minus className="size-3.5" />
                            </button>
                            <input
                                ref={rangeRef}
                                type="range"
                                min="5"
                                max="200"
                                step="1"
                                defaultValue={Math.round(scale * 100)}
                                className="aceternity-zoom-range h-4 min-w-0 flex-1"
                                style={{ accentColor: theme.accent.primary }}
                                onChange={(event) => commitScale(Number(event.target.value) / 100)}
                                aria-label="精确缩放画布"
                            />
                            <button type="button" className="grid size-7 shrink-0 place-items-center rounded-[var(--dock-item-radius)] border outline-none hover:brightness-110 focus-visible:ring-2" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }} onClick={() => commitScale(liveScaleRef.current + 0.1)} aria-label="放大画布" title="放大画布">
                                <Plus className="size-3.5" />
                            </button>
                        </div>
                        <div className="mt-2.5 grid grid-cols-4 gap-1">
                            {QUICK_ZOOM_LEVELS.map((level) => (
                                <motion.button
                                    key={level}
                                    type="button"
                                    whileHover={{ y: -1 }}
                                    whileTap={{ scale: 0.95 }}
                                    transition={aceternityMotion.spring.dock}
                                    className="h-7 rounded-[var(--dock-item-radius)] border text-[var(--fs-micro)] font-semibold tabular-nums outline-none focus-visible:ring-2"
                                    style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border, color: theme.node.muted }}
                                    onClick={() => commitScale(level)}
                                >
                                    {Math.round(level * 100)}%
                                </motion.button>
                            ))}
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>

            <FloatingDock items={items} size="compact" magnify={false} className="canvas-floating-dock canvas-reference-utility-dock" style={canvasDockStyle(theme)} ariaLabel="画布视图控制" />
        </div>
    );
}
