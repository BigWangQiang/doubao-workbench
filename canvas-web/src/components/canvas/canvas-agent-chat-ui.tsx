import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button, Tooltip } from "antd";
import { ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, ImagePlus, LoaderCircle, Plus, UserRound, Wrench, X, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { WorkspaceUserAvatar } from "@/components/layout/workspace-user-avatar";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAgentOp, CanvasAgentOperationImpact, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { getAgentExecutionProgressDetails, type AgentExecutionPhase } from "@/lib/canvas/canvas-agent-execution-progress";
import type { LocalUser } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";

export type { AgentExecutionPhase } from "@/lib/canvas/canvas-agent-execution-progress";

export type CanvasAgentChatAttachment = { id: string; name: string; url: string };
export type CanvasAgentMode = "online" | "cloud" | "local";
export type CanvasAgentChatMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    attachments?: CanvasAgentChatAttachment[];
};

const COMPLETED_TOOL_STATUSES = new Set(["completed", "succeeded", "success", "done", "finished"]);
const INTERNAL_TOOL_TITLES = new Set(["操作画布", "工具调用", "读取画布", "读取选区", "导出快照"]);

export type AgentGenerationChoiceSelection = {
    model: string;
    ratio?: string;
    seconds?: string;
    vquality?: string;
    quality?: string;
    generateAudio?: string;
    watermark?: string;
    ending?: string;
    audioFormat?: string;
    audioSpeed?: string;
    supplement?: string;
};
export type AgentExecutionLedger = {
    created: Map<string, string>;
    updated: Map<string, string>;
    removed: Set<string>;
    submitted: Set<string>;
    changed: boolean;
    failed: boolean;
};

export function createAgentExecutionLedger(): AgentExecutionLedger {
    return { created: new Map(), updated: new Map(), removed: new Set(), submitted: new Set(), changed: false, failed: false };
}

// Compare snapshots around each tool call so concurrent manual edits are not included in the summary.
export function recordAgentExecution(ledger: AgentExecutionLedger, before: CanvasAgentSnapshot, after: CanvasAgentSnapshot, ops: CanvasAgentOp[]) {
    const previous = new Map(before.nodes.map((node) => [node.id, node]));
    const next = new Map(after.nodes.map((node) => [node.id, node]));
    for (const node of after.nodes) {
        const old = previous.get(node.id);
        if (!old) {
            ledger.created.set(node.id, node.type);
            ledger.removed.delete(node.id);
        } else if (JSON.stringify(old) !== JSON.stringify(node) && !ledger.created.has(node.id)) {
            ledger.updated.set(node.id, node.type);
        }
    }
    for (const node of before.nodes) {
        if (next.has(node.id)) continue;
        if (!ledger.created.delete(node.id)) ledger.removed.add(node.id);
        ledger.updated.delete(node.id);
    }
    for (const op of ops) {
        if (op.type === "run_generation" && next.has(op.nodeId)) ledger.submitted.add(op.nodeId);
    }
    ledger.changed ||= JSON.stringify(before) !== JSON.stringify(after) || ledger.submitted.size > 0;
}

export function agentExecutionSummary(ledger: AgentExecutionLedger): string | null {
    if (ledger.failed || !ledger.changed) return null;
    const labels: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "音频", skill: "技能" };
    const parts: string[] = [];
    for (const [verb, nodes] of [["创建", ledger.created], ["更新", ledger.updated]] as const) {
        const counts = new Map<string, number>();
        for (const kind of nodes.values()) counts.set(kind, (counts.get(kind) || 0) + 1);
        for (const [kind, count] of counts) parts.push(`${verb}${labels[kind] || "画布"}节点 ${count} 个`);
    }
    if (ledger.removed.size) parts.push(`删除节点 ${ledger.removed.size} 个`);
    if (ledger.submitted.size) parts.push(`已提交生成 ${ledger.submitted.size} 项，生成结果请在画布查看`);
    return parts.join("，") || "已更新画布布局、连接或选择";
}

export function AgentExecutionProgress({ phase, theme, preparingContext = false, interruptionNotice }: { phase: AgentExecutionPhase; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; preparingContext?: boolean; interruptionNotice?: string | null }) {
    const progress = getAgentExecutionProgressDetails(phase);
    const waiting = progress.status === "waiting";
    const complete = progress.status === "complete";
    const activityLabel = waiting ? activeAgentPhaseLabel(phase) : complete ? "任务完成" : preparingContext ? "正在加载 Skill 并整理画布上下文" : activeAgentPhaseLabel(phase);
    return (
        <div className="flex min-w-0 items-start gap-2 py-1" style={{ color: theme.node.text }} role="status" aria-live="polite" aria-atomic="true">
            {complete ? <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" style={{ color: theme.accent.primary }} /> : waiting ? <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" style={{ color: theme.accent.primary }} /> : <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" style={{ color: theme.accent.primary }} />}
            <div className="min-w-0 flex-1">
                <p className="text-sm leading-5">{activityLabel}</p>
                {interruptionNotice ? <p className="mt-1 text-xs leading-5" style={{ color: theme.accent.primary }}>{interruptionNotice}</p> : null}
            </div>
        </div>
    );
}

function activeAgentPhaseLabel(phase: AgentExecutionPhase) {
    const labels: Record<AgentExecutionPhase, string> = {
        analysis: "正在思考并分析画布",
        choice: "等待你选择生成参数",
        approval: "等待你确认执行",
        execution: "正在执行画布操作",
        checking: "正在核对画布变更",
        summary: "任务完成",
    };
    return labels[phase];
}

function AgentCompletionSummary({ text, submitted, theme, onViewCanvas, onContinue }: { text: string; submitted: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onViewCanvas?: () => void; onContinue?: () => void }) {
    return <section className="rounded-xl border p-3.5" style={{ borderColor: theme.toolbar.border, color: theme.node.text }}>
        <div className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 aria-hidden="true" className="size-4 shrink-0" style={{ color: theme.accent.primary }} />{submitted ? "画布操作已提交" : "任务完成"}</div>
        <p className="mt-2 text-sm leading-6" style={{ color: theme.node.muted }}>{text}</p>
        {onViewCanvas || onContinue ? <div className="mt-3 flex flex-wrap gap-2">{onViewCanvas ? <Button onClick={onViewCanvas}>查看画布</Button> : null}{onContinue ? <Button onClick={onContinue}>继续调整</Button> : null}</div> : null}
    </section>;
}

export function AgentChatMessage({ item, theme, user, nodes = [], onRejectTool, onApproveTool, onSelectSuggestion, onSelectGenerationChoice, onViewCanvas, onContinue }: { item: CanvasAgentChatMessage; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; user: LocalUser | null; nodes?: CanvasNodeData[]; onRejectTool?: (id: string) => void; onApproveTool?: (id: string) => void; onSelectSuggestion?: (text: string) => void; onSelectGenerationChoice?: (id: string, selection: AgentGenerationChoiceSelection) => void; onViewCanvas?: () => void; onContinue?: () => void }) {
    const isUser = item.role === "user";
    const isSystem = item.role === "system";
    const displayTitle = isUser ? item.title : sanitizeAgentDisplayText(item.title || "");
    const displayText = isUser ? item.text : sanitizeAgentDisplayText(item.text);
    const color = item.role === "error" ? "#dc2626" : item.role === "tool" ? "#2563eb" : theme.node.text;
    if (isSystem) {
        return (
            <div className="flex justify-center text-xs">
                <div className="max-w-[88%] px-3 py-1.5 text-center" style={{ color: theme.node.muted }}>
                    {displayText}
                </div>
            </div>
        );
    }
    if (item.role === "tool") {
        if (objectField(item.detail, "kind") === "execution-summary") {
            return <AgentCompletionSummary text={displayText} submitted={Boolean(objectField(item.detail, "submitted"))} theme={theme} onViewCanvas={onViewCanvas} onContinue={onContinue} />;
        }
        if (objectField(item.detail, "kind") === "generation-choice" && objectField(item.detail, "status") === "pending") {
            return <AgentGenerationChoiceCard summary={displayText} detail={item.detail} theme={theme} onSelect={(selection) => onSelectGenerationChoice?.(item.id, selection)} />;
        }
        const toolStatus = objectField(item.detail, "status");
        const processing = toolStatus === "processing" && objectField(item.detail, "approvalInProgress") === true;
        if (toolStatus === "pending" || processing) {
            return <AgentPendingToolCard summary={displayText} detail={item.detail} theme={theme} processing={processing} onReject={processing ? undefined : () => onRejectTool?.(item.id)} onApprove={processing ? undefined : () => onApproveTool?.(item.id)} />;
        }
        if (shouldHideCompletedToolCard(item)) return null;
        return (
            <div className="flex items-start gap-2.5">
                <AgentToolCard title={displayTitle || "工具调用"} text={displayText} detail={item.detail} theme={theme} onSelectSuggestion={onSelectSuggestion} />
            </div>
        );
    }
    return (
        <div className={`flex items-start gap-2.5 ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`min-w-0 text-sm leading-6 ${isUser ? "max-w-[86%] rounded-xl px-3 py-2.5 text-right" : "w-full text-left"}`} style={{ color, ...(isUser ? { background: theme.accent.primarySoft } : {}) }}>
                {isUser ? <div className="whitespace-pre-wrap break-words text-left">{item.text}</div> : item.role === "assistant" ? <AgentMarkdown text={displayText} nodes={nodes} /> : <div className="whitespace-pre-wrap break-words text-left">{displayText}</div>}
                {item.attachments?.length ? <AgentMessageAttachments attachments={item.attachments} /> : null}
            </div>
            {isUser ? <AgentUserAvatar user={user} theme={theme} /> : null}
        </div>
    );
}

const CANVAS_NODE_LABELS: Partial<Record<CanvasNodeData["type"], string>> = {
    image: "图片节点",
    video: "视频节点",
    audio: "音频节点",
    text: "文本节点",
    drawing: "绘图节点",
    script: "脚本节点",
    skill: "技能节点",
    config: "配置节点",
    frame: "画框节点",
};

type MarkdownAstNode = {
    type: string;
    value?: string;
    children?: MarkdownAstNode[];
};

function AgentMarkdown({ text, nodes = [] }: { text: string; nodes?: CanvasNodeData[] }) {
    const nodeLabels = useMemo(() => buildNodeLabels(nodes), [nodes]);
    const nodeReferencePlugin = useMemo(() => createNodeReferenceRemarkPlugin(nodeLabels), [nodeLabels]);
    return (
        <div className="agent-markdown min-w-0 break-words text-left">
            <ReactMarkdown
                remarkPlugins={[remarkGfm, nodeReferencePlugin]}
                skipHtml
                components={{
                    h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
                    h2: ({ children }) => <h4 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
                    h3: ({ children }) => <h5 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0">{children}</h5>,
                    p: ({ children }) => <p className="my-1.5 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>,
                    ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>,
                    li: ({ children }) => <li className="pl-0.5">{children}</li>,
                    blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-current/25 pl-3 opacity-80">{children}</blockquote>,
                    code: ({ children, className }) => {
                        const value = Array.isArray(children) ? children.join("") : String(children ?? "");
                        if (isInternalTechnicalCode(value)) return null;
                        return <code className={`${className || ""} rounded bg-black/[.07] px-1 py-0.5 text-[.9em] dark:bg-white/[.1]`}>{children}</code>;
                    },
                    pre: () => null,
                    table: ({ children }) => <div className="thin-scrollbar my-2 max-w-full overflow-x-auto"><table className="min-w-full border-collapse text-left text-xs">{children}</table></div>,
                    th: ({ children }) => <th className="border border-current/15 bg-black/[.05] px-2 py-1.5 font-semibold dark:bg-white/[.08]">{children}</th>,
                    td: ({ children }) => <td className="border border-current/15 px-2 py-1.5 align-top">{children}</td>,
                    a: ({ children, href }) => {
                        const safeHref = safeMarkdownHref(href);
                        return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer" className="underline decoration-current/35 underline-offset-2">{children}</a> : <span>{children}</span>;
                    },
                }}
            >
                {sanitizeAgentDisplayText(text)}
            </ReactMarkdown>
        </div>
    );
}

function buildNodeLabels(nodes: CanvasNodeData[]) {
    const labels = new Map<string, string>();
    for (const node of nodes) {
        const id = node.id.trim();
        if (!id) continue;
        const fallback = CANVAS_NODE_LABELS[node.type] || "画布节点";
        const title = node.title?.trim();
        labels.set(id, title && title !== id ? title : fallback);
    }
    return labels;
}

function createNodeReferenceRemarkPlugin(labels: Map<string, string>) {
    const ids = Array.from(labels.keys()).sort((left, right) => right.length - left.length);
    const pattern = ids.length ? new RegExp(`(?<![A-Za-z0-9_-])(?:${ids.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`, "g") : null;
    return () => (tree: MarkdownAstNode) => {
        transformMarkdownNode(tree, labels, pattern);
    };
}

function transformMarkdownNode(node: MarkdownAstNode, labels: Map<string, string>, pattern: RegExp | null): MarkdownAstNode | MarkdownAstNode[] {
    if (node.type === "code") return node;
    if (node.type === "inlineCode") {
        const value = node.value || "";
        const label = labels.get(value);
        const strippedValue = stripReferenceMarker(value);
        if (label) return { ...node, value: stripReferenceMarker(label) };
        if (strippedValue !== value) return { ...node, value: strippedValue };
        return node;
    }
    if (node.type === "text" && node.value) {
        const value = stripReferenceMarker(node.value);
        return pattern ? splitNodeReferenceText(value, labels, pattern) : { type: "text", value };
    }
    if (node.children) {
        const nextChildren: MarkdownAstNode[] = [];
        let previousWasInlineCode = false;
        for (const child of node.children) {
            const transformed = transformMarkdownNode(child, labels, pattern);
            const items = Array.isArray(transformed) ? transformed : [transformed];
            for (const item of items) {
                if (previousWasInlineCode && item.type === "text" && item.value) item.value = stripReferenceStatus(item.value);
                nextChildren.push(item);
                previousWasInlineCode = item.type === "inlineCode";
            }
        }
        node.children = nextChildren;
    }
    return node;
}

function splitNodeReferenceText(value: string, labels: Map<string, string>, pattern: RegExp) {
    const parts: MarkdownAstNode[] = [];
    let cursor = 0;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
        if (match.index > cursor) parts.push({ type: "text", value: value.slice(cursor, match.index) });
        parts.push({ type: "inlineCode", value: stripReferenceMarker(labels.get(match[0]) || match[0]) });
        cursor = match.index + match[0].length;
    }
    if (!parts.length) return { type: "text", value };
    if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
    return parts;
}

function stripReferenceMarker(value: string) {
    return value.replace(/\s*(?:\(R\d+\)|\bR\d+\b)/gi, "");
}

function stripReferenceStatus(value: string) {
    return value.replace(/\b(?:success|succeeded)\b(?=\s*(?:$|[,，。.;；:：!?！？)\]}]))/gi, "");
}

function sanitizeAgentDisplayText(value: string) {
    // 仅清理对话展示中的内部标记，不改写会话里保存的原文。
    const visibleLines = value
        .split(/\r?\n/)
        .filter((line) => !/^\s*(?:[-*]\s*)?(?:arguments|input|output|payload|parameters?|model(?:_id|_name)?|temperature|top_p|max_tokens|frequency_penalty|presence_penalty|stop|seed|stream|response_format|tool_choice|logprobs|top_logprobs|logit_bias|status|phase|step|result|request_id|task_id|thread_id|run_id|call_id|node_id|connection_id|provider_id|agent_id|storage_key|mime_type|total_tokens|input_tokens|output_tokens|reasoning_tokens|usage|cost|duration_ms|aspect_ratio|width|height|cfg_scale|guidance_scale|sampler|lora|fps)\s*[:=]/i.test(line));

    return visibleLines.join("\n")
        .replace(/\bPhase\s*#?\s*\d+\b\s*[:：—–-]?\s*/gi, "")
        .replace(/\s*\(R\d+\)|\bR\d+\b/gi, "")
        .replace(/\b(?:success|succeeded)\b/gi, "")
        .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "")
        .replace(/(^|\n)[ \t]*[:：,，.;；—-]+[ \t]*/gm, "$1")
        .replace(/[ \t]+([,，。.;；:：!?！？])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/^\s*[-*]\s*(?=\n|$)/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function isInternalTechnicalCode(value: string) {
    const text = value.trim();
    return !text
        || /^(?:success|succeeded|R\d+|Phase\s*#?\s*\d+)$/i.test(text)
        || /^\{\s*"[^"]+"\s*:/s.test(text)
        || /^\[\s*\{/s.test(text)
        || /\b(?:arguments|input|output|payload|parameters?|model(?:_id|_name)?|temperature|top_p|max_tokens|frequency_penalty|presence_penalty|stop|seed|stream|response_format|tool_choice|logprobs|top_logprobs|logit_bias|status|phase|step|result|request_id|task_id|thread_id|run_id|call_id|node_id|connection_id|provider_id|agent_id|storage_key|mime_type|total_tokens|input_tokens|output_tokens|reasoning_tokens|usage|cost|duration_ms|aspect_ratio|width|height|cfg_scale|guidance_scale|sampler|lora|fps)\s*[:=]/i.test(text);
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeMarkdownHref(href?: string) {
    if (!href) return "";
    try {
        const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        const protocol = new URL(href, base).protocol;
        return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? href : "";
    } catch {
        return "";
    }
}

export function AgentGenerationChoiceCard({ summary, detail, theme, onSelect }: { summary: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect?: (selection: AgentGenerationChoiceSelection) => void }) {
    const choices = generationChoicesFromDetail(detail);
    const [model, setModel] = useState(choices.defaultModel || choices.models[0]?.value || "");
    const modelChoice = choices.models.find((item) => item.value === model) || choices.models[0];
    const ratios = modelChoice?.ratios || [];
    const [ratio, setRatio] = useState(choices.defaultRatio && ratios.includes(choices.defaultRatio) ? choices.defaultRatio : ratios[0] || "");
    const [quality, setQuality] = useState(modelChoice?.defaultQuality || modelChoice?.qualities?.[0] || "");
    const [seconds, setSeconds] = useState(modelChoice?.defaultSeconds || modelChoice?.seconds?.[0] || "");
    const [vquality, setVquality] = useState(modelChoice?.defaultVquality || modelChoice?.resolutions?.[0] || "");
    const [generateAudio, setGenerateAudio] = useState(modelChoice?.defaultGenerateAudio || "");
    const [watermark, setWatermark] = useState(modelChoice?.defaultWatermark || "");
    const [ending, setEnding] = useState(modelChoice?.defaultEnding || modelChoice?.endings?.[0] || "");
    const [audioFormat, setAudioFormat] = useState(modelChoice?.defaultAudioFormat || modelChoice?.audioFormats?.[0] || "");
    const [audioSpeed, setAudioSpeed] = useState(modelChoice?.defaultAudioSpeed || modelChoice?.audioSpeeds?.[0] || "");
    const [supplement, setSupplement] = useState("");
    const [stepIndex, setStepIndex] = useState(0);
    useEffect(() => {
        const nextChoice = choices.models.find((item) => item.value === model) || choices.models[0];
        const nextRatios = nextChoice?.ratios || [];
        setRatio((current) => nextRatios.includes(current) ? current : nextRatios[0] || "");
        setQuality(nextChoice?.defaultQuality || nextChoice?.qualities?.[0] || "");
        setSeconds(nextChoice?.defaultSeconds || nextChoice?.seconds?.[0] || "");
        setVquality(nextChoice?.defaultVquality || nextChoice?.resolutions?.[0] || "");
        setGenerateAudio(nextChoice?.defaultGenerateAudio || "");
        setWatermark(nextChoice?.defaultWatermark || "");
        setEnding(nextChoice?.defaultEnding || nextChoice?.endings?.[0] || "");
        setAudioFormat(nextChoice?.defaultAudioFormat || nextChoice?.audioFormats?.[0] || "");
        setAudioSpeed(nextChoice?.defaultAudioSpeed || nextChoice?.audioSpeeds?.[0] || "");
    }, [choices.models, model]);
    const choiceSteps: ChoiceStep[] = [
        { key: "model", label: "生成模型", options: choices.models.map((item) => ({ value: item.value, label: item.label })), value: model, onChange: (value) => setModel(value) },
        ...(ratios.length ? [{ key: "ratio", label: "生成比例", options: ratios.map((item) => ({ value: item, label: item === "adaptive" ? "自适应" : item })), value: ratio, onChange: (value: string) => setRatio(value) }] : []),
        ...(modelChoice?.qualities?.length ? [{ key: "quality", label: "图片质量", options: modelChoice.qualities.map((item) => ({ value: item, label: item })), value: quality, onChange: (value: string) => setQuality(value) }] : []),
        ...(modelChoice?.seconds?.length ? [{ key: "seconds", label: "视频时长", options: modelChoice.seconds.map((item) => ({ value: item, label: `${item} 秒` })), value: seconds, onChange: (value: string) => setSeconds(value) }] : []),
        ...(modelChoice?.resolutions?.length ? [{ key: "resolution", label: "视频清晰度", options: modelChoice.resolutions.map((item) => ({ value: item, label: item })), value: vquality, onChange: (value: string) => setVquality(value) }] : []),
        ...(modelChoice?.generateAudioOptions?.length ? [{ key: "generateAudio", label: "生成音频", options: modelChoice.generateAudioOptions.map((item) => ({ value: item, label: item === "true" ? "开启" : "关闭" })), value: generateAudio, onChange: (value: string) => setGenerateAudio(value) }] : []),
        ...(modelChoice?.watermarkOptions?.length ? [{ key: "watermark", label: "水印", options: modelChoice.watermarkOptions.map((item) => ({ value: item, label: item === "true" ? "开启" : "关闭" })), value: watermark, onChange: (value: string) => setWatermark(value) }] : []),
        ...(modelChoice?.endings?.length ? [{ key: "ending", label: "结尾处理", options: modelChoice.endings.map((item) => ({ value: item, label: item })), value: ending, onChange: (value: string) => setEnding(value) }] : []),
        ...(modelChoice?.audioFormats?.length ? [{ key: "audioFormat", label: "音频格式", options: modelChoice.audioFormats.map((item) => ({ value: item, label: item.toUpperCase() })), value: audioFormat, onChange: (value: string) => setAudioFormat(value) }] : []),
        ...(modelChoice?.audioSpeeds?.length ? [{ key: "audioSpeed", label: "语速", options: modelChoice.audioSpeeds.map((item) => ({ value: item, label: `${item}x` })), value: audioSpeed, onChange: (value: string) => setAudioSpeed(value) }] : []),
    ];
    const totalSteps = choiceSteps.length + 1;
    const currentStepIndex = Math.min(stepIndex, Math.max(0, totalSteps - 1));
    const currentStep = choiceSteps[currentStepIndex];
    const isSupplementStep = currentStepIndex === choiceSteps.length;
    useEffect(() => {
        setStepIndex((current) => Math.min(current, Math.max(0, totalSteps - 1)));
    }, [totalSteps]);
    const submitSelection = (nextSupplement = supplement) => onSelect?.({ model, ratio: ratio || undefined, seconds: seconds || undefined, quality: quality || undefined, vquality: vquality || undefined, generateAudio: generateAudio || undefined, watermark: watermark || undefined, ending: ending || undefined, audioFormat: audioFormat || undefined, audioSpeed: audioSpeed || undefined, supplement: nextSupplement.trim() || undefined });
    const skipCurrentStep = () => {
        if (isSupplementStep) {
            setSupplement("");
            submitSelection("");
            return;
        }
        setStepIndex((current) => Math.min(current + 1, totalSteps - 1));
    };
    return (
        <div className="min-w-0 flex-1 rounded-md p-3.5" style={{ background: theme.spatial.surface, color: theme.node.text }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-5">选择生成参数</div>
                    <div className="mt-1 text-sm leading-6" style={{ color: theme.node.muted }}>{summary}</div>
                </div>
            </div>
            <div className="mt-3 rounded-md border p-3" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="min-w-0 text-sm font-semibold" style={{ color: theme.node.text }}>{isSupplementStep ? "补充要求" : currentStep?.label || "生成参数"}</span>
                    <div className="flex shrink-0 items-center gap-1">
                        <button type="button" aria-label="上一个选择步骤" title="上一个选择步骤" disabled={currentStepIndex === 0} className="grid size-8 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.accent.primary }} onClick={() => setStepIndex((current) => Math.max(0, current - 1))}><ChevronLeft aria-hidden="true" className="size-4" /></button>
                        <span className="min-w-10 text-center text-xs font-medium tabular-nums" style={{ color: theme.node.muted }}>{currentStepIndex + 1}/{totalSteps}</span>
                        <button type="button" aria-label="下一个选择步骤" title="下一个选择步骤" disabled={currentStepIndex >= totalSteps - 1} className="grid size-8 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.accent.primary }} onClick={() => setStepIndex((current) => Math.min(current + 1, totalSteps - 1))}><ChevronRight aria-hidden="true" className="size-4" /></button>
                    </div>
                </div>
                {isSupplementStep ? (
                    <label className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 transition focus-within:ring-2" style={{ borderColor: supplement.trim() ? theme.accent.primary : theme.toolbar.border, background: supplement.trim() ? theme.accent.primarySoft : theme.spatial.surface, "--tw-ring-color": theme.accent.primary } as CSSProperties}>
                        <span className="grid size-6 shrink-0 place-items-center rounded-sm text-xs font-semibold tabular-nums" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>1</span>
                        <span className="shrink-0 text-sm" style={{ color: theme.node.text }}>其它，请直接输入</span>
                        <input type="text" aria-label="其它，请直接输入补充内容" value={supplement} onChange={(event) => setSupplement(event.target.value)} placeholder="风格、节奏或其他要求（可选）" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-55" style={{ color: theme.node.text }} />
                    </label>
                ) : currentStep ? <ChoiceGroup {...currentStep} theme={theme} /> : <div className="text-sm" style={{ color: theme.node.muted }}>暂无可选参数。</div>}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Button className="!h-9" disabled={currentStepIndex === 0} onClick={() => setStepIndex((current) => Math.max(0, current - 1))}>上一步</Button>
                <div className="flex items-center gap-2">
                    <Button className="!h-9" onClick={skipCurrentStep}>忽略</Button>
                    {isSupplementStep ? <Button type="primary" className="!h-9" disabled={!model} onClick={() => submitSelection()}>提交</Button> : <Button type="primary" className="!h-9" disabled={!model || !currentStep?.value} onClick={() => setStepIndex((current) => Math.min(current + 1, totalSteps - 1))}>继续</Button>}
                </div>
            </div>
        </div>
    );
}

type ChoiceStep = { key: string; label: string; options: { value: string; label: string }[]; value: string; onChange: (value: string) => void };

function ChoiceGroup({ label, options, value, onChange, theme }: Omit<ChoiceStep, "key"> & { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div role="group" aria-label={label} className="max-h-64 space-y-1.5 overflow-y-auto">
            {options.map((option, index) => <SelectionOptionRow key={option.value} index={index + 1} label={option.label} selected={option.value === value} theme={theme} onSelect={() => onChange(option.value)} />)}
        </div>
    );
}

function SelectionOptionRow({ index, label, selected, theme, onSelect, disabled = false }: { index: number; label: string; selected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: () => void; disabled?: boolean }) {
    return (
        <button type="button" disabled={disabled} aria-pressed={selected} className="flex min-h-11 w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: selected ? theme.accent.primary : theme.toolbar.border, background: selected ? theme.accent.primarySoft : theme.spatial.surface, color: theme.node.text, outlineColor: theme.accent.primary }} onClick={onSelect}>
            <span className="grid size-6 shrink-0 place-items-center rounded-sm text-xs font-semibold tabular-nums" style={{ background: selected ? theme.accent.primary : theme.node.fill, color: selected ? theme.spatial.surface : theme.node.muted }}>{index}</span>
            <span className="min-w-0 flex-1 break-words text-sm leading-5">{label}</span>
            {selected ? <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" style={{ color: theme.accent.primary }} /> : null}
        </button>
    );
}

export function AgentPendingToolCard({ summary, detail, theme, processing = false, onReject, onApprove }: { summary: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; processing?: boolean; onReject?: () => void; onApprove?: () => void }) {
    const impact = agentImpactFromDetail(detail);
    return (
        <div className="flex min-w-0 items-start gap-2.5">
            <section aria-label="工具执行审批" className="min-w-0 flex-1 rounded-md border p-3.5" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md" style={{ color: "var(--status-warning)", background: "color-mix(in srgb, var(--status-warning) 13%, transparent)" }}>
                        <CircleAlert aria-hidden="true" className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5">
                            <span>{processing ? "批准已收到" : "确认工具调用"}</span>
                            <span role={processing ? "status" : undefined} aria-live={processing ? "polite" : undefined} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[var(--fs-label)] font-medium" style={{ color: processing ? theme.accent.primary : "var(--status-warning)", background: processing ? `color-mix(in srgb, ${theme.accent.primary} 12%, transparent)` : "color-mix(in srgb, var(--status-warning) 13%, transparent)" }}>
                                {processing ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin" /> : null}
                                {processing ? "AI 已收到，正在执行" : "等待确认"}
                            </span>
                        </div>
                        <div className="mt-2 text-sm leading-6" style={{ color: theme.node.text }}>{summary}</div>
                    </div>
                </div>
                {impact?.operationCount ? (
                    <div className="mt-3 pt-1">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y py-2" style={{ borderColor: theme.toolbar.border }}>
                            <ImpactMetric label="操作" value={impact.operationCount} theme={theme} />
                            <ImpactMetric label="涉及节点" value={impact.affectedNodeCount} theme={theme} />
                            <ImpactMetric label="删除" value={impact.destructiveCount} attention={impact.destructiveCount > 0} theme={theme} />
                            <ImpactMetric label="生成" value={impact.generationCount} attention={impact.generationCount > 0} theme={theme} />
                        </div>
                        {impact.items.length ? <div className="mt-3 space-y-1.5">{impact.items.map((item, index) => <div key={`${item}-${index}`} className="flex gap-2 text-xs leading-5" style={{ color: theme.node.muted }}><span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-current" /><span>{item}</span></div>)}</div> : null}
                        {impact.warning ? <div className="mt-3 rounded-md px-2.5 py-2 text-xs leading-5" style={{ color: "color-mix(in srgb, var(--status-warning) 74%, var(--foreground))", background: "color-mix(in srgb, var(--status-warning) 12%, transparent)" }}>{impact.warning}</div> : null}
                    </div>
                ) : null}
                {processing ? (
                    <div className="mt-3">
                        <Button className="!h-9 w-full" disabled loading aria-label="批准已收到，AI 正在执行">AI 已收到，正在执行</Button>
                    </div>
                ) : onReject || onApprove ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <Button danger className="!h-9 w-full" icon={<XCircle aria-hidden="true" className="size-4" />} onClick={() => onReject?.()}>
                            拒绝执行
                        </Button>
                        <Button className="!h-9 w-full" icon={<CheckCircle2 aria-hidden="true" className="size-4" />} style={{ borderColor: "color-mix(in srgb, var(--status-success) 42%, var(--border-semantic))", color: "color-mix(in srgb, var(--status-success) 84%, var(--foreground))", background: "color-mix(in srgb, var(--status-success) 12%, transparent)" }} onClick={() => onApprove?.()}>
                            批准执行
                        </Button>
                    </div>
                ) : null}
            </section>
        </div>
    );
}

function ImpactMetric({ label, value, attention = false, theme }: { label: string; value: number; attention?: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return <div className="flex min-w-0 items-center justify-between gap-2 text-xs"><span className="min-w-0" style={{ color: theme.node.muted }}>{label}</span><span className="text-sm font-semibold tabular-nums" style={{ color: attention ? "var(--status-warning)" : theme.node.text }}>{value}</span></div>;
}

function agentImpactFromDetail(detail: unknown) {
    const impact = objectField(detail, "impact");
    if (!impact || typeof impact !== "object") return null;
    const value = impact as Partial<CanvasAgentOperationImpact>;
    return {
        operationCount: Number(value.operationCount) || 0,
        affectedNodeCount: Number(value.affectedNodeCount) || 0,
        destructiveCount: Number(value.destructiveCount) || 0,
        generationCount: Number(value.generationCount) || 0,
        items: Array.isArray(value.items) ? value.items.filter((item): item is string => typeof item === "string") : [],
        warning: typeof value.warning === "string" ? value.warning : "",
    } satisfies CanvasAgentOperationImpact;
}

export function AgentToolCard({ title, text, detail, theme, onSelectSuggestion }: { title: string; text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelectSuggestion?: (text: string) => void }) {
    const choiceSteps = suggestionStepsFromDetail(detail);
    if (choiceSteps.length) {
        return <AgentSuggestionChoiceCard steps={choiceSteps} theme={theme} onSelect={onSelectSuggestion} />;
    }
    const state = toolCardState(title, text, detail);
    return (
        <section className="min-w-0 flex-1 rounded-md px-3 py-3 text-left" style={{ background: theme.spatial.surface, color: theme.node.text }}>
            <div className="flex items-start gap-3">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md" style={{ color: state.color, background: state.softBg }}>
                    {state.icon}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5">
                        <span className="min-w-0 truncate">{title}</span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[var(--fs-label)] font-medium" style={{ color: state.color, background: state.softBg }}>
                            {state.label}
                        </span>
                    </div>
                    <div className="mt-2 text-sm leading-6" style={{ color: state.isError ? state.color : theme.node.muted }}>
                        {text}
                    </div>
                </div>
            </div>
        </section>
    );
}

type AgentSuggestionStep = { question: string; suggestions: string[] };
type AgentSuggestionAnswer = { selectedIndex: number | null; other: string; skipped: boolean };

function AgentSuggestionChoiceCard({ steps, theme, onSelect }: { steps: AgentSuggestionStep[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect?: (text: string) => void }) {
    const [stepIndex, setStepIndex] = useState(0);
    const [answers, setAnswers] = useState<AgentSuggestionAnswer[]>(() => steps.map(() => ({ selectedIndex: null, other: "", skipped: false })));
    const [submitted, setSubmitted] = useState(false);
    const currentStepIndex = Math.min(stepIndex, steps.length - 1);
    const currentStep = steps[currentStepIndex];
    const currentAnswer = answers[currentStepIndex] || { selectedIndex: null, other: "", skipped: false };
    const isAnswered = currentAnswer.skipped || (currentAnswer.selectedIndex !== null && (currentAnswer.selectedIndex >= 0 || Boolean(currentAnswer.other.trim())));
    const allAnswered = steps.every((_, index) => {
        const answer = answers[index];
        return Boolean(answer && (answer.skipped || (answer.selectedIndex !== null && (answer.selectedIndex >= 0 || Boolean(answer.other.trim())))));
    });
    const updateCurrentAnswer = (patch: Partial<AgentSuggestionAnswer>) => setAnswers((current) => {
        const next = steps.map((_, index) => current[index] || { selectedIndex: null, other: "", skipped: false });
        next[currentStepIndex] = { ...next[currentStepIndex], ...patch };
        return next;
    });
    const submitAnswers = (finalAnswers: AgentSuggestionAnswer[]) => {
        if (submitted || !onSelect) return;
        const response = steps.map((step, index) => {
            const answer = finalAnswers[index] || { selectedIndex: null, other: "", skipped: false };
            const value = answer.selectedIndex === -1 ? answer.other.trim() : answer.selectedIndex === null ? "" : step.suggestions[answer.selectedIndex] || "";
            return `${index + 1}. ${step.question}：${answer.skipped ? "（忽略）" : value || "（未填写）"}`;
        }).join("\n");
        setSubmitted(true);
        onSelect(response);
    };
    const ignoreCurrentStep = () => {
        const nextAnswers = steps.map((_, index) => answers[index] || { selectedIndex: null, other: "", skipped: false });
        nextAnswers[currentStepIndex] = { selectedIndex: null, other: "", skipped: true };
        setAnswers(nextAnswers);
        if (currentStepIndex === steps.length - 1) submitAnswers(nextAnswers);
        else setStepIndex((current) => Math.min(current + 1, steps.length - 1));
    };
    const advance = () => {
        if (!isAnswered || submitted) return;
        if (currentStepIndex === steps.length - 1) submitAnswers(answers);
        else setStepIndex((current) => Math.min(current + 1, steps.length - 1));
    };

    return (
        <section className="min-w-0 flex-1 rounded-md px-3 py-3 text-left" style={{ background: theme.spatial.surface, color: theme.node.text }} aria-label="智能体选择题">
            <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 text-sm font-semibold leading-6">{currentStep?.question}</div>
                <div className="flex shrink-0 items-center gap-1">
                    <button type="button" aria-label="上一个问题" title="上一个问题" disabled={currentStepIndex === 0 || submitted} className="grid size-8 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.accent.primary }} onClick={() => setStepIndex((current) => Math.max(0, current - 1))}><ChevronLeft aria-hidden="true" className="size-4" /></button>
                    <span className="min-w-10 text-center text-xs font-medium tabular-nums" style={{ color: theme.node.muted }}>{currentStepIndex + 1}/{steps.length}</span>
                    <button type="button" aria-label="下一个问题" title="下一个问题" disabled={currentStepIndex >= steps.length - 1 || !isAnswered || submitted} className="grid size-8 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.accent.primary }} onClick={() => setStepIndex((current) => Math.min(current + 1, steps.length - 1))}><ChevronRight aria-hidden="true" className="size-4" /></button>
                </div>
            </div>
            <div className="max-h-64 space-y-1.5 overflow-y-auto" role="group" aria-label={currentStep?.question}>
                {currentStep?.suggestions.map((suggestion, index) => <SelectionOptionRow key={`${currentStepIndex}-${suggestion}`} index={index + 1} label={suggestion} selected={currentAnswer.selectedIndex === index} theme={theme} disabled={submitted} onSelect={() => updateCurrentAnswer({ selectedIndex: index, skipped: false })} />)}
                <label className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors focus-within:ring-2" style={{ borderColor: currentAnswer.selectedIndex === -1 ? theme.accent.primary : theme.toolbar.border, background: currentAnswer.selectedIndex === -1 ? theme.accent.primarySoft : theme.spatial.surface, "--tw-ring-color": theme.accent.primary } as CSSProperties}>
                    <span className="grid size-6 shrink-0 place-items-center rounded-sm text-xs font-semibold tabular-nums" style={{ background: currentAnswer.selectedIndex === -1 ? theme.accent.primary : theme.node.fill, color: currentAnswer.selectedIndex === -1 ? theme.spatial.surface : theme.node.muted }}>{(currentStep?.suggestions.length || 0) + 1}</span>
                    <span className="shrink-0 text-sm">其它，请直接输入</span>
                    <input type="text" aria-label="其它，请直接输入" disabled={submitted} value={currentAnswer.other} onChange={(event) => updateCurrentAnswer({ selectedIndex: -1, other: event.target.value, skipped: false })} onFocus={() => { if (currentAnswer.selectedIndex !== -1) updateCurrentAnswer({ selectedIndex: -1, skipped: false }); }} placeholder="输入你的想法" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-55 focus:placeholder:opacity-0 disabled:cursor-not-allowed" style={{ color: theme.node.text }} />
                </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <Button className="!h-9" disabled={submitted || !onSelect} onClick={ignoreCurrentStep}>{submitted ? "已提交" : "忽略"}</Button>
                <Button type="primary" className="!h-9" disabled={!isAnswered || submitted || !onSelect || (currentStepIndex === steps.length - 1 && !allAnswered)} onClick={advance}>{submitted ? "已提交" : currentStepIndex === steps.length - 1 ? "提交" : "继续"}</Button>
            </div>
        </section>
    );
}

export function AgentWorkingMessage({ theme, label = "正在推演...", detail }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; label?: string; detail?: string }) {
    return (
        <div className="flex items-start gap-2.5 py-1" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" style={{ color: theme.node.muted }} />
            <div className="min-w-0">
                <div className="text-sm" style={{ color: theme.node.muted }}>{label}</div>
                {detail ? <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>{detail}</div> : null}
            </div>
        </div>
    );
}

export function AgentChatComposer({
    prompt,
    attachments = [],
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onAddFiles,
    onRemoveAttachment,
    left,
    right,
    allowWhileSending = false,
    inputRef,
}: {
    prompt: string;
    attachments?: CanvasAgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    left?: ReactNode;
    right?: ReactNode;
    allowWhileSending?: boolean;
    inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const internalInputRef = useRef<HTMLTextAreaElement>(null);
    const promptInputRef = inputRef || internalInputRef;
    const hasDraft = Boolean(prompt.trim() || attachments.length);
    const canSubmit = !disabled && hasDraft;
    const inputDisabled = Boolean(disabled || (sending && !allowWhileSending));
    const handleSubmit = () => {
        if (!hasDraft || !canSubmit) return;
        void onSubmit();
    };

    useLayoutEffect(() => {
        const input = promptInputRef.current;
        if (!input) return;
        input.style.height = "0px";
        const styles = window.getComputedStyle(input);
        const minHeight = Number.parseFloat(styles.minHeight) || 112;
        const maxHeight = Number.parseFloat(styles.maxHeight) || 224;
        const contentHeight = input.scrollHeight;
        input.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
        input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    }, [prompt]);

    return (
        <div className="canvas-agent-composer-wrap px-4 pb-4 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="canvas-agent-composer rounded-[20px] border px-4 pb-3 pt-3 transition-[border-color,box-shadow] duration-150 focus-within:border-current" style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.accent.primary, boxShadow: `0 10px 30px ${theme.spatial.shadow}` }}>
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative size-14 shrink-0 overflow-hidden rounded-md" title={item.name}>
                                <img src={item.url} alt={item.name} className="size-full object-cover" />
                                {onRemoveAttachment ? (
                                    <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label="移除图片">
                                        <X className="size-3" />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                <textarea
                    ref={promptInputRef}
                    value={prompt}
                    disabled={inputDisabled}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onPaste={(event) => {
                        if (!onAddFiles) return;
                        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                        if (!images.length) return;
                        event.preventDefault();
                        void onAddFiles(images);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
                        event.preventDefault();
                        handleSubmit();
                    }}
                    className="canvas-agent-chat-input thin-scrollbar w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:opacity-45"
                    style={{ color: theme.node.text }}
                    placeholder={placeholder}
                />
                <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        {onAddFiles ? (
                            <>
                                <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => {
                                    void onAddFiles(event.target.files);
                                    event.target.value = "";
                                }} />
                                <Tooltip title="上传素材">
                                    <button type="button" className="canvas-agent-composer-tool" disabled={inputDisabled} style={{ color: theme.node.muted }} onClick={() => fileInputRef.current?.click()} aria-label="上传素材">
                                        <ImagePlus className="size-[17px]" />
                                        <span>上传</span>
                                    </button>
                                </Tooltip>
                            </>
                        ) : null}
                        <button type="button" className="canvas-agent-composer-tool" disabled={inputDisabled} style={{ color: theme.node.muted }} aria-label="添加画布引用">
                            <Plus className="size-[17px]" />
                            <span>选择</span>
                        </button>
                        {left}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {right}
                        <Button type="primary" className="canvas-agent-send !h-10 !w-10 !min-w-10 !rounded-full !p-0" disabled={!canSubmit} icon={sending && hasDraft ? <ArrowUp className="size-[18px]" /> : sending ? <LoaderCircle className="size-[18px] animate-spin" /> : <ArrowUp className="size-[18px]" />} onClick={handleSubmit} aria-label={sending && hasDraft ? "插话并发送" : sending ? "正在处理" : "发送"} />
                    </div>
                </div>
            </div>
        </div>
    );
}

export function AgentPanelTabs<T extends string>({ value, items, theme, right, onChange }: { value: T; items: { value: T; label: string; icon?: ReactNode; count?: number }[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; right?: ReactNode; onChange: (value: T) => void }) {
    return (
        <div className="shrink-0 px-3 pb-2">
            <div className="flex min-h-9 items-center justify-between gap-2 rounded-md p-1" style={{ background: theme.spatial.surface }}>
                <nav className="grid min-w-0 flex-1 grid-flow-col auto-cols-fr items-center gap-0.5 text-xs" role="tablist" aria-label="Agent 面板">
                    {items.map((item) => (
                        <button key={item.value} type="button" role="tab" aria-selected={value === item.value} className={`inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-[var(--r-sm)] px-1.5 transition-colors ${value === item.value ? "font-medium" : "font-normal"}`} style={{ background: value === item.value ? theme.node.fill : "transparent", color: value === item.value ? theme.node.text : theme.node.muted, boxShadow: value === item.value ? `0 1px 5px ${theme.spatial.shadow}` : "none" }} onClick={() => onChange(item.value)}>
                            <span className="shrink-0">{item.icon}</span>
                            <span className="min-w-0 truncate">{item.label}</span>
                            {item.count ? <span className="shrink-0 tabular-nums opacity-60">{item.count}</span> : null}
                        </button>
                    ))}
                </nav>
                {right ? <div className="flex shrink-0 items-center gap-1">{right}</div> : null}
            </div>
        </div>
    );
}

export function AgentAvatar({ theme, className = "size-7" }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; className?: string }) {
    return (
        <span className={`block shrink-0 overflow-hidden rounded-md ${className}`} style={{ background: theme.spatial.surface, border: `1px solid ${theme.node.stroke}`, boxShadow: `0 4px 14px ${theme.spatial.shadow}` }} role="img" aria-label="Lalor Agent">
            <img src="/images/lalor-agent-avatar.png" alt="" className="size-full object-cover" style={{ objectPosition: "center 32%" }} />
        </span>
    );
}

function AgentUserAvatar({ user, theme }: { user: LocalUser | null; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    if (user) return <WorkspaceUserAvatar user={user} className="size-7" showProvider={false} />;
    return (
        <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full" style={{ color: theme.node.text }}>
            <UserRound className="size-4" />
        </span>
    );
}

function AgentMessageAttachments({ attachments }: { attachments: CanvasAgentChatAttachment[] }) {
    return (
        <div className="mt-2 grid grid-cols-3 gap-1.5">
            {attachments.map((item) => (
                <img key={item.id} src={item.url} alt={item.name} className="aspect-square w-full rounded-lg object-cover" />
            ))}
        </div>
    );
}

/**
 * 成功的工具消息只是 Agent 的内部执行轨迹时不占用聊天空间；
 * 失败、审批、建议和可操作结果仍由卡片展示，避免把用户真正需要的反馈吞掉。
 */
function shouldHideCompletedToolCard(item: CanvasAgentChatMessage) {
    if (item.role !== "tool") return false;

    const status = String(objectField(item.detail, "status") || "").toLowerCase();

    // 建议按钮、参数选择和撤销反馈是用户可以继续操作或需要确认的结果。
    if (suggestionStepsFromDetail(item.detail).length > 0) return false;
    if (item.title === "已撤销 Agent 批次") return false;

    const state = toolCardState(item.title || "工具调用", item.text, item.detail);
    if (state.isError || state.label === "未生效" || state.label === "拒绝执行") return false;

    const title = (item.title || "").trim();
    const text = item.text || "";
    const tool = String(objectField(item.detail, "name") || objectField(item.detail, "tool") || "").trim().toLowerCase();
    const internalTitle = isInternalToolTitle(title);
    const internalTool = tool.startsWith("canvas_") || tool.startsWith("project_");
    const snapshotText = /当前画布有\s*\d+\s*个节点/.test(text);
    const successfulResult = hasSuccessfulToolResult(item.detail);
    const completed = COMPLETED_TOOL_STATUSES.has(status) || successfulResult || state.label === "执行完成" || state.label === "已批准执行";

    // 本地 Agent 的完成消息没有 status 字段，而是以“读取画布完成”等标题和 result 标记完成。
    // 只有确定是成功的内部工具轨迹才隐藏，避免吞掉业务失败和用户可操作结果。
    return completed && (internalTitle || internalTool || snapshotText);
}

function isInternalToolTitle(title: string) {
    const normalized = title.trim().replace(/^(调用工具：|工具完成：)/, "").replace(/(?:已)?(?:完成|成功)$/, "").trim();
    return INTERNAL_TOOL_TITLES.has(normalized) || /^(操作画布|工具调用|读取|导出快照|调用工具|工具完成)/.test(normalized);
}

function hasSuccessfulToolResult(detail: unknown) {
    const results = objectField(detail, "results");
    if (Array.isArray(results) && results.length > 0) return results.every((entry) => !hasFailedToolResult(objectField(entry, "result") ?? entry));
    const result = objectField(detail, "result");
    return result !== undefined && !hasFailedToolResult(result);
}

function hasFailedToolResult(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === "string") return /失败|错误|\b(?:failed|error)\b/i.test(value);
    if (typeof value !== "object") return false;
    if (objectField(value, "ok") === false) return true;
    const status = String(objectField(value, "status") || "").toLowerCase();
    if (["failed", "failure", "error", "rejected", "cancelled"].includes(status)) return true;
    const error = objectField(value, "error");
    return error !== undefined && error !== null && String(error).trim() !== "";
}

function toolCardState(title: string, text: string, detail?: unknown) {
    const raw = `${title} ${text} ${normalizeText(objectField(detail, "error"))}`;
    const lower = raw.toLowerCase();
    const tool = String(objectField(detail, "name") || objectField(detail, "tool") || "");
    if (objectField(detail, "status") === "noop" || /未生效|无需|没有找到|没有.*可|已存在/.test(raw)) return { label: "未生效", color: "#d97706", softBg: "rgba(217,119,6,.04)", icon: <CircleAlert className="size-4" />, isError: false };
    if (/拒绝|取消/.test(raw) || lower.includes("rejected")) return { label: "拒绝执行", color: "#dc2626", softBg: "rgba(220,38,38,.04)", icon: <XCircle className="size-4" />, isError: true };
    if (/失败|错误/.test(raw) || lower.includes("failed") || lower.includes("error")) return { label: "执行失败", color: "#dc2626", softBg: "rgba(220,38,38,.04)", icon: <XCircle className="size-4" />, isError: true };
    if (/完成|成功/.test(raw) || lower.includes("completed") || lower.includes("succeeded")) return { label: tool === "canvas_apply_ops" || /画布操作/.test(title) ? "已批准执行" : "执行完成", color: "#16a34a", softBg: "rgba(22,163,74,.04)", icon: <CheckCircle2 className="size-4" />, isError: false };
    return { label: "工具调用", color: "#2563eb", softBg: "rgba(37,99,235,.04)", icon: <Wrench className="size-4" />, isError: false };
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function suggestionStepsFromDetail(detail: unknown): AgentSuggestionStep[] {
    const value = objectField(detail, "steps");
    if (Array.isArray(value)) {
        return value.flatMap((item) => {
            const question = stringField(item, "question");
            const rawSuggestions = objectField(item, "suggestions");
            if (!question || !Array.isArray(rawSuggestions)) return [];
            const suggestions = rawSuggestions.filter((option): option is string => typeof option === "string" && Boolean(option.trim())).slice(0, 4);
            return suggestions.length >= 2 ? [{ question, suggestions }] : [];
        }).slice(0, 4);
    }
    const legacy = objectField(detail, "suggestions");
    if (Array.isArray(legacy)) {
        const suggestions = legacy.filter((option): option is string => typeof option === "string" && Boolean(option.trim())).slice(0, 4);
        if (suggestions.length >= 2) return [{ question: stringField(detail, "question") || "你希望从哪个创作方向继续？", suggestions }];
    }
    const data = objectField(detail, "data");
    if (data) return suggestionStepsFromDetail(data);
    const results = objectField(detail, "results");
    if (!Array.isArray(results)) return [];
    return results.flatMap((item) => suggestionStepsFromDetail(objectField(item, "result"))).slice(0, 4);
}

function generationChoicesFromDetail(detail: unknown): { defaultModel: string; defaultRatio: string; models: GenerationChoiceModel[] } {
    const value = objectField(detail, "models");
    const models = Array.isArray(value)
        ? value.flatMap((item) => {
              const record = objectField(item, "ratios");
              const model = objectField(item, "value");
              const label = objectField(item, "label");
              if (typeof model !== "string" || !model) return [];
              return [{
                  value: model,
                  label: typeof label === "string" && label ? label : model,
                  ratios: Array.isArray(record) ? record.filter((ratio): ratio is string => typeof ratio === "string" && Boolean(ratio)) : [],
                  qualities: stringArrayField(item, "qualities"),
                  seconds: stringArrayField(item, "seconds"),
                  resolutions: stringArrayField(item, "resolutions"),
                  generateAudioOptions: stringArrayField(item, "generateAudioOptions"),
                  watermarkOptions: stringArrayField(item, "watermarkOptions"),
                  endings: stringArrayField(item, "endings"),
                  audioFormats: stringArrayField(item, "audioFormats"),
                  audioSpeeds: stringArrayField(item, "audioSpeeds"),
                  defaultQuality: stringField(item, "defaultQuality"),
                  defaultSeconds: stringField(item, "defaultSeconds"),
                  defaultVquality: stringField(item, "defaultVquality"),
                  defaultGenerateAudio: stringField(item, "defaultGenerateAudio"),
                  defaultWatermark: stringField(item, "defaultWatermark"),
                  defaultEnding: stringField(item, "defaultEnding"),
                  defaultAudioFormat: stringField(item, "defaultAudioFormat"),
                  defaultAudioSpeed: stringField(item, "defaultAudioSpeed"),
              }];
          })
        : [];
    return {
        defaultModel: typeof objectField(detail, "defaultModel") === "string" ? String(objectField(detail, "defaultModel")) : "",
        defaultRatio: typeof objectField(detail, "defaultRatio") === "string" ? String(objectField(detail, "defaultRatio")) : "",
        models,
    };
}

type GenerationChoiceModel = {
    value: string;
    label: string;
    ratios: string[];
    qualities: string[];
    seconds: string[];
    resolutions: string[];
    generateAudioOptions: string[];
    watermarkOptions: string[];
    endings: string[];
    audioFormats: string[];
    audioSpeeds: string[];
    defaultQuality?: string;
    defaultSeconds?: string;
    defaultVquality?: string;
    defaultGenerateAudio?: string;
    defaultWatermark?: string;
    defaultEnding?: string;
    defaultAudioFormat?: string;
    defaultAudioSpeed?: string;
};

function stringField(value: unknown, key: string) {
    const field = objectField(value, key);
    return typeof field === "string" && field ? field : undefined;
}

function stringArrayField(value: unknown, key: string) {
    const field = objectField(value, key);
    return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}
