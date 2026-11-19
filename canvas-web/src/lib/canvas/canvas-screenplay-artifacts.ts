import { nanoid } from "nanoid";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { parseScreenplayJson } from "@/lib/canvas/canvas-screenplay";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { ScreenplayTask } from "@/types/canvas-screenplay";

function requiredText(value: unknown, label: string, limit = 12000) {
    if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${label}为空或超出长度限制`);
    return value;
}
export function screenplayStoryboard(owner: CanvasNodeData, task: ScreenplayTask, raw: string, nodes: CanvasNodeData[]) {
    const document = owner.metadata!.screenplay!.document;
    const episode = document.episodes.find((item) => item.id === task.episodeId);
    const result = parseScreenplayJson(raw);
    if (!episode || !Array.isArray(result.shots) || !result.shots.length || result.shots.length > 150) throw new Error("分镜须包含 1–150 个镜头");
    const seenScenes = new Set<string>();
    const rows: StoryboardRow[] = result.shots.map((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("镜头格式错误");
        const shot = value as Record<string, unknown>;
        const sceneId = requiredText(shot.sceneId, "来源场次ID", 100);
        const scene = episode.scenes.find((item) => item.id === sceneId);
        if (!scene) throw new Error("镜头引用了本集之外的场次");
        seenScenes.add(sceneId);
        const duration = Number(shot.durationSeconds);
        if (!Number.isFinite(duration) || duration < 0.5 || duration > 30) throw new Error("单镜时长须为 0.5–30 秒");
        const ids = (key: string) => {
            const value = shot[key];
            if (!Array.isArray(value) || value.some((id) => typeof id !== "string") || value.length > 100) throw new Error(`${key}须为真实ID数组`);
            return value as string[];
        };
        const characterIds = ids("characterIds"), assetIds = ids("assetIds");
        if (characterIds.some((id) => !scene.characterIds.includes(id)) || assetIds.some((id) => !document.assets.some((asset) => asset.id === id))) throw new Error("镜头引用了未定义的资产或未出场的人物");
        const assets = document.assets.filter((asset) => new Set([...characterIds, ...assetIds, scene.locationId]).has(asset.id));
        const referenceNodeIds = assets.flatMap((asset) => asset.referenceNodeId && nodes.some((node) => node.id === asset.referenceNodeId) ? [asset.referenceNodeId] : []);
        if (assets.some((asset) => asset.referenceNodeId && !nodes.some((node) => node.id === asset.referenceNodeId))) throw new Error("绑定的资产节点已删除，请重新绑定");
        return { ...createStoryboardRow(index), id: nanoid(), shotNumber: index + 1, durationSeconds: duration,
            plotDescription: requiredText(shot.plotDescription, "镜头画面"), dialogue: typeof shot.dialogue === "string" ? shot.dialogue : "",
            characters: assets.filter((asset) => asset.kind === "character").map((asset) => {
                const bound = nodes.find((node) => node.id === asset.referenceNodeId);
                return { characterName: asset.name, characterDescription: asset.description, characterImageNodeId: bound?.type === CanvasNodeType.Image ? bound.id : undefined, characterAssetId: bound?.metadata?.characterAssetId, characterVersionId: bound?.metadata?.characterVersionId };
            }),
            imageGenerationPrompt: requiredText(shot.imageGenerationPrompt, "首帧提示词"), videoMotionPrompt: requiredText(shot.videoMotionPrompt, "动态提示词"),
            shotSize: String(shot.shotSize || ""), camera: String(shot.camera || ""), emotion: String(shot.emotion || ""), lightingAndAtmosphere: String(shot.lightingAndAtmosphere || ""), audioEffects: String(shot.audioEffects || ""), continuityOut: String(shot.continuityOut || ""),
            narrativeIntent: `${episode.title} / ${scene.title}`, timeBeats: `来源场次 ${sceneId}`, referenceNodeIds: [...new Set(referenceNodeIds)],
        };
    });
    if (episode.scenes.some((scene) => !seenScenes.has(scene.id))) throw new Error("分镜遗漏场次，已保留结果，请调整要求后重新拆镜");
    const right = Math.max(owner.position.x + owner.width, ...nodes.filter((node) => node.metadata?.screenplaySource?.nodeId === owner.id).map((node) => node.position.x + node.width));
    const node = createCanvasNode(CanvasNodeType.Script, { x: right + 420, y: owner.position.y + 160 }, {
        workflowKind: "storyboard", workflowTitle: "剧本分镜", screenplaySource: { nodeId: owner.id, revision: document.revision, episodeId: episode.id },
        storyboard: { rows, visibleColumns: ["shotNumber", "durationSeconds", "plotDescription", "dialogue", "imageGenerationPrompt", "videoMotionPrompt"], referenceNodeIds: [...new Set(rows.flatMap((row) => row.referenceNodeIds))] },
    });
    node.title = `${document.title} · ${episode.title}分镜`;
    return node;
}
