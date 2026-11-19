import type { CanvasNodeData } from "@/types/canvas";

export type StoryboardGenerationContext = {
    projectStyle: {
        presetId: string;
        title: string;
        prompt: string;
        profileJson?: string;
    };
    characters: Array<{
        assetId: string;
        versionId: string;
        name: string;
        definition: Record<string, unknown>;
    }>;
};

const AUTOMATIC_STORYBOARD_STYLE = {
    presetId: "agent-auto",
    title: "Agent 自动视觉",
    prompt: "根据用户故事、题材和参考素材自动选择合适的视觉媒介、光线、色彩与画面质感，并在所有镜头中保持人物、场景和视觉语言一致。",
} as const;

// 分镜的两条入口共用同一上下文解析；项目画风可选，角色版本仍必须完整。
export function resolveStoryboardGenerationContext(nodes: CanvasNodeData[]): StoryboardGenerationContext {
    const styleNode = nodes.find((node) => node.metadata?.workflowKind === "styleboard");
    const stylePrompt = String(styleNode?.metadata?.content || styleNode?.metadata?.prompt || "").trim();
    const stylePresetId = String(styleNode?.metadata?.stylePresetId || "").trim();
    const hasConfiguredStyle = Boolean(stylePrompt);

    const characterNodes = nodes.filter((node) => node.metadata?.workflowKind === "character");
    const invalidCharacter = characterNodes.find((node) => !node.metadata?.characterAssetId?.trim() || !node.metadata?.characterVersionId?.trim() || !(node.metadata?.characterName || node.title).trim());
    if (invalidCharacter) throw new Error(`角色卡“${invalidCharacter.metadata?.characterName || invalidCharacter.title || "未命名角色"}”版本未同步，请刷新角色资产后再生成分镜`);

    return {
        projectStyle: hasConfiguredStyle
            ? {
                presetId: stylePresetId || "agent-auto",
                title: styleNode?.title?.replace(/^(?:项目)?画风\s*[·：:]?\s*/, "").trim() || "Agent 自动视觉",
                prompt: stylePrompt,
                profileJson: styleNode?.metadata?.styleProfileJson,
            }
            : AUTOMATIC_STORYBOARD_STYLE,
        characters: characterNodes.map((node) => ({
            assetId: node.metadata!.characterAssetId!.trim(),
            versionId: node.metadata!.characterVersionId!.trim(),
            name: (node.metadata?.characterName || node.title).trim(),
            definition: node.metadata?.characterDefinition || { prompt: node.metadata?.characterPrompt || "" },
        })),
    };
}
