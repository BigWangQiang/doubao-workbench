import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { ChevronDown, ChevronRight, Cpu, Crown } from "lucide-react";
import { App, Popover } from "antd";
import { useNavigate } from "react-router";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, videoDurationOptions } from "@/lib/model-capabilities";
import { compareModelOrder, groupModelOptions } from "@/lib/model-picker-order";
import { cn } from "@/lib/utils";
import { resourceFileUrl } from "@/services/api/resources";
import { decodeChannelModel, modelCategoryBadge, modelDescription, modelDisplayName, modelFamilyName, modelIconResourceId, modelOptionName, modelRequiresMembership, modelVariantName, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { MembershipView } from "@/types/membership";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    showSelectedPrice?: boolean;
    variant?: "default" | "creation";
    popoverPlacement?: "topLeft" | "bottomLeft" | "bottomRight";
    autoAdjustOverflow?: boolean;
    menuLayout?: "list" | "grid";
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig, variant = "default", popoverPlacement = "topLeft", autoAdjustOverflow = false, menuLayout = "list" }: ModelPickerProps) {
    const pickerId = useId();
    const { modal } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    // 双保险：即使 store merge 写出非法 theme，这里也兜底到 dark，避免 "reading 'node'" 崩溃
    const rawTheme = useThemeStore((state) => state.theme);
    const theme = (canvasThemes[rawTheme as keyof typeof canvasThemes] ?? canvasThemes.dark) as CanvasTheme;
    const [open, setOpen] = useState(false);
    const [activeFamily, setActiveFamily] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const options = useMemo(() => {
        const filtered = selectableModelsByCapability(config, capability);
        const current = value?.trim();
        const currentIncluded = current ? filtered.includes(current) : true;
        // 超分只从画布视频工具入口使用；合并历史选中值后过滤，避免旧值重新进入普通模型列表。
        return Array.from(new Set([...filtered, ...(!currentIncluded && current ? [current] : [])].filter((model): model is string => Boolean(model))))
            .filter((model) => resolveModelRequestConfig(config, model).interfaceType !== "tencent-mps-video")
            .sort((left, right) => compareModelOrder(config, left, right));
    }, [capability, config, value]);
    const current = value || "";
    const creationVariant = variant === "creation";
    const directModelSelection = capability === "text";
    const membershipActive = hasActiveMembership(user?.membership);
    const currentLabel = current ? (directModelSelection ? modelDisplayName(config, current) : modelVariantName(config, current)) : placeholder;
    const families = useMemo(() => groupModelOptions(config, options), [config, options]);
    const activeFamilyData = useMemo(() => families.find((item) => item.key === activeFamily) || null, [activeFamily, families]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    useEffect(() => {
        setOpen(false);
        setActiveFamily(null);
    }, [capability]);

    useEffect(() => {
        if (!open) return;
        // 画布拖拽从 pointerdown 开始，须在捕获阶段关闭 Portal 菜单，避免菜单与触发器分离。
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (target instanceof Element && target.closest(".canvas-model-membership-popover")) return;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setOpen(false);
        };
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    }, [open]);

    const setPickerOpen = (nextOpen: boolean) => {
        if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
        if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
        if (nextOpen && !directModelSelection) {
            setActiveFamily(families.find((family) => family.models.includes(current))?.key || families[0]?.key || null);
        }
        setOpen(nextOpen);
    };
    const focusMenuOption = (last = false) => {
        window.requestAnimationFrame(() => {
            const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
            const target = last ? buttons?.item((buttons?.length || 1) - 1) : buttons?.item(0);
            target?.focus();
        });
    };
    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        setPickerOpen(true);
        focusMenuOption(event.key === "ArrowUp");
    };
    const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
            return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
        if (!buttons.length) return;
        event.preventDefault();
        const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? Math.max(0, activeIndex - 1) : Math.min(buttons.length - 1, activeIndex + 1);
        buttons[nextIndex]?.focus();
    };
    const openMembership = () => {
        setOpen(false);
        navigate(user ? "/subscription" : "/login?next=%2Fsubscription");
    };
    const selectModel = (model: string) => {
        if (modelRequiresMembership(config, model) && !membershipActive) {
            setOpen(false);
            modal.confirm({
                title: "会员专享模型",
                content: "该模型需要开通有效的 Lalor 会员后才能使用。",
                okText: user ? "去开通会员" : "去登录",
                cancelText: "取消",
                onOk: openMembership,
            });
            return;
        }
        onChange(model);
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const content = (
        <div
            ref={menuRef}
            data-canvas-no-zoom
            className={cn("canvas-model-picker-menu hide-scrollbar", !directModelSelection && "is-split", menuLayout === "grid" && "is-grid", creationVariant && "creation-model-picker-menu")}
            role="listbox"
            aria-label={placeholder}
            onKeyDown={handleMenuKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {options.length ? (
                <section className="canvas-model-picker-group min-w-0 overflow-hidden">
                    {directModelSelection ? (
                        <div className="grid min-w-0 gap-1">
                            {options.map((model) => {
                                const selected = model === current;
                                const membershipRequired = modelRequiresMembership(config, model);
                                const membershipLocked = membershipRequired && !membershipActive;
                                const option = (
                                    <button
                                        key={model}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        aria-label={membershipLocked ? `${modelDisplayName(config, model)}，仅指定会员用户可用` : undefined}
                                        className={cn("canvas-model-picker-option", selected && "is-selected", membershipLocked && "is-membership-locked")}
                                        onClick={() => selectModel(model)}
                                    >
                                        <ModelLabel config={config} model={model} capability={capability} directName membershipLocked={membershipLocked} />
                                    </button>
                                );
                                return membershipLocked ? <ModelMembershipHint key={model} onUpgrade={openMembership}>{option}</ModelMembershipHint> : option;
                            })}
                        </div>
                    ) : (
                        <div className="canvas-model-picker-split">
                            <div className="canvas-model-picker-family-list hide-scrollbar" aria-label="模型类型">
                                {families.map((family) => {
                                    const membershipRequired = family.models.every((model) => modelRequiresMembership(config, model));
                                    const membershipLocked = membershipRequired && !membershipActive;
                                    const option = (
                                        <button
                                            key={family.key}
                                            type="button"
                                            role="option"
                                            aria-selected={family.key === activeFamily}
                                            aria-label={membershipLocked ? `${family.name}，仅指定会员用户可用` : undefined}
                                            className={cn("canvas-model-picker-option", family.key === activeFamily && "is-selected", membershipLocked && "is-membership-locked")}
                                            onClick={() => setActiveFamily(family.key)}
                                        >
                                            <ModelLabel config={config} model={family.representative} capability={capability} familyOnly showBadge requiresMembership={membershipRequired} membershipLocked={membershipLocked} />
                                            <ChevronRight className="canvas-model-picker-option-arrow" aria-hidden="true" />
                                        </button>
                                    );
                                    return membershipLocked ? <ModelMembershipHint key={family.key} onUpgrade={openMembership}>{option}</ModelMembershipHint> : option;
                                })}
                            </div>
                            <div className="canvas-model-picker-variant-list hide-scrollbar" aria-label="具体模型名称">
                                {activeFamilyData?.models.length ? (
                                    activeFamilyData.models.map((model) => {
                                        const selected = model === current;
                                        const membershipRequired = modelRequiresMembership(config, model);
                                        const membershipLocked = membershipRequired && !membershipActive;
                                        const option = (
                                            <button
                                                key={model}
                                                type="button"
                                                role="option"
                                                aria-selected={selected}
                                                aria-label={membershipLocked ? `${modelVariantName(config, model)}，仅指定会员用户可用` : undefined}
                                                className={cn("canvas-model-picker-option is-variant", selected && "is-selected", membershipLocked && "is-membership-locked")}
                                                onClick={() => selectModel(model)}
                                            >
                                                <ModelLabel config={config} model={model} capability={capability} showBadge={false} membershipLocked={membershipLocked} />
                                            </button>
                                        );
                                        return membershipLocked ? <ModelMembershipHint key={model} onUpgrade={openMembership}>{option}</ModelMembershipHint> : option;
                                    })
                                ) : (
                                    <span className="canvas-model-picker-route-empty">请先选择模型类型</span>
                                )}
                            </div>
                        </div>
                    )}
                </section>
            ) : (
                <div className="canvas-model-picker-empty" style={{ color: theme.node.muted }}>
                    {emptyModelLabel(config, capability)}
                </div>
            )}
        </div>
    );

    return (
        <div className={cn(fullWidth ? "w-full min-w-0" : "w-fit max-w-full")} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Popover
                open={open}
                onOpenChange={setPickerOpen}
                trigger="click"
                placement={popoverPlacement}
                autoAdjustOverflow={autoAdjustOverflow}
                arrow={false}
                content={content}
                classNames={{
                    root: cn("canvas-model-picker-popover", creationVariant && "creation-model-picker-popover"),
                    container: cn("canvas-composer-popover-surface", creationVariant && "creation-model-picker-surface"),
                    content: "canvas-composer-popover-content",
                }}
            >
                <button
                    ref={triggerRef}
                    type="button"
                    className={cn("canvas-composer-model-picker", fullWidth ? "w-full" : "min-w-36 max-w-full", className)}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-label={current ? `${placeholder}：${currentLabel}` : placeholder}
                    title={current ? (directModelSelection ? currentLabel : `${modelFamilyName(config, current)} · ${currentLabel}`) : placeholder}
                    onKeyDown={handleTriggerKeyDown}
                >
                    <span className="canvas-model-picker-label flex min-w-0 items-center gap-1.5">
                        <span className="canvas-model-picker-trigger-icon" style={{ background: theme.toolbar.itemHover }}>
                            <ModelIcon model={current} iconResourceId={modelIconResourceId(config, current)} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{currentLabel}</span>
                        {current && modelRequiresMembership(config, current) ? <ModelMembershipBadge locked={!membershipActive} /> : null}
                    </span>
                    <ChevronDown className={cn("canvas-model-picker-chevron", open && "is-open")} aria-hidden="true" />
                </button>
            </Popover>
        </div>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability === "image" ? "生图" : capability === "video" ? "视频" : capability === "text" ? "文本" : capability === "audio" ? "音频" : "";
    if (capability && config.models.length) return `当前渠道没有匹配的${label}模型`;
    return config.models.length ? `暂无匹配的${label}模型` : "请先到配置里添加渠道和模型";
}

function ModelLabel({ config, model, capability, familyOnly = false, directName = false, showBadge = true, requiresMembership, membershipLocked = false }: { config: AiConfig; model: string; capability?: ModelCapability; familyOnly?: boolean; directName?: boolean; showBadge?: boolean; requiresMembership?: boolean; membershipLocked?: boolean }) {
    const source = decodeChannelModel(model)?.channelId;
    const sourceBadge = source === "desktop-doubao" ? { text: "豆包", tone: "info" } : source === "desktop-dola" ? { text: "Dola", tone: "success" } : null;
    const categoryBadge = sourceBadge || (showBadge && !directName ? modelCategoryBadge(config, model) : null);
    const membershipRequired = requiresMembership ?? modelRequiresMembership(config, model);
    const videoProfile = capability === "video" ? modelCapabilityConfigFor(config, model).video : undefined;
    const fallbackDescription = videoProfile ? `${formatDurationSummary(videoProfile)} · ${videoProfile.resolutions.map((item) => item.toUpperCase()).join("/")}` : modelMenuMeta(model, capability).description;
    const description = modelDescription(config, model) || fallbackDescription;
    const label = directName ? modelDisplayName(config, model) : familyOnly ? modelFamilyName(config, model) : modelVariantName(config, model);
    return (
        <span className="canvas-model-picker-option-content" title={membershipLocked ? undefined : description}>
            <span className="canvas-model-picker-option-icon">
                <ModelIcon model={model} iconResourceId={modelIconResourceId(config, model)} lightSurface />
            </span>
            <span className="flex min-w-0 flex-1 flex-col items-start">
                <span className="canvas-model-picker-option-name w-full">{label}</span>
                <span className="w-full truncate text-xs leading-4 text-foreground/45">{description}</span>
            </span>
            {membershipRequired ? <ModelMembershipBadge locked={membershipLocked} /> : null}
            {categoryBadge ? (
                <span className={cn("canvas-model-picker-badge", `is-${categoryBadge.tone}`)} title={categoryBadge.text} aria-label={`分类标签：${categoryBadge.text}`}>
                    {categoryBadge.text}
                </span>
            ) : null}
        </span>
    );
}

function ModelMembershipHint({ children, onUpgrade }: { children: ReactElement; onUpgrade: () => void }) {
    return (
        <Popover
            trigger={["hover", "focus"]}
            placement="right"
            arrow={false}
            mouseEnterDelay={0.12}
            mouseLeaveDelay={0.08}
            content={(
                <div className="canvas-model-membership-hint">
                    <span>仅指定会员用户可用</span>
                    <button type="button" onClick={onUpgrade}>升级</button>
                </div>
            )}
            classNames={{
                root: "canvas-model-membership-popover",
                container: "canvas-model-membership-popover-surface",
                content: "canvas-model-membership-popover-content",
            }}
        >
            {children}
        </Popover>
    );
}

export function ModelMembershipBadge({ locked = false }: { locked?: boolean }) {
    return (
        <span className={cn("canvas-model-membership-badge", locked && "is-locked")} title="会员专享" aria-label="会员专享">
            <Crown aria-hidden="true" />
        </span>
    );
}

function hasActiveMembership(membership?: MembershipView | null) {
    if (!membership?.active) return false;
    const now = Date.now();
    const startsAt = Date.parse(membership.startsAt);
    const expiresAt = Date.parse(membership.expiresAt);
    if (Number.isFinite(startsAt) && startsAt > now) return false;
    return Number.isFinite(expiresAt) && expiresAt > now;
}

function formatDurationSummary(profile: NonNullable<ReturnType<typeof modelCapabilityConfigFor>["video"]>) {
    const values = videoDurationOptions(profile);
    if (profile.duration.selection === "enum") return values.map((item) => `${item}s`).join("/");
    return `${profile.duration.min || values[0]}-${profile.duration.max || values[values.length - 1]}s`;
}

function modelMenuMeta(model: string, capability?: ModelCapability): { description: string; time?: string } {
    const name = modelOptionName(model).toLowerCase();
    if (capability === "image") {
        if (name.includes("nano banana") || name.includes("nanobanana") || name.includes("imagen")) return { description: "Gemini 高质量图片生成，适合角色和商业成片" };
        if (name.includes("nano") || name.includes("pro")) return { description: "高质量图片生成，适合角色和商业成片" };
        if (name.includes("seedream")) return { description: "快速出图，适合批量探索风格" };
        if (name.includes("gpt") || name.includes("image")) return { description: "通用图片模型，提示词理解稳定" };
        return { description: "图片生成模型" };
    }
    if (capability === "video") {
        if (name.includes("veo") || name.includes("omni flash") || name.includes("omni-flash")) return { description: "Gemini 镜头生成与图生视频，适合成片流程", time: "3m" };
        if (name.includes("seedance") || name.includes("sora")) return { description: "镜头生成与图生视频，适合成片流程", time: "3m" };
        return { description: "视频生成模型", time: "3m" };
    }
    if (capability === "audio") return { description: "语音、音效或音乐生成", time: "20s" };
    if (name.includes("claude")) return { description: "长文本、推理与创意写作", time: "10s" };
    if (name.includes("gemini")) return { description: "多模态理解与快速文本生成", time: "10s" };
    if (name.includes("deepseek")) return { description: "推理、代码和结构化文本", time: "10s" };
    return { description: capability === "text" ? "文本生成模型" : "当前渠道模型", time: "10s" };
}

export function ModelIcon({ model, iconResourceId = "", lightSurface = false }: { model: string; iconResourceId?: string; lightSurface?: boolean }) {
    const customIcon = iconResourceId ? resourceFileUrl(iconResourceId) : "";
    const [customIconFailed, setCustomIconFailed] = useState(false);
    useEffect(() => setCustomIconFailed(false), [customIcon]);
    if (customIcon && !customIconFailed) {
        return <img src={customIcon} alt="" className="size-3.5 shrink-0 object-contain" onError={() => setCustomIconFailed(true)} />;
    }
    const icon = resolveModelIcon(modelOptionName(model));
    const monochrome = icon === "/icons/openai.svg" || icon === "/icons/grok.svg";
    return icon ? <img src={icon} alt="" className={cn("size-3.5 shrink-0", monochrome && !lightSurface && "dark:invert")} /> : <Cpu className="size-3.5 shrink-0 opacity-70" />;
}

export function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    // Flow2API 短名：Nano Banana / Imagen / Veo / Omni 均属 Google Gemini 系。
    if (name.includes("gemini") || name.includes("google") || name.includes("nano banana") || name.includes("nanobanana") || name.includes("imagen") || name.includes("veo") || name.includes("omni flash") || name.includes("omni-flash")) {
        return "/icons/gemini.svg";
    }
    if (name.includes("gpt") || name.includes("openai") || name.includes("dall-e") || name.includes("dalle")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("chatglm")) return "/icons/glm.svg";
    return "";
}
