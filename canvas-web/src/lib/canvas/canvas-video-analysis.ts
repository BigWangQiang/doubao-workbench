import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { layoutViralVideoAssets } from "@/lib/canvas/canvas-viral-video-layout";
import { formatVideoFrameTime } from "@/lib/canvas/canvas-video-frame-analysis";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardColumn } from "@/types/canvas";
import type { VideoAnalysisResult, VideoAnalysisWorkflow } from "@/types/canvas-video-analysis";

export const VIDEO_ANALYSIS_DIMENSIONS = [
    { value: "storyboard", label: "分镜" },
    { value: "motion", label: "动态" },
    { value: "music", label: "音乐" },
] as const;

export function videoAnalysisBusy(workflow: VideoAnalysisWorkflow) {
    return ["preparing", "submitting", "recovering", "analyzing"].includes(workflow.stage);
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分析结果结构不完整");
    return value as Record<string, unknown>;
}

function text(value: unknown, required = false) {
    if (typeof value !== "string" || value.length > 16000 || (required && !value.trim())) throw new Error("分析结果缺少必要描述");
    return value.trim();
}

// 不把不完整 JSON、越界时间或无法听到的音轨包装成已完成分析。
export function parseVideoAnalysis(raw: string, workflow: VideoAnalysisWorkflow): VideoAnalysisResult {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new Error("模型未返回完整结构化结果，请在任务中心查看原结果后重试"); }
    const root = record(parsed);
    const withShots = workflow.dimensions.some((dimension) => dimension !== "music");
    const withMotion = workflow.dimensions.includes("motion");
    const withStoryboard = workflow.dimensions.includes("storyboard");
    if (!Array.isArray(root.shots) || root.shots.length > 60 || (withShots && !root.shots.length)) throw new Error("分镜清单不完整或超过六十个镜头");
    let previousEnd = 0;
    const shots = withShots ? root.shots.map((value, index) => {
        const shot = record(value);
        const { startSeconds, endSeconds, frameIndex } = shot;
        if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || typeof endSeconds !== "number" || !Number.isFinite(endSeconds)
            || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > (workflow.durationSeconds || 0) + 0.1
            || Math.abs(startSeconds - previousEnd) > 0.1) throw new Error(`第 ${index + 1} 镜时间不连续或超出原视频`);
        if (typeof frameIndex !== "number" || !Number.isInteger(frameIndex) || !workflow.frames[frameIndex]) throw new Error(`第 ${index + 1} 镜引用的画面不存在`);
        previousEnd = endSeconds;
        return {
            startSeconds, endSeconds, frameIndex, description: text(shot.description, true),
            camera: withMotion ? text(shot.camera) : "", motion: withMotion ? text(shot.motion) : "",
            dialogue: workflow.inputMode === "video" ? text(shot.dialogue) : "",
            sound: workflow.inputMode === "video" && workflow.dimensions.includes("music") ? text(shot.sound) : "",
            imagePrompt: withStoryboard ? text(shot.imagePrompt, true) : "", videoPrompt: withMotion ? text(shot.videoPrompt, true) : "",
        };
    }) : [];
    if (withShots && Math.abs(previousEnd - (workflow.durationSeconds || 0)) > 0.1) throw new Error("分镜没有覆盖完整视频");
    const music = record(root.music);
    const musicRequested = workflow.inputMode === "video" && workflow.dimensions.includes("music");
    if (musicRequested && music.status !== "analyzed" && music.status !== "unavailable") throw new Error("音乐分析缺少可用性说明");
    if (!Array.isArray(root.limitations) || root.limitations.length > 20) throw new Error("分析依据说明不完整");
    const limitations = root.limitations.map((item) => text(item, true));
    if (workflow.inputMode === "frames") limitations.unshift("本次依据采样画面分析，镜头边界和动作是估计值，未分析音轨或对白。");
    return {
        summary: text(root.summary, true), globalPrompt: text(root.globalPrompt, true),
        motionSummary: withMotion ? text(root.motionSummary, true) : "",
        music: musicRequested ? { status: music.status as "analyzed" | "unavailable", description: text(music.description, true) } : { status: "not_requested", description: "本次未分析音乐" },
        limitations, shots,
    };
}

export function videoAnalysisDocument(workflow: VideoAnalysisWorkflow) {
    const result = workflow.result;
    if (!result) throw new Error("拉片结果尚未就绪");
    const lines = ["# 视频拉片分析", "", result.summary, "", "## 整片提示词", result.globalPrompt];
    if (result.motionSummary) lines.push("", "## 运镜与动态", result.motionSummary);
    if (result.music.status !== "not_requested") lines.push("", result.music.status === "analyzed" ? "## 音频与配乐" : "## 音频未能分析", result.music.description);
    result.shots.forEach((shot, index) => {
        lines.push("", `## 镜头 ${index + 1} · ${formatVideoFrameTime(shot.startSeconds)} — ${formatVideoFrameTime(shot.endSeconds)}`, shot.description);
        if (shot.camera) lines.push(`运镜：${shot.camera}`);
        if (shot.motion) lines.push(`动作：${shot.motion}`);
        if (shot.dialogue) lines.push(`对白：${shot.dialogue}`);
        if (shot.sound) lines.push(`声音：${shot.sound}`);
        if (shot.imagePrompt) lines.push(`画面提示词：${shot.imagePrompt}`);
        if (shot.videoPrompt) lines.push(`动态提示词：${shot.videoPrompt}`);
    });
    if (result.limitations.length) lines.push("", "## 分析依据与限制", ...result.limitations.map((item) => `- ${item}`));
    return lines.join("\n");
}

export function createVideoAnalysisArtifacts(owner: CanvasNodeData, workflow: VideoAnalysisWorkflow, obstacles: CanvasNodeData[]) {
    if (!workflow.result) throw new Error("尚无可创建的拉片结果");
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    const withStoryboard = workflow.dimensions.includes("storyboard");
    const position = findAvailableGenerationGroupPosition(obstacles, { x: owner.position.x + owner.width + 96, y: owner.position.y }, {
        width: withStoryboard ? NODE_DEFAULT_SIZE[CanvasNodeType.Script].width : 480,
        height: withStoryboard ? 400 + NODE_DEFAULT_SIZE[CanvasNodeType.Script].height : 320,
    });
    const document = createCanvasNode(CanvasNodeType.Text, position, { content: videoAnalysisDocument(workflow) });
    Object.assign(document, { title: "拉片分析 · 整片提示词", position, width: 480, height: 320 });
    nodes.push(document);
    connections.push({ id: nanoid(), fromNodeId: owner.id, toNodeId: document.id });
    let storyboardNodeId: string | undefined;
    if (workflow.dimensions.includes("storyboard")) {
        const images = workflow.result.shots.map((shot, index) => {
            const frame = workflow.frames[shot.frameIndex];
            const image = createCanvasNode(CanvasNodeType.Image, owner.position, {
                storageKey: frame.storageKey, content: resourceFileUrl(resourceIdFromStorageKey(frame.storageKey)), naturalWidth: frame.width, naturalHeight: frame.height,
                mimeType: "image/jpeg", status: "success", prompt: shot.imagePrompt,
            });
            image.title = `镜头 ${index + 1} · 参考帧 ${formatVideoFrameTime(frame.timeSeconds)}`;
            Object.assign(image, fitNodeSize(frame.width, frame.height, 320, 280));
            return image;
        });
        const rows = workflow.result.shots.map((shot, index) => createStoryboardRow(index + 1, {
            durationSeconds: Number((shot.endSeconds - shot.startSeconds).toFixed(3)), plotDescription: shot.description,
            camera: shot.camera, motion: shot.motion, dialogue: shot.dialogue, audioEffects: shot.sound,
            imageGenerationPrompt: shot.imagePrompt, videoMotionPrompt: shot.videoPrompt,
            timeBeats: `${formatVideoFrameTime(shot.startSeconds)} — ${formatVideoFrameTime(shot.endSeconds)}`,
            referenceNodeIds: [images[index].id], status: "idle",
        }));
        const visibleColumns: StoryboardColumn[] = ["shotNumber", "durationSeconds", "plotDescription", "imageGenerationPrompt"];
        if (workflow.dimensions.includes("motion")) visibleColumns.push("camera", "motion", "videoMotionPrompt");
        if (workflow.dimensions.includes("music")) visibleColumns.push("dialogue", "audioEffects");
        const script = createCanvasNode(CanvasNodeType.Script, position, {
            workflowKind: "storyboard", storyboardVideoInputMode: "keyframe",
            storyboard: { rows, visibleColumns, referenceNodeIds: [] },
        });
        script.title = "拉片分镜表";
        script.position = { x: position.x, y: position.y + document.height + 80 };
        const firstFrame = workflow.frames[0];
        script.metadata = { ...script.metadata, size: firstFrame.width < firstFrame.height ? "9:16" : firstFrame.width === firstFrame.height ? "1:1" : "16:9" };
        nodes.push(script);
        const layout = layoutViralVideoAssets(script, images, [...obstacles, ...nodes]);
        images.forEach((image) => { image.position = layout.positions.get(image.id)!; });
        nodes.push(...images);
        connections.push({ id: nanoid(), fromNodeId: owner.id, toNodeId: script.id });
        rows.forEach((row) => connections.push({ id: nanoid(), fromNodeId: row.referenceNodeIds[0], toNodeId: script.id, toHandleId: `row:${row.id}` }));
        storyboardNodeId = script.id;
    }
    return { nodes, connections, documentNodeId: document.id, storyboardNodeId };
}
