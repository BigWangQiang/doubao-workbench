import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Bot, ChevronDown, Clapperboard, Focus, Gauge, KeyRound, LoaderCircle, Pencil, Search, Share2, X, Zap } from "lucide-react";
import { Button, Dropdown, Tooltip } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getTeam } from "@/services/api/teams";

import { WorkspaceUserAvatar } from "@/components/layout/workspace-user-avatar";
import { useWalletBalance } from "@/hooks/use-wallet-balance";
import { aceternityMotion } from "@/lib/aceternity-motion";
import type { CanvasContextSummary } from "@/lib/canvas/canvas-context-summary";
import type { CanvasShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasMediaPerformanceMode, CanvasWorkspaceMode } from "@/types/canvas";
import "./canvas-project-top-bar.css";
import { navigateToSettings } from "@/lib/settings-navigation";

type CanvasTopBarProps = {
    teamId?: string;
    hidden?: boolean;
    title: string;
    workspaceMode: CanvasWorkspaceMode;
    onWorkspaceModeChange: (mode: CanvasWorkspaceMode) => void;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onImportImage: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onShare: () => void;
    agentOpen: boolean;
    compactAgentStatus?: { connected: boolean; enabled: boolean; activity: string };
    onToggleAgent: () => void;
    shortcutRequestNonce: number;
    mediaPerformanceMode: CanvasMediaPerformanceMode;
    onMediaPerformanceModeChange: (mode: CanvasMediaPerformanceMode) => void;
    onOpenSearch: () => void;
    projectContext?: CanvasContextSummary & { projectId: string; projectName: string };
    onEnterFocusMode: () => void;
    shortDramaGuide?: { progress: CanvasShortDramaProgress; collapsed: boolean; onToggle: () => void };
};

const CANVAS_SHORTCUT_SECTIONS = [
    {
        title: "创作",
        items: [
            { label: "框选多个节点", keys: ["Shift / Ctrl / Cmd", "左键拖动"] },
            { label: "工具栏框选", keys: ["框选", "左键拖动"] },
            { label: "追加选择", keys: ["Shift / Ctrl / Cmd", "点击"] },
            { label: "移除选择", keys: ["Alt", "点击 / 框选"] },
            { label: "全选节点", keys: ["Ctrl / Cmd", "A"] },
            { label: "复制 / 粘贴", keys: ["Ctrl / Cmd", "C / V"] },
            { label: "提交生成", keys: ["Ctrl / Cmd", "Enter"] },
            { label: "上传素材", keys: ["拖入图片 / 视频 / 音频"] },
        ],
    },
    {
        title: "缩放",
        items: [
            { label: "放大", keys: ["Ctrl / Cmd", "+"] },
            { label: "缩小", keys: ["Ctrl / Cmd", "-"] },
            { label: "100% 比例", keys: ["Ctrl / Cmd", "0 / 1"] },
            { label: "适应全部", keys: ["Ctrl / Cmd", "2"] },
            { label: "适应选择", keys: ["Ctrl / Cmd", "3"] },
            { label: "滚轮缩放", keys: ["滚轮"] },
            { label: "精确缩放", keys: ["缩放滑杆"] },
        ],
    },
    {
        title: "移动画布",
        items: [
            { label: "平移视图", keys: ["空白处左键拖动"] },
            { label: "辅助平移", keys: ["Space", "左键 / 中键"] },
            { label: "搜索节点", keys: ["Ctrl / Cmd", "K"] },
            { label: "专注模式", keys: ["Ctrl / Cmd", "F"] },
        ],
    },
    {
        title: "其他",
        items: [
            { label: "保存画布", keys: ["Ctrl / Cmd", "S"] },
            { label: "撤销", keys: ["Ctrl / Cmd", "Z"] },
            { label: "重做", keys: ["Ctrl / Cmd", "Shift", "Z"] },
            { label: "重做（备选）", keys: ["Ctrl / Cmd", "Y"] },
            { label: "删除选中", keys: ["Delete / Backspace"] },
            { label: "取消 / 关闭浮层", keys: ["Esc"] },
            { label: "打开快捷键", keys: ["?"] },
        ],
    },
] as const;

export function CanvasTopBar({
    teamId,
    hidden = false,
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    onCreateProject,
    onDeleteProject,
    onShare,
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
    shortcutRequestNonce,
    mediaPerformanceMode,
    onMediaPerformanceModeChange,
    onOpenSearch,
    projectContext,
    onEnterFocusMode,
    shortDramaGuide,
}: CanvasTopBarProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const creditsEnabled = useUserStore((state) => state.features.creditsEnabled);
    const wallet = useWalletBalance(user?.id, creditsEnabled && !teamId);
    const team = useQuery({ queryKey: ["team", user?.id, teamId], queryFn: () => getTeam(teamId!), enabled: !!teamId, refetchInterval: teamId ? 15000 : false });
    const availableMicrocredits = teamId ? team.data?.team.availableMicrocredits ?? null : wallet.availableMicrocredits;
    const refreshing = teamId ? team.isFetching : wallet.refreshing;
    const balanceAction = teamId ? "团队积分" : "充值/订阅";
    const titleRef = useRef<HTMLDivElement>(null);
    const shortcutsRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const creditBalanceState = refreshing ? "refreshing" : availableMicrocredits === null ? "unknown" : availableMicrocredits <= 0 ? "empty" : availableMicrocredits < 10_000_000 ? "low" : "ready";

    useEffect(() => {
        if (shortcutRequestNonce > 0) setShortcutsOpen(true);
    }, [shortcutRequestNonce]);

    useEffect(() => {
        if (!shortcutsOpen) return;
        const closeOnOutsidePress = (event: PointerEvent) => {
            if (event.target instanceof Node && shortcutsRef.current?.contains(event.target)) return;
            setShortcutsOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setShortcutsOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutsidePress);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsidePress);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [shortcutsOpen]);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div
                className={`canvas-project-topbar pointer-events-none absolute z-[var(--z-toolbar)] flex h-[var(--canvas-topbar-h)] items-center justify-between${hidden ? " hidden" : ""}`}
                aria-hidden={hidden || undefined}
            >
                <div
                    className="canvas-project-title-cluster pointer-events-auto flex min-w-0 items-center"
                >
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomLeft"
                        classNames={{ root: "canvas-project-menu" }}
                        menu={{
                            items: [
                                { key: "projects", label: <Link to="/canvas">全部画布</Link> },
                                { type: "divider" },
                                { key: "new", label: "创建画布", onClick: onCreateProject },
                                { key: "delete", label: "删除画布", onClick: onDeleteProject },
                            ],
                        }}
                    >
                        <button type="button" className="canvas-project-menu-button" aria-label="打开画布菜单">
                            <span className="canvas-project-brand-mark" aria-hidden="true" />
                            <ChevronDown className="size-3 opacity-55" />
                        </button>
                    </Dropdown>

                    <span className="canvas-project-workspace-divider" aria-hidden />
                    <Link
                        to={projectContext ? `/projects/${projectContext.projectId}/overview` : "/canvas"}
                        className="canvas-project-workspace-name truncate font-medium hover:opacity-75"
                        title={projectContext ? `返回项目：${projectContext.projectName}` : "返回画布列表"}
                    >
                        {projectContext?.projectName || "全部画布"}
                    </Link>
                    <span className="canvas-project-workspace-divider" aria-hidden />

                    <div ref={titleRef} className="canvas-project-title-block flex min-w-0 items-center">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                size={canvasTitleInputSize(titleDraft)}
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="canvas-toolbar-title-input"
                                aria-label="画布名称"
                            />
                        ) : (
                            <div className="flex min-w-0 items-center gap-0.5">
                                <button type="button" className="canvas-project-title-text truncate text-left font-semibold transition-opacity hover:opacity-75" onClick={onStartTitleEditing} title="点击修改画布名称">
                                    {title}
                                </button>
                                <Tooltip title="重命名画布">
                                    <button type="button" className="canvas-project-rename-button" onClick={onStartTitleEditing} aria-label="重命名画布">
                                        <Pencil className="size-3.5" />
                                    </button>
                                </Tooltip>
                            </div>
                        )}
                    </div>
                    <span className="canvas-project-search-divider" aria-hidden />
                    <Tooltip title="搜索画布节点（⌘ K）">
                        <button type="button" className="canvas-project-search-button" onClick={onOpenSearch} aria-label="搜索画布节点"><Search className="size-4" /></button>
                    </Tooltip>
                </div>

                <div className="canvas-project-top-actions pointer-events-auto flex min-w-0 items-center gap-1.5">
                    <Button type="text" className="!h-10 !rounded-xl !px-3 !font-medium" style={{ background: theme.toolbar.panel, color: theme.node.text }} icon={<KeyRound className="size-4" />} onClick={() => navigateToSettings()}>API 设置</Button>
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            selectable: true,
                            selectedKeys: [mediaPerformanceMode],
                            onClick: ({ key }) => onMediaPerformanceModeChange(key as CanvasMediaPerformanceMode),
                            items: [
                                { key: "auto", label: "自动性能" },
                                { key: "quality", label: "画质优先" },
                                { key: "performance", label: "性能优先" },
                            ],
                        }}
                    >
                        <Button type="text" className="canvas-project-media-performance-action !hidden !h-10 !w-10 !min-w-10 !rounded-xl !p-0" style={{ color: theme.node.text }} icon={<Gauge className="size-4" />} aria-label="媒体性能模式" title="媒体性能模式" />
                    </Dropdown>
                    {compactAgentStatus ? <CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} /> : null}
                    {user && creditsEnabled ? (
                        <Link
                            to={teamId ? `/teams/${teamId}` : "/subscription"}
                            className="workspace-top-wallet canvas-credit-balance inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-[#151821]/88 px-4 text-sm font-semibold text-[#68ff5d] shadow-[0_16px_44px_rgba(0,0,0,.35)] backdrop-blur transition-colors hover:border-[#68ff5d]/35 hover:bg-[#1b1f2a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            data-credit-state={creditBalanceState}
                            title={`${balanceAction}：可用 ${availableMicrocredits === null ? "--" : (availableMicrocredits / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 积分`}
                            aria-label={`查看${balanceAction}`}
                        >
                            {refreshing && availableMicrocredits === null ? <LoaderCircle className="size-4 animate-spin opacity-70" /> : <Zap className="size-4 fill-current" />}
                            <span className="tabular-nums">{availableMicrocredits === null ? "--" : (availableMicrocredits / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })}</span>
                            <span className="h-4 w-px bg-white/12" aria-hidden />
                            <span className="text-white/82">{balanceAction}</span>
                        </Link>
                    ) : null}
                    {user ? (
                        <Tooltip title={user.displayName || user.username}>
                            <Link to="/profile" className="canvas-project-user-link grid size-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2" aria-label="打开个人主页">
                                <WorkspaceUserAvatar user={user} className="size-7" showProvider={false} />
                            </Link>
                        </Tooltip>
                    ) : null}
                    <Tooltip title="进入专注模式（⇧⌘F）">
                        <Button
                            type="text"
                            className="canvas-project-secondary-action !h-10 !w-10 !min-w-10 !rounded-xl !p-0"
                            style={{ color: theme.node.text }}
                            icon={<Focus className="size-4" />}
                            onClick={onEnterFocusMode}
                            aria-label="进入专注模式"
                        />
                    </Tooltip>
                    {shortDramaGuide ? (
                        <Tooltip title={shortDramaGuide.collapsed ? "展开短剧流程" : "收起短剧流程"}>
                            <Button
                                type="text"
                                className="canvas-project-short-drama-action !h-10 !rounded-xl !px-2.5 !font-medium"
                                style={{ color: theme.node.text, background: shortDramaGuide.collapsed ? undefined : theme.toolbar.activeBg }}
                                icon={<Clapperboard className="size-4" />}
                                onClick={shortDramaGuide.onToggle}
                                aria-label="短剧流程"
                            >
                                <span className="tabular-nums">{shortDramaGuide.progress.completedCount}/5</span>
                            </Button>
                        </Tooltip>
                    ) : null}
                    <Button type="text" className="canvas-project-share-action !h-10 !w-10 !min-w-10 !rounded-xl !p-0" style={{ color: theme.node.text }} icon={<Share2 className="size-4" />} onClick={onShare} aria-label="分享画布" title="分享画布" />
                    <span className="canvas-project-action-divider h-6 w-px" style={{ background: theme.toolbar.border }} />
                    <Button
                        type="text"
                        className="canvas-project-agent-button !h-10 !rounded-xl !px-4 !font-medium"
                        style={{ background: agentOpen ? theme.toolbar.activeBg : theme.toolbar.panel, color: theme.node.text, boxShadow: "0 10px 30px rgba(28,25,23,.10)" }}
                        icon={<Bot className="size-4" />}
                        disabled={!!teamId}
                        title={teamId ? "团队画布请使用节点生成，暂不支持个人助手" : undefined}
                        onClick={onToggleAgent}
                    >
                        Agent
                    </Button>
                </div>
            </div>
            <AnimatePresence>
                {shortcutsOpen ? (
                    <div className="canvas-shortcuts-anchor">
                        <motion.div
                            ref={shortcutsRef}
                            data-canvas-no-zoom
                            role="dialog"
                            aria-modal={false}
                            aria-label="画布快捷键"
                            className="canvas-shortcuts-popover"
                            initial={{ opacity: 0, y: 14, scale: 0.985 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.99 }}
                            transition={aceternityMotion.spring.panel}
                        >
                            <button type="button" className="canvas-shortcuts-close" onClick={() => setShortcutsOpen(false)} aria-label="关闭画布快捷键">
                                <X />
                            </button>
                            <div className="canvas-shortcuts-layout">
                                {CANVAS_SHORTCUT_SECTIONS.map((section) => (
                                    <section key={section.title} className="canvas-shortcuts-section">
                                        <h2>{section.title}</h2>
                                        <div className="canvas-shortcuts-list">
                                            {section.items.map((item) => <Shortcut key={item.label} label={item.label} keys={item.keys} />)}
                                        </div>
                                    </section>
                                ))}
                            </div>
                        </motion.div>
                    </div>
                ) : null}
            </AnimatePresence>
        </>
    );
}

function canvasTitleInputSize(value: string) {
    const visualLength = Array.from(value || "画布名称").reduce((length, character) => length + (character.codePointAt(0)! > 0xff ? 2 : 1), 0);
    return Math.min(30, Math.max(5, visualLength));
}

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const label = status.connected ? "已连接到本地 Codex" : status.enabled ? status.activity || "连接中" : "正在连接本地 Codex";
    const dotColor = status.connected ? "#22c55e" : status.enabled ? "#f59e0b" : theme.node.muted;
    return (
        <button type="button" className="canvas-project-compact-agent flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium transition hover:opacity-85" style={{ background: theme.toolbar.panel, color: theme.node.text, boxShadow: "0 10px 30px rgba(28,25,23,.10)" }} onClick={onClick} title="打开本地 Codex 面板">
            <span className="size-2 rounded-full" style={{ background: dotColor }} />
            <span className="max-w-[180px] truncate">{label}</span>
        </button>
    );
}

function Shortcut({ keys, label }: { keys: readonly string[]; label: string }) {
    return (
        <div className="canvas-shortcut-row">
            <span className="canvas-shortcut-label">{label}</span>
            <span className="canvas-shortcut-keys">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="canvas-shortcut-key-part">
                        {index ? <span className="canvas-shortcut-plus">+</span> : null}
                        <kbd>{key}</kbd>
                    </span>
                ))}
            </span>
        </div>
    );
}
