import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { VIRAL_VIDEO_ANALYSIS_MODEL_LABEL } from "@/lib/canvas/canvas-viral-video-policy";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { ViralVideoAnalysis, ViralVideoAsset, ViralVideoWorkflow } from "@/types/canvas-viral-video";

export const VIRAL_VIDEO_SKILL_ID = "viral-video-structure";
const ASSET_KINDS = new Set(["character", "product", "scene", "prop", "style"]);

export function viralVideoAnalysisErrorMessage(error: string) {
    if (/\b(?:unexpected\s+)?EOF\b/i.test(error)) {
        return `上游分析服务连接意外断开（EOF），未取得完整分析结果。请联系管理员检查 ${VIRAL_VIDEO_ANALYSIS_MODEL_LABEL} 渠道状态及图片理解能力；重新分析会提交新任务。`;
    }
    if (/doesn['’]?t support image input|image input (?:is )?not supported/i.test(error)) {
        return `固定的 ${VIRAL_VIDEO_ANALYSIS_MODEL_LABEL} 渠道当前不支持图片输入，请联系管理员检查模型映射及图片理解能力后重试。`;
    }
    return error;
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式错误`);
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string, required = false) {
    if (typeof value !== "string" || value.length > 16000 || (required && !value.trim())) throw new Error(`${label}为空或格式错误`);
    return value.trim();
}

function number(value: unknown, label: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}必须是有效数字`);
    return value;
}

function strings(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || value.length > 100) throw new Error(`${label}必须是文本列表`);
    return value.map((item) => text(item, label, true));
}

// 只接受完整合同，解析失败保留任务凭证，禁止把半份结果静默当作可生成分镜。
export function parseViralVideoAnalysis(raw: string, duration: number, frameCount: number): ViralVideoAnalysis {
    const root = record(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")), "分析结果");
    if (!Array.isArray(root.assets) || root.assets.length > 24) throw new Error("资产清单格式错误或超过 24 项");
    const assetIds = new Set<string>();
    const assets: ViralVideoAsset[] = root.assets.map((item) => {
        const asset = record(item, "资产");
        const id = text(asset.id, "资产标识", true);
        const kind = text(asset.kind, "资产类型", true);
        const frameIndex = number(asset.frameIndex, "证据帧编号");
        if (!/^asset_[a-z0-9_]{1,48}$/.test(id) || assetIds.has(id) || !ASSET_KINDS.has(kind)) throw new Error("资产标识重复或类型无效");
        if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) throw new Error("资产引用了不存在的证据帧");
        assetIds.add(id);
        return { id, kind: kind as ViralVideoAsset["kind"], name: text(asset.name, "资产名称", true), description: text(asset.description, "资产描述", true), frameIndex };
    });
    if (!Array.isArray(root.shots) || !root.shots.length || root.shots.length > 80) throw new Error("分镜必须为 1 到 80 个");
    let previousEnd = 0;
    const shots = root.shots.map((item, index) => {
        const shot = record(item, `镜头 ${index + 1}`);
        const startSeconds = number(shot.startSeconds, "起始时间");
        const endSeconds = number(shot.endSeconds, "结束时间");
        if (startSeconds < 0 || endSeconds <= startSeconds || endSeconds > duration + 0.05 || Math.abs(startSeconds - previousEnd) > 0.05) throw new Error(`镜头 ${index + 1} 的时间范围不连续或超出视频`);
        previousEnd = endSeconds;
        const refs = strings(shot.assetIds, "镜头资产引用");
        if (refs.some((id) => !assetIds.has(id))) throw new Error(`镜头 ${index + 1} 引用了不存在的资产`);
        const imagePrompt = text(shot.imagePrompt, "首帧提示词", true);
        const videoPrompt = text(shot.videoPrompt, "动态提示词", true);
        if (refs.some((id) => !imagePrompt.includes(`{{${id}}}`) || !videoPrompt.includes(`{{${id}}}`))) throw new Error(`镜头 ${index + 1} 缺少可替换资产占位符`);
        const confidence = text(shot.confidence, "置信度");
        if (!["high", "medium", "low"].includes(confidence)) throw new Error("镜头置信度无效");
        return {
            id: `viral-shot-${index + 1}`, startSeconds, endSeconds, assetIds: [...new Set(refs)],
            evidence: text(shot.evidence, "画面证据", true), confidence: confidence as "high" | "medium" | "low",
            description: text(shot.description, "画面描述", true), dialogue: text(shot.dialogue, "对白"),
            camera: text(shot.camera, "镜头语言"), motion: text(shot.motion, "动作"), imagePrompt, videoPrompt,
            negativePrompt: text(shot.negativePrompt, "负面提示词"),
        };
    });
    if (Math.abs(previousEnd - duration) > 0.05) throw new Error("分镜尚未覆盖整段视频，请重新分析");
    const globalPrompt = text(root.globalPrompt, "整片提示词", true);
    const allText = [globalPrompt, ...shots.flatMap((shot) => [shot.description, shot.dialogue, shot.camera, shot.motion, shot.imagePrompt, shot.videoPrompt, shot.negativePrompt])].join("\n");
    for (const match of allText.matchAll(/\{\{([^{}]+)\}\}/g)) {
        if (!assetIds.has(match[1])) throw new Error(`提示词含未知资产：${match[1]}`);
    }
    return { summary: text(root.summary, "视频摘要", true), hook: text(root.hook, "开场钩子", true), globalPrompt, limitations: strings(root.limitations, "分析限制"), assets, shots };
}

export function resolveViralAssetText(template: string, workflow: ViralVideoWorkflow, nodes: CanvasNodeData[]) {
    return template.replace(/\{\{([^{}]+)\}\}/g, (_, id: string) => {
        const asset = workflow.analysis?.assets.find((item) => item.id === id);
        if (!asset) throw new Error(`提示词引用了未知资产：${id}`);
        const replacementId = workflow.bindings[id];
        if (!replacementId) return `${asset.name}（${asset.description}）`;
        const replacement = nodes.find((node) => node.id === replacementId && node.type === CanvasNodeType.Image);
        if (!replacement?.metadata?.content && !replacement?.metadata?.storageKey) throw new Error(`替换资产「${asset.name}」已失效，请重新选择`);
        // 替换后不拼回原人物外观，避免新图与旧描述互相冲突。
        return `${replacement.title || "用户资产"}（以同名参考图为外观依据）`;
    });
}

export function viralVideoStoryboardRows(workflow: ViralVideoWorkflow, nodes: CanvasNodeData[]): StoryboardRow[] {
    if (!workflow.analysis) return [];
    return workflow.analysis.shots.map((shot, index) => {
        const resolve = (value: string) => resolveViralAssetText(value, workflow, nodes);
        const globalTemplate = workflow.promptOverride ?? workflow.analysis!.globalPrompt;
        const assetIds = [...new Set([...shot.assetIds, ...workflow.analysis!.assets.filter((asset) => globalTemplate.includes(`{{${asset.id}}}`)).map((asset) => asset.id)])];
        const referenceNodeIds = [...new Set(assetIds.map((id) => workflow.bindings[id] || workflow.assetNodeIds[id]).filter(Boolean))];
        if (referenceNodeIds.some((id) => !nodes.some((node) => node.id === id))) throw new Error("参考资产节点已删除，请恢复资产或重新分析");
        const identity = assetIds.map((id) => resolve(`{{${id}}}`)).join("；");
        const global = resolve(globalTemplate);
        return createStoryboardRow(index + 1, {
            id: shot.id, durationSeconds: Number((shot.endSeconds - shot.startSeconds).toFixed(3)),
            plotDescription: resolve(shot.description), dialogue: resolve(shot.dialogue), camera: resolve(shot.camera), motion: resolve(shot.motion),
            timeBeats: `${shot.startSeconds.toFixed(2)}–${shot.endSeconds.toFixed(2)}s`,
            imageGenerationPrompt: `${global}\n${resolve(shot.imagePrompt)}${identity ? `\n本镜资产：${identity}` : ""}`,
            videoMotionPrompt: `${global}\n${resolve(shot.videoPrompt)}${identity ? `\n本镜资产：${identity}` : ""}`,
            negativePrompt: resolve(shot.negativePrompt), referenceNodeIds,
            mustHave: [shot.evidence], optionalDetails: [`时间边界为抽样估计；置信度：${shot.confidence}`],
        });
    });
}

export function viralVideoPromptDocument(workflow: ViralVideoWorkflow, rows: StoryboardRow[], nodes: CanvasNodeData[]) {
    const analysis = workflow.analysis;
    if (!analysis) return "";
    return ["整片复刻提示词", resolveViralAssetText(workflow.promptOverride ?? analysis.globalPrompt, workflow, nodes), "", `开场钩子：${analysis.hook}`, "",
        ...rows.flatMap((row) => [`镜头 ${row.shotNumber} · ${row.timeBeats}`, row.videoMotionPrompt, row.negativePrompt ? `避免：${row.negativePrompt}` : "", ""]),
        "分析范围：基于带时间码的抽样画面；镜头边界为估计；未分析音轨。反推结果为可生成的近似描述。", ...analysis.limitations,
    ].join("\n");
}

export function updateViralVideoGlobalPrompt(workflow: ViralVideoWorkflow, prompt: string, rows: StoryboardRow[], nodes: CanvasNodeData[]) {
    if (!workflow.analysis || !prompt.trim()) throw new Error("整片提示词不能为空");
    const next = { ...workflow, promptOverride: prompt.trim() };
    const before = resolveViralAssetText(workflow.promptOverride ?? workflow.analysis.globalPrompt, workflow, nodes);
    const after = resolveViralAssetText(next.promptOverride, next, nodes);
    const withGlobal = (value: string) => before === after ? value : value.startsWith(`${before}\n`) ? `${after}\n${value.slice(before.length + 1)}` : `${after}\n${value}`;
    const references = viralVideoStoryboardRows(next, nodes);
    return { workflow: next, rows: rows.map((row) => ({ ...row, imageGenerationPrompt: withGlobal(row.imageGenerationPrompt), videoMotionPrompt: withGlobal(row.videoMotionPrompt), referenceNodeIds: references.find((item) => item.id === row.id)?.referenceNodeIds || row.referenceNodeIds })) };
}
