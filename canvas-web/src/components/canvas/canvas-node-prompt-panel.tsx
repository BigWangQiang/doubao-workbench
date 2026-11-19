import { useEffect, useMemo, useState } from "react";
import { ArrowUp, ArrowUpRight, Crosshair, FileText, ImageIcon, Keyboard, Link2, LoaderCircle, Maximize2, Music2, Pencil, Square, UserRound, Video, X } from "lucide-react";
import { App, Button, Image as AntImage, Modal, Popover, Tooltip } from "antd";

import "@/components/studio-composer.css";
import { ModelPicker } from "@/components/model-picker";
import { GenerationCostIndicator } from "@/components/generation-cost-indicator";
import { configuredModelMatchesCapability, defaultConfig, modelOptionName, resolveModelChannel, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { requestCreditEstimate } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, normalizeImageValue, normalizeVideoValue } from "@/lib/model-capabilities";
import { normalizeVideoDuration, normalizeVideoResolution } from "@/lib/video-generation-options";
import { navigateToSettings } from "@/lib/settings-navigation";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasVideoFramePicker, CanvasVideoFrameSlots } from "./canvas-video-frame-picker";
import { CanvasPresetPicker, type CanvasPromptPreset } from "./canvas-preset-picker";
import { CanvasPortraitTexturePopover } from "./canvas-portrait-texture-popover";
import { AudioPreviewButton } from "@/components/audio-settings-panel";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasWorkspaceMode } from "@/types/canvas";
import { appendMatchedCanvasResourceMentions, canvasResourceMentionToken, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveResourceUrl } from "@/services/api/resources";
import { supportsColoredPencil } from "@/lib/colored-pencil";
import { canvasColoredPencilReferences } from "@/lib/canvas/canvas-colored-pencil";
import { useCanvasColoredPencil } from "./colored-pencil/use-colored-pencil";
import { ColoredPencilDialog } from "./colored-pencil/colored-pencil-dialog";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    onDisconnectReference?: (reference: CanvasResourceReference) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
    workspaceMode?: CanvasWorkspaceMode;
};

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, onDisconnectReference, mentionReferences = [], onImageSettingsOpenChange, workspaceMode = "professional" }: CanvasNodePromptPanelProps) {
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const themeName = useThemeStore((state) => state.theme);
    const theme = canvasThemes[themeName];
    const creditsEnabled = useUserStore((state) => state.features.creditsEnabled);
    const simpleMode = workspaceMode === "simple";
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const pencil = useCanvasColoredPencil({ node, config, references: mentionReferences, onConfigChange });
    const displayedReferences = useMemo(() => canvasColoredPencilReferences(mentionReferences, node.metadata?.coloredPencilReferences), [mentionReferences, node.metadata?.coloredPencilReferences]);
    const pencilAvailable = mode === "video" && supportsColoredPencil(config, config.model);
    const hasPencilImages = mentionReferences.some((reference) => reference.active && reference.kind === "image");
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const savedPrompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
    const [prompt, setPrompt] = useState(savedPrompt);
    const [presetOpen, setPresetOpen] = useState(false);
    const [expandedPresetOpen, setExpandedPresetOpen] = useState(false);
    const [expandedPromptOpen, setExpandedPromptOpen] = useState(false);
    const [referenceMenu, setReferenceMenu] = useState<{ expanded: boolean; marking: boolean } | null>(null);
    const [videoFramesOpen, setVideoFramesOpen] = useState(false);
    const generationCount = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const priceChannel = resolveModelChannel(config, config.model);
    const creditEstimate = requestCreditEstimate({
        channelMode: priceChannel.scope === "system" ? "remote" : "local",
        modelCosts: priceChannel.modelCosts,
        model: modelOptionName(config.model),
        count: mode === "image" ? generationCount : 1,
        seconds: mode === "video" ? config.videoSeconds : 1,
        resolution: mode === "video" ? config.vquality : mode === "image" ? config.quality : undefined,
        referenceVideoCount: mode === "video" ? mentionReferences.filter((reference) => reference.active && reference.kind === "video").length : 0,
    });
    const activeReferenceCount = mentionReferences.filter((item) => item.active && item.kind !== "skill").length;
    const isSubmitDisabled = !isRunning && (!prompt.trim() || creditEstimate.kind === "unavailable");
    const canExpandPrompt = mode === "image" || mode === "video";
    const isPortraitTexture = mode === "image" && Boolean(node.metadata?.portraitTexture);

    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    }, [node.id, node.metadata?.composerContent, node.metadata?.prompt]);

    useEffect(() => {
        setExpandedPromptOpen(false);
        setExpandedPresetOpen(false);
        setReferenceMenu(null);
        setVideoFramesOpen(false);
    }, [node.id]);

    const skillReferences = useMemo(() => mentionReferences.filter((item) => item.kind === "skill"), [mentionReferences]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        onPromptChange(node.id, value);
        if (/(^|\s)\/[\p{L}\p{N}_-]*$/u.test(value)) {
            if (expandedPromptOpen) setExpandedPresetOpen(true);
            else setPresetOpen(true);
        }
    };

    const applyPreset = (preset: CanvasPromptPreset) => {
        const withoutSlash = prompt.replace(/(^|\s)\/[\p{L}\p{N}_-]*$/u, "$1").trimEnd();
        updatePrompt(withoutSlash ? `${withoutSlash}\n${preset.prompt}` : preset.prompt);
    };

    const insertPromptReference = (reference: CanvasResourceReference) => {
        const insertText = `${canvasResourceMentionToken(reference)} `;
        const pendingMentionMatch = /@[^\s@，。！？、,.!?;:]*\s*$/.exec(prompt);
        if (pendingMentionMatch) {
            const prefix = prompt.slice(0, pendingMentionMatch.index).replace(/\s*$/, "");
            updatePrompt(prefix ? `${prefix} ${insertText}` : insertText);
            return;
        }
        const basePrompt = prompt.replace(/\s*$/, "");
        updatePrompt(basePrompt ? `${basePrompt} ${insertText}` : insertText);
    };

    const insertSmartReferences = () => {
        const result = appendMatchedCanvasResourceMentions(prompt, mentionReferences);
        if (!result.matchedReferences.length) {
            message.info("未匹配到角色、场景或道具，请先为参考素材命名或添加标签");
            return;
        }
        if (!result.addedReferences.length) {
            message.info("匹配到的参考素材已经全部引用");
            return;
        }
        updatePrompt(result.value);
        message.success(`已智能引用 ${result.addedReferences.length} 个素材`);
    };

    const submit = () => {
        if (pencil.busy || pencil.open) { message.info("请先完成转彩铅并确认使用图片，再生成视频"); return false; }
        const text = prompt.trim();
        if (!text || isRunning || isSubmitDisabled) return false;
        onGenerate(node.id, mode, text);
        return true;
    };

    const submitExpandedPrompt = () => {
        if (submit()) {
            setExpandedPresetOpen(false);
            setExpandedPromptOpen(false);
        }
    };

    const renderReferencePicker = (expanded: boolean, marking: boolean) => (
        <Popover
            trigger="click"
            placement="topLeft"
            arrow={false}
            open={referenceMenu?.expanded === expanded && referenceMenu?.marking === marking}
            onOpenChange={(open) => setReferenceMenu(open ? { expanded, marking } : null)}
            classNames={{ root: "canvas-preset-picker-popover", container: "canvas-composer-picker-surface", content: "canvas-composer-popover-content" }}
            content={
                <div className="canvas-node-reference-menu" data-canvas-no-zoom>
                    <div className="canvas-composer-picker-heading"><span>{marking ? "插入素材标记" : "画布参考"}</span><span>{activeReferenceCount} 个素材</span></div>
                    <div className="canvas-composer-picker-list" data-canvas-wheel-scroll>
                    {activeReferenceCount ? mentionReferences.filter((reference) => reference.active && reference.kind !== "skill").map((reference) => (
                        <button key={reference.id} type="button" className="canvas-node-reference-menu-item" onClick={() => { insertPromptReference(reference); setReferenceMenu(null); }}>
                            <span className="canvas-node-reference-menu-preview"><ReferenceThumbnail reference={reference} /></span>
                            <span className="canvas-node-reference-menu-copy"><span title={reference.title || reference.label}>{reference.title || reference.label}</span><small>{reference.label}</small></span>
                            <ArrowUpRight className="canvas-node-reference-menu-hint" aria-hidden />
                        </button>
                    )) : <p className="canvas-node-reference-menu-empty">将图片或其他素材连接到当前节点，即可在这里引用。</p>}
                    </div>
                </div>
            }
        >
            <button type="button" className="canvas-node-studio-tool-pill" aria-label={marking ? "插入素材标记" : "查看参考素材"} aria-expanded={referenceMenu?.expanded === expanded && referenceMenu?.marking === marking}>
                {marking ? <Crosshair /> : <ImageIcon />}
                {marking ? "标记" : "画布参考"}
            </button>
        </Popover>
    );

    const renderComposerHeader = (expanded: boolean) => (
        <div className="canvas-node-studio-header-inner flex-wrap">
            {isPortraitTexture ? (
                <CanvasPortraitTexturePopover value={node.metadata?.portraitTexture} placement={expanded ? "topRight" : "topLeft"} onChange={(portraitTexture) => onConfigChange(node.id, { portraitTexture })} />
            ) : renderReferencePicker(expanded, false)}
            {renderReferencePicker(expanded, true)}
            <button
                type="button"
                className="canvas-node-studio-tool-pill disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!prompt.trim() || !activeReferenceCount}
                onClick={insertSmartReferences}
                aria-label="智能匹配并引用角色、场景和道具"
                title="根据提示词匹配已连接的角色、场景和道具"
            >
                <Link2 />
                智能引用
            </button>
            {!simpleMode ? <CanvasPresetPicker mode={mode} skillReferences={skillReferences} open={expanded ? expandedPresetOpen : presetOpen} onOpenChange={expanded ? setExpandedPresetOpen : setPresetOpen} onSelect={applyPreset} triggerLabel="风格" triggerClassName="canvas-node-studio-tool-pill" /> : null}
            {mode === "video" && !simpleMode ? <CanvasVideoFramePicker open={videoFramesOpen} onOpenChange={setVideoFramesOpen} /> : null}
            {pencilAvailable ? <Tooltip title={hasPencilImages ? "选择参考图片转为彩铅风格" : "请先连接参考图片"}>
                <button type="button" className="canvas-node-studio-tool-pill disabled:cursor-not-allowed disabled:opacity-40" disabled={isRunning || (!hasPencilImages && !pencil.busy)} onClick={() => void pencil.begin()} aria-label="参考图转彩铅" aria-haspopup="dialog" aria-expanded={pencil.open}>
                    {pencil.busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Pencil aria-hidden="true" />}<span>{pencil.busy ? "转图中" : "转彩铅"}</span>
                </button>
            </Tooltip> : null}
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                {!expanded && canExpandPrompt ? (
                    <Tooltip title="放大编辑">
                        <button
                            type="button"
                            className="canvas-node-studio-icon-button"
                            onClick={() => setExpandedPromptOpen(true)}
                            aria-label="放大编辑提示词"
                        >
                            <Maximize2 />
                        </button>
                    </Tooltip>
                ) : null}
            </div>
        </div>
    );

    const shouldShowGenerationControls = !simpleMode || mode === "image" || mode === "video";
    const renderComposerControls = (expanded: boolean) => {
        return (
            <div className="canvas-node-studio-controls">
                {shouldShowGenerationControls ? <div className="canvas-node-studio-options">
                <div className="canvas-node-studio-model">
                    <ModelPicker
                        className="canvas-node-studio-model-trigger"
                        fullWidth
                        config={config}
                        value={config.model}
                        onChange={(model) => onConfigChange(node.id, { model })}
                        capability={mode}
                        onMissingConfig={() => navigateToSettings({ continueCreation: true })}
                        showSelectedPrice={false}
                    />
                </div>
                {mode !== "text" ? <span className="canvas-node-studio-divider" aria-hidden /> : null}
                    {mode === "image" ? (
                        <CanvasImageSettingsPopover
                            config={config}
                            placement={expanded ? "topRight" : "topLeft"}
                            buttonClassName="canvas-node-studio-settings"
                            onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                            onMissingConfig={() => navigateToSettings({ continueCreation: true })}
                            onOpenChange={expanded ? undefined : onImageSettingsOpenChange}
                        />
                    ) : mode === "video" ? (
                        <CanvasVideoSettingsPopover
                            config={config}
                            placement={expanded ? "topRight" : "topLeft"}
                            buttonClassName="canvas-node-studio-settings"
                            onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                        />
                    ) : mode === "audio" ? (
                        <CanvasAudioSettingsPopover
                            config={config}
                            buttonClassName="canvas-node-studio-settings"
                            onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))}
                        />
                    ) : null}
                </div> : <span className="canvas-node-studio-default-hint">{activeReferenceCount ? `已连接 ${activeReferenceCount} 个素材` : "将使用默认模型与参数"}</span>}
                <div className="canvas-node-studio-actions">
                    {mode === "audio" ? <AudioPreviewButton config={config} prompt={prompt} theme={theme} compact /> : null}
                    <Tooltip title="Ctrl / ⌘ + Enter 生成，Enter 换行">
                        <span className="canvas-node-studio-shortcut" tabIndex={0} aria-label="快捷键：Ctrl 或 Command 加 Enter 生成"><Keyboard /></span>
                    </Tooltip>
                    <div className="studio-composer-submit-stack is-canvas">
                        {creditsEnabled ? <GenerationCostIndicator estimate={creditEstimate} compact /> : null}
                        <Button
                            type="text"
                            className={`canvas-node-studio-send${isRunning ? " is-running" : ""}`}
                            danger={isRunning}
                            disabled={isSubmitDisabled}
                            onClick={() => (isRunning ? onStop(node.id) : expanded ? submitExpandedPrompt() : submit())}
                            aria-label={isRunning ? "停止生成" : "生成"}
                        >
                            {isRunning ? <Square className="size-4 fill-current" /> : <ArrowUp className="size-5" />}
                        </Button>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div
            className="aceternity-floating-panel studio-composer canvas-node-studio-surface canvas-node-studio-composer"
            style={{ color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <header className="canvas-node-studio-header">{renderComposerHeader(false)}</header>

            <div
                className={`canvas-node-studio-writing${activeReferenceCount ? " is-reference-connected" : ""}${videoFramesOpen ? " is-video-frames-open" : ""}`}
            >
                <ConnectedReferenceShelf references={displayedReferences} theme={theme} onInsert={insertPromptReference} onDisconnect={onDisconnectReference} />
                {mode === "video" && !simpleMode && videoFramesOpen ? <CanvasVideoFrameSlots metadata={node.metadata} onMetadataChange={(patch) => onConfigChange(node.id, patch)} /> : null}
                <CanvasResourceMentionTextarea
                    value={prompt}
                    references={displayedReferences}
                    onChange={updatePrompt}
                    containerClassName="canvas-node-studio-editor-container min-h-0 flex-1"
                    className="canvas-node-studio-editor thin-scrollbar w-full resize-none border-none bg-transparent"
                    style={{ color: theme.node.text, outline: "none", boxShadow: "none" }}
                    placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                    aria-label={`${modeDisplayName(mode)}提示词`}
                    onSubmit={() => submit()}
                    sendOnEnter={false}
                />
            </div>

            <footer className="canvas-node-studio-dock">{renderComposerControls(false)}</footer>

            <Modal
                className="canvas-prompt-editor-modal"
                classNames={{ container: "canvas-prompt-editor-modal-container", body: "canvas-prompt-editor-modal-body" }}
                open={expandedPromptOpen}
                title={null}
                footer={null}
                centered
                width="min(1120px, calc(100vw - 32px))"
                destroyOnHidden
                onCancel={() => {
                    setExpandedPresetOpen(false);
                    setExpandedPromptOpen(false);
                    setReferenceMenu(null);
                }}
                styles={{
                    container: { display: "flex", height: "min(720px, calc(100dvh - 32px))", maxHeight: "calc(100dvh - 32px)", flexDirection: "column", padding: 0, overflow: "hidden" },
                    body: { display: "flex", minHeight: 0, flex: "1 1 auto", flexDirection: "column", padding: 0, overflow: "hidden" },
                }}
            >
                <div className="canvas-node-studio-surface canvas-node-studio-expanded" style={{ color: theme.node.text }}>
                    <header className="canvas-node-studio-header pr-8">{renderComposerHeader(true)}</header>
                    <div className={`canvas-node-studio-writing${videoFramesOpen ? " is-video-frames-open" : ""}`}>
                        <ConnectedReferenceShelf references={displayedReferences} theme={theme} onInsert={insertPromptReference} onDisconnect={onDisconnectReference} />
                        {mode === "video" && !simpleMode && videoFramesOpen ? <CanvasVideoFrameSlots metadata={node.metadata} onMetadataChange={(patch) => onConfigChange(node.id, patch)} /> : null}
                        <CanvasResourceMentionTextarea
                            value={prompt}
                            references={displayedReferences}
                            onChange={updatePrompt}
                            containerClassName="canvas-node-studio-editor-container min-h-0 flex-1"
                            className="canvas-node-studio-editor thin-scrollbar w-full resize-none border-none bg-transparent"
                            style={{ color: theme.node.text, outline: "none", boxShadow: "none" }}
                            placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                            aria-label={`${modeDisplayName(mode)}提示词`}
                            onSubmit={submitExpandedPrompt}
                            sendOnEnter={false}
                        />
                    </div>
                    <footer className="canvas-node-studio-dock">{renderComposerControls(true)}</footer>
                </div>
            </Modal>
            <ColoredPencilDialog controller={pencil} config={config} />
        </div>
    );
}

function modeDisplayName(mode: CanvasNodeGenerationMode) {
    if (mode === "image") return "图片";
    if (mode === "video") return "视频";
    if (mode === "audio") return "音频";
    return "文本";
}

function ConnectedReferenceShelf({
    references,
    theme,
    onInsert,
    onDisconnect,
}: {
    references: CanvasResourceReference[];
    theme: CanvasTheme;
    onInsert: (reference: CanvasResourceReference) => void;
    onDisconnect?: (reference: CanvasResourceReference) => void;
}) {
    const activeReferences = references.filter((item) => item.active && item.kind !== "skill");
    const [imagePreview, setImagePreview] = useState<CanvasResourceReference | null>(null);
    const [resolvedPreviews, setResolvedPreviews] = useState<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;
        const pending = activeReferences.filter((reference) => !reference.previewUrl && !resolvedPreviews[reference.id] && reference.storageKey && ["image", "character", "video"].includes(reference.kind));
        if (!pending.length) return;
        void Promise.all(
            pending.map(async (reference) => {
                const previewUrl = await resolveResourceUrl(reference.storageKey).catch(() => "");
                return previewUrl ? [reference.id, previewUrl] as const : null;
            }),
        ).then((entries) => {
            if (cancelled) return;
            const next = Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
            if (Object.keys(next).length) setResolvedPreviews((current) => ({ ...current, ...next }));
        });
        return () => {
            cancelled = true;
        };
    }, [activeReferences, resolvedPreviews]);

    if (!activeReferences.length) return null;

    return (
        <>
            <div className="canvas-reference-shelf thin-scrollbar" role="group" aria-label="已连接素材">
                {activeReferences.map((reference, index) => {
                    const previewUrl = reference.previewUrl || resolvedPreviews[reference.id];
                    const displayReference = previewUrl ? { ...reference, previewUrl } : reference;
                    const canPreview = (reference.kind === "image" || reference.kind === "character") && Boolean(previewUrl);
                    return (
                        <span key={reference.id} className="canvas-reference-card">
                            <button
                                type="button"
                                className={`group canvas-reference-card-button${canPreview ? " is-previewable" : ""}`}
                                style={{ background: theme.toolbar.itemHover, color: theme.node.text, outlineColor: theme.node.activeStroke, boxShadow: `0 4px 14px ${theme.spatial.shadow}` }}
                                title={canPreview ? `预览 ${reference.title}` : `插入 @${reference.label}`}
                                aria-label={canPreview ? `预览 ${reference.title}` : `插入 @${reference.label}`}
                                onClick={() => (canPreview ? setImagePreview(displayReference) : onInsert(reference))}
                            >
                                <span className="canvas-reference-thumbnail">
                                    <ReferenceThumbnail reference={displayReference} />
                                </span>
                                <span className="canvas-reference-label" title={reference.title || reference.label}>{reference.title || reference.label}</span>
                                <span className="canvas-reference-index">{index + 1}</span>
                            </button>
                            {onDisconnect ? (
                                <button
                                    type="button"
                                    className="canvas-reference-remove"
                                    style={{ outlineColor: theme.node.activeStroke }}
                                    title={`移除 ${reference.title} 的连接`}
                                    aria-label={`移除 ${reference.title} 的连接`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onDisconnect(reference);
                                    }}
                                >
                                    <X className="size-2" />
                                </button>
                            ) : null}
                        </span>
                    );
                })}
            </div>
            {imagePreview?.previewUrl ? (
                <AntImage
                    src={imagePreview.previewUrl}
                    alt={imagePreview.title || imagePreview.label}
                    style={{ display: "none" }}
                    preview={{
                        open: true,
                        movable: true,
                        minScale: 0.5,
                        maxScale: 12,
                        scaleStep: 0.25,
                        onOpenChange: (open) => !open && setImagePreview(null),
                    }}
                />
            ) : null}
        </>
    );
}

function ReferenceThumbnail({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-full object-cover" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="size-full bg-black object-cover" muted preload="metadata" />;
    if (reference.kind === "character" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-full bg-black/5 object-contain" />;

    const Icon = reference.sourceType === CanvasNodeType.Drawing ? Pencil : reference.kind === "character" ? UserRound : reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-full place-items-center bg-black/10 text-current dark:bg-white/10">
            <Icon className="size-3.5 opacity-75" />
        </span>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text || type === CanvasNodeType.Skill ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : mode === "audio" ? globalConfig.audioModel : globalConfig.textModel;
    const fallbackModel = mode === "image" ? defaultConfig.imageModel : mode === "video" ? defaultConfig.videoModel : mode === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    const storedModel = node.metadata?.model;
    const model = storedModel && configuredModelMatchesCapability(globalConfig, storedModel, mode) ? storedModel : defaultModel && configuredModelMatchesCapability(globalConfig, defaultModel, mode) ? defaultModel : fallbackModel;
    const storedImageSettings = mode === "image" && (!storedModel || storedModel === model) ? node.metadata : undefined;
    const imageProfile = mode === "image" ? modelCapabilityConfigFor(globalConfig, model).image : undefined;
    const normalizedImage = imageProfile
        ? normalizeImageValue(imageProfile, {
              quality: storedImageSettings?.quality || globalConfig.quality || defaultConfig.quality,
              size: storedImageSettings?.size || globalConfig.size || defaultConfig.size,
              transparentBackground: storedImageSettings?.transparentBackground || globalConfig.transparentBackground,
              count: String(storedImageSettings?.count || globalConfig.canvasImageCount || globalConfig.count || defaultConfig.count),
          })
        : undefined;
    const videoProfile = mode === "video" ? modelCapabilityConfigFor(globalConfig, model).video : undefined;
    const normalizedVideo = videoProfile
        ? normalizeVideoValue(videoProfile, {
              seconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
              ratio: node.metadata?.size || globalConfig.size || defaultConfig.size,
              resolution: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
          })
        : undefined;
    return {
        ...globalConfig,
        model,
        quality: normalizedImage?.quality || storedImageSettings?.quality || globalConfig.quality || defaultConfig.quality,
        size: mode === "video"
            ? normalizedVideo?.ratio || node.metadata?.size || globalConfig.size || defaultConfig.size
            : normalizedImage?.size || storedImageSettings?.size || globalConfig.size || defaultConfig.size,
        transparentBackground: normalizedImage?.transparentBackground || ((storedImageSettings?.transparentBackground || globalConfig.transparentBackground) === "true" ? "true" : "false"),
        videoSeconds: normalizedVideo?.seconds || normalizeVideoDuration(node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds),
        vquality: normalizedVideo?.resolution.replace(/p$/i, "") || normalizeVideoResolution(node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality),
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        audioReferenceStorageKey: node.metadata?.audioReferenceStorageKey || globalConfig.audioReferenceStorageKey,
        audioReferenceName: node.metadata?.audioReferenceName || globalConfig.audioReferenceName,
        audioReferenceMimeType: node.metadata?.audioReferenceMimeType || globalConfig.audioReferenceMimeType,
        count: normalizedImage?.count || String(storedImageSettings?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (mode === "image") return hasImageContent ? "输入新提示词，重新生成当前图片" : "可直接文字生图，或连接图片输入文字指令进行编辑，如：将背景改为雪夜";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    if (key === "audioReferenceStorageKey") return { audioReferenceStorageKey: value };
    if (key === "audioReferenceName") return { audioReferenceName: value };
    if (key === "audioReferenceMimeType") return { audioReferenceMimeType: value };
    return { audioInstructions: value };
}
