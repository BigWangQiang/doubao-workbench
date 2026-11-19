import { Fragment, type CSSProperties } from "react";
import { AlignLeft, AudioLines, Check, ChevronUp, FileText, FolderKanban, ImagePlus, Images, MousePointer2, Palette, Pencil, Plus, Sparkles, Type, Video, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasShortDramaProgress, CanvasShortDramaStepId } from "@/lib/canvas/canvas-short-drama";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasLinkedProjectEmptyState({ projectName, hasChapter, onAddFirstChapter, onOpenAssets, onAddText }: { projectName: string; hasChapter: boolean; onAddFirstChapter: () => void; onOpenAssets: () => void; onAddText: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4 pb-16 pt-20">
            <div className="pointer-events-auto w-full max-w-[440px] rounded-lg border p-3 shadow-sm backdrop-blur" data-canvas-no-zoom style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <div className="flex items-center gap-2.5"><span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}><FolderKanban className="size-4" /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{projectName}</h2><p className="mt-0.5 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>项目画布为空</p></div></div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                    <button type="button" disabled={!hasChapter} onClick={onAddFirstChapter} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium disabled:opacity-35" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}><Plus className="size-3.5 shrink-0" /><span className="truncate">添加首章</span></button>
                    <button type="button" onClick={onOpenAssets} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}><Images className="size-3.5 shrink-0" /><span className="truncate">项目资产</span></button>
                    <button type="button" onClick={onAddText} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}><Type className="size-3.5 shrink-0" /><span className="truncate">新建文本</span></button>
                </div>
            </div>
        </div>
    );
}

export function CanvasStartEmptyState({ onAddImage, onAddVideo, onAddAudio, onAddScript, onSmartEdit }: {
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddScript: () => void;
    onSmartEdit: () => void;
}) {
    const theme = canvasThemes.dark;
    const focusStyle = { "--tw-ring-color": theme.accent.primary } as CSSProperties;
    const entries = [
        { id: "image", icon: <ImagePlus className="size-5" />, title: "图片生成", onClick: onAddImage },
        { id: "video", icon: <Video className="size-5" />, title: "视频生成", onClick: onAddVideo },
        { id: "audio", icon: <AudioLines className="size-5" />, title: "音频生成", onClick: onAddAudio },
        { id: "script", icon: <FileText className="size-5" />, title: "剧本生成", onClick: onAddScript },
        { id: "smart-edit", icon: <Sparkles className="size-5" />, title: "智能剪辑", onClick: onSmartEdit },
    ];
    return (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4 pb-24 pt-8">
            <div className="pointer-events-auto max-h-full w-full max-w-7xl overflow-y-auto" data-canvas-no-zoom>
                <div className="mb-8 flex items-center justify-center gap-2 text-center text-sm font-medium" style={{ color: theme.node.muted }}>
                    <MousePointer2 aria-hidden="true" className="size-4" />
                    <span>双击画布 自由生成节点</span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    {entries.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            className="group flex min-h-16 min-w-0 items-center gap-3 rounded-xl border px-3 text-left text-sm font-semibold outline-none transition-colors hover:brightness-110 focus-visible:ring-2"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, ...focusStyle }}
                            onClick={entry.onClick}
                        >
                            <span className="grid size-10 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.itemHover, color: theme.node.text }}>
                                {entry.icon}
                            </span>
                            <span className="truncate">{entry.title}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

export function CanvasShortDramaGuide({ progress, collapsed, onToggle, onSkip, onStepClick }: {
    progress: CanvasShortDramaProgress;
    collapsed: boolean;
    onToggle: () => void;
    onSkip: () => void;
    onStepClick: (stepId: CanvasShortDramaStepId) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!progress.active || collapsed) return null;
    return (
        <div data-canvas-no-zoom className="absolute left-1/2 top-[var(--canvas-topbar-offset)] z-[var(--z-toolbar)] flex max-w-[calc(100%_-_24px)] -translate-x-1/2 items-center gap-1 rounded-lg border p-1 shadow-sm backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <div className="hide-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto">
                <div className="flex shrink-0 items-center px-[var(--space-1)]">
                    {progress.steps.map((step, index) => (
                        <Fragment key={step.id}>
                            {index ? (
                                <span
                                    aria-hidden
                                    className="shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none"
                                    style={{ width: "var(--flow-step-track-width)", height: "var(--flow-step-track-height)", background: step.status === "pending" ? theme.node.stroke : theme.accent.primary }}
                                />
                            ) : null}
                            <button
                                type="button"
                                aria-current={step.status === "current" ? "step" : undefined}
                                className="flex h-8 shrink-0 items-center gap-[var(--flow-step-gap)] rounded-md px-[var(--space-1-half)] outline-none transition-colors motion-reduce:transition-none hover:bg-black/5 focus-visible:ring-1 focus-visible:ring-inset dark:hover:bg-white/10"
                                style={{ "--tw-ring-color": theme.accent.primary } as CSSProperties}
                                onClick={() => onStepClick(step.id)}
                            >
                                <span
                                    className="grid shrink-0 place-items-center rounded-full font-semibold transition-all duration-150 motion-reduce:transition-none"
                                    style={{
                                        width: step.status === "current" ? "var(--flow-step-node-current)" : "var(--flow-step-node)",
                                        height: step.status === "current" ? "var(--flow-step-node-current)" : "var(--flow-step-node)",
                                        background: step.status === "pending" ? "transparent" : theme.accent.primary,
                                        border: step.status === "pending" ? "var(--stroke-2) solid var(--cn-stroke)" : "none",
                                        color: step.status === "pending" ? theme.node.muted : "#fff",
                                        boxShadow: step.status === "current" ? "var(--flow-step-current-glow)" : undefined,
                                        fontSize: step.status === "current" ? "var(--fs-body)" : "var(--fs-caption)",
                                    }}
                                >
                                    {step.status === "completed" ? <Check className="size-3.5" /> : index + 1}
                                </span>
                                <span
                                    className="whitespace-nowrap text-[var(--fs-caption)] font-semibold transition-colors duration-150 motion-reduce:transition-none"
                                    style={{ color: step.status === "current" ? theme.accent.primary : step.status === "completed" ? theme.node.text : theme.node.muted }}
                                >
                                    {step.label}
                                </span>
                            </button>
                        </Fragment>
                    ))}
                </div>
            </div>
            <span className="mx-1 h-4 w-px shrink-0" style={{ background: theme.toolbar.border }} />
            {!progress.completed ? <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[var(--fs-label)] outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.muted, "--tw-ring-color": theme.accent.primary } as CSSProperties} onClick={onSkip}><X className="size-3" />跳过导引</button> : null}
            <button type="button" className="grid size-8 shrink-0 place-items-center rounded-md outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.muted, "--tw-ring-color": theme.accent.primary } as CSSProperties} onClick={onToggle} aria-label="折叠短剧流程"><ChevronUp className="size-3.5" /></button>
        </div>
    );
}

export function CanvasStylePlaceholderNodeContent({ onChoose }: { onChoose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center" style={{ color: theme.node.text }}>
            <span className="grid size-10 place-items-center rounded-md" style={{ background: `${theme.accent.primary}16`, color: theme.accent.primary }}><Palette className="size-5" /></span>
            <div className="mt-3 text-sm font-semibold">项目画风</div>
            <div className="mt-1 text-xs" style={{ color: theme.node.muted }}>待选择</div>
            <button type="button" className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium outline-none transition hover:brightness-105 focus-visible:ring-2" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, "--tw-ring-color": theme.accent.primary } as CSSProperties} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onChoose(); }}><Sparkles className="size-3.5" />选择画风</button>
        </div>
    );
}

export function CanvasStoryInputNodeContent({ node, onEdit }: { node: CanvasNodeData; onEdit: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const content = (node.metadata?.content || "").replace(/\s+/g, " ").trim();
    return (
        <div className="flex h-full w-full flex-col overflow-hidden p-4" style={{ color: theme.node.text }}>
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2"><span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}><AlignLeft className="size-4" /></span><span className="truncate text-sm font-semibold">故事梗概</span></div>
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-hidden border-t pt-3 text-xs leading-6" style={{ borderColor: theme.node.stroke, color: content ? theme.node.muted : theme.node.placeholder }}>{content || "写下题材、角色、冲突和结局方向…"}</div>
            <button type="button" className="mt-3 inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.text, "--tw-ring-color": theme.accent.primary } as CSSProperties} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onEdit(); }}><Pencil className="size-3.5" />编辑故事</button>
        </div>
    );
}
