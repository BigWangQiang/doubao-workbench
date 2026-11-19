import { Button, Popover, Slider, Tooltip } from "antd";
import { useState } from "react";
import { GripVertical, History, Maximize2, MessageSquarePlus, PanelRightClose, Plus, SlidersHorizontal, X } from "lucide-react";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasAgentFloatingSize } from "@/lib/canvas/canvas-agent-floating-window";
import { useUserStore } from "@/stores/use-user-store";
import { AgentAvatar } from "./canvas-agent-chat-ui";

export function AgentPanelChrome({
    theme,
    onCollapse,
    hasMessages,
    onNewChat,
    onOpenHistory,
    onExpand,
    floatingBackgroundOpacity,
    onFloatingBackgroundOpacityChange,
    floatingSize,
    onFloatingSizeChange,
    floating = false,
}: {
    theme: CanvasTheme;
    onCollapse: () => void;
    hasMessages: boolean;
    onNewChat: () => void;
    onOpenHistory: () => void;
    onExpand: () => void;
    floatingBackgroundOpacity: number;
    onFloatingBackgroundOpacityChange: (value: number) => void;
    floatingSize: CanvasAgentFloatingSize;
    onFloatingSizeChange: (value: CanvasAgentFloatingSize) => void;
    floating?: boolean;
}) {
    return (
        <header className={`canvas-agent-header shrink-0 ${floating ? "canvas-agent-header-draggable" : ""}`} style={{ background: floating ? "transparent" : theme === canvasThemes.dark ? "#1b1b1d" : theme.spatial.elevated }}>
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[15px] font-medium leading-6" style={{ color: theme.node.text }}>新对话</span>
                <span className="canvas-agent-beta">Beta</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
                {floating ? (
                    <>
                        <Tooltip title="拖动窗口；方向键微调">
                            <Button type="text" shape="circle" data-canvas-agent-drag-handle className="canvas-agent-header-button !h-9 !w-9 !min-w-9 cursor-grab" style={{ color: theme.node.muted, touchAction: "none" }} icon={<GripVertical className="size-[18px]" />} aria-label="移动智能体窗口，使用方向键微调" />
                        </Tooltip>
                        <Popover
                            trigger="click"
                            placement="bottomRight"
                            content={(
                                <div className="w-60 space-y-3 px-2 py-1" style={{ background: theme.spatial.elevated, color: theme.node.text }}>
                                    <div>
                                        <div className="flex items-center justify-between text-xs font-medium">
                                            <span>窗口宽度</span>
                                            <span>{floatingSize.width}px</span>
                                        </div>
                                        <Slider aria-label="浮窗宽度" min={480} max={1120} step={40} value={floatingSize.width} onChange={(value) => onFloatingSizeChange({ ...floatingSize, width: Number(value) })} />
                                    </div>
                                    <div>
                                        <div className="flex items-center justify-between text-xs font-medium">
                                            <span>窗口高度</span>
                                            <span>{floatingSize.height}px</span>
                                        </div>
                                        <Slider aria-label="浮窗高度" min={440} max={1000} step={40} value={floatingSize.height} onChange={(value) => onFloatingSizeChange({ ...floatingSize, height: Number(value) })} />
                                    </div>
                                    <div className="flex items-center justify-between text-xs font-medium">
                                        <span>背景不透明度</span>
                                        <span>{floatingBackgroundOpacity}%</span>
                                    </div>
                                    <Slider aria-label="浮窗背景不透明度" min={55} max={92} step={1} value={floatingBackgroundOpacity} onChange={(value) => onFloatingBackgroundOpacityChange(Number(value))} />
                                </div>
                            )}
                        >
                            <Tooltip title="调整浮窗大小与透明度">
                                <Button type="text" shape="circle" className="canvas-agent-header-button !h-9 !w-9 !min-w-9" style={{ color: theme.node.muted }} icon={<SlidersHorizontal className="size-[18px]" />} aria-label="调整浮窗大小与透明度" />
                            </Tooltip>
                        </Popover>
                    </>
                ) : null}
                <Tooltip title="新建对话">
                    <Button type="text" shape="circle" className="canvas-agent-header-button !h-9 !w-9 !min-w-9" style={{ color: theme.node.muted }} icon={<MessageSquarePlus className="size-[18px]" />} disabled={!hasMessages} onClick={onNewChat} aria-label="新建对话" />
                </Tooltip>
                <Tooltip title="历史记录">
                    <Button type="text" shape="circle" className="canvas-agent-header-button !h-9 !w-9 !min-w-9" style={{ color: theme.node.muted }} icon={<History className="size-[18px]" />} onClick={onOpenHistory} aria-label="历史记录" />
                </Tooltip>
                <Tooltip title={floating ? "放大到右侧面板" : "收起为浮窗"}>
                    <Button type="text" shape="circle" className="canvas-agent-header-button !h-9 !w-9 !min-w-9" style={{ color: theme.node.muted }} icon={floating ? <Maximize2 className="size-[18px]" /> : <PanelRightClose className="size-[18px]" />} onClick={onExpand} aria-label={floating ? "放大到右侧面板" : "收起为浮窗"} />
                </Tooltip>
                <Tooltip title="关闭 Agent">
                    <Button type="text" shape="circle" className="canvas-agent-header-button !h-9 !w-9 !min-w-9" style={{ color: theme.node.muted }} icon={<X className="size-[19px]" />} onClick={onCollapse} aria-label="关闭 Agent" />
                </Tooltip>
            </div>
        </header>
    );
}

export function AgentChatEmptyState({ theme, nodeCount, onSelect }: { theme: CanvasTheme; nodeCount: number; onSelect: (value: string) => void }) {
    const shortDramaEnabled = useUserStore((state) => state.features.shortDramaEnabled);
    const displayName = useUserStore((state) => state.user?.displayName || state.user?.username || "创作者");
    const cardSurface = theme === canvasThemes.dark ? "#242426" : theme.spatial.surface;
    const [batch, setBatch] = useState(0);
    const starterBatches = [
        [
            { title: "体验山音独家编剧流程", description: "我想写一个关于小区保安的长篇故事前传，他每天站在门口看着所有人进进出出", prompt: "体验山音独家编剧流程：我想写一个关于小区保安的长篇故事前传，他每天站在门口看着所有人进进出出" },
            { title: "设计原创影视角色", description: "25岁成熟清冷的女主，品牌主理人，灰度阴棚的画像待定妆照", prompt: "设计原创影视角色：25岁成熟清冷的女主，品牌主理人，灰度阴棚的画像待定妆照" },
            { title: "打造一部鸿爆款短剧", description: "一个被姨群当众退婚羞辱的低等Omega女孩，却在祭坛前意外怀孕的Alpha救下，并宣誓为命定伴侣", prompt: "打造一部爆款短剧：一个被姨群当众退婚羞辱的低等Omega女孩，却在祭坛前意外怀孕的Alpha救下，并宣誓为命定伴侣" },
        ],
        [
            { title: "构思一支反转广告", description: "把普通日常拍出意想不到的结局，节奏明快，适合短视频传播", prompt: "构思一支反转广告，把普通日常拍出意想不到的结局" },
            { title: "生成电影感分镜", description: "从一个主题开始，拆解成有镜头语言和情绪变化的完整分镜", prompt: "生成电影感分镜，主题是城市夜晚与一个人的秘密" },
            { title: "整理当前画布", description: "分析已有节点，补齐标题、连线和创作顺序，让画布更清晰", prompt: "整理当前画布，补齐标题、连线和创作顺序" },
        ],
    ];
    const visibleStarterActions = starterBatches[batch % starterBatches.length].filter((item) => shortDramaEnabled || !item.title.includes("短剧"));
    return (
        <div className="canvas-agent-empty-state flex h-full items-center px-6 py-10">
            <div className="mx-auto w-full max-w-[680px]">
                <div className="text-center">
                    <div className="canvas-agent-greeting" style={{ color: theme.node.muted }}>Hi {displayName}!</div>
                    <h2 className="mt-2 text-[24px] font-semibold leading-9 tracking-[-0.02em]" style={{ color: theme.node.text }}>想和我一起创作点什么？</h2>
                </div>
                <div className="mt-7 grid gap-3">
                    {visibleStarterActions.map((item) => (
                        <button key={item.title} type="button" className="canvas-agent-starter-card text-left" style={{ background: cardSurface, borderColor: theme.toolbar.border, color: theme.node.text }} onClick={() => onSelect(item.prompt)}>
                            <span className="block text-[15px] font-medium leading-6">{item.title}</span>
                            <span className="mt-2 block text-[14px] leading-6" style={{ color: theme.node.muted }}>{item.description}</span>
                        </button>
                    ))}
                </div>
                <button type="button" className="canvas-agent-refresh mt-3 ml-auto flex items-center gap-1.5 text-sm" style={{ color: theme.node.muted }} onClick={() => setBatch((value) => value + 1)} aria-label="换一批创作示例">
                    <span aria-hidden="true">↻</span> 换一批
                </button>
            </div>
        </div>
    );
}
