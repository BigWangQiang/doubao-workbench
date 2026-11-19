import type { StoryboardRow } from "@/types/canvas";

export type StoryboardPromptKind = "image" | "video";

export function composeStoryboardPrompt(row: StoryboardRow, kind: StoryboardPromptKind) {
    const segments = kind === "image"
        ? [
              segment("画面", row.plotDescription),
              segment("角色", (row.characters || []).map((character) => character.characterName).filter(Boolean).join("、")),
              segment("景别", row.shotSize),
              segment("镜头设计", row.camera),
              segment("表演调度", row.performanceBlocking),
              segment("情绪", row.emotion),
              segment("光影氛围", row.lightingAndAtmosphere),
              segment("必须包含", (row.mustHave || []).join("、")),
              segment("补充细节", (row.optionalDetails || []).join("、")),
              segment("连续性", row.continuityOut),
              segment("避免", row.negativePrompt),
          ]
        : [
              segment("画面", row.plotDescription),
              segment("角色", (row.characters || []).map((character) => character.characterName).filter(Boolean).join("、")),
              segment("动作", row.motion),
              segment("镜头设计", row.camera),
              segment("表演调度", row.performanceBlocking),
              segment("时间节拍", row.timeBeats),
              segment("情绪", row.emotion),
              segment("音效", row.audioEffects),
              segment("连续性", row.continuityOut),
              segment("避免", row.negativePrompt),
          ];
    return segments.filter(Boolean).join("\n");
}

export function editableStoryboardPrompt(row: StoryboardRow, kind: StoryboardPromptKind) {
    const current = kind === "image" ? row.imageGenerationPrompt : row.videoMotionPrompt;
    return current.trim() || composeStoryboardPrompt(row, kind);
}

export function storyboardRowReferenceText(row: StoryboardRow) {
    return [
        row.plotDescription,
        row.dialogue,
        (row.characters || []).map((character) => character.characterName).join(" "),
        row.narrativeIntent,
        row.performanceBlocking,
        row.emotion,
        row.lightingAndAtmosphere,
        row.camera,
        row.motion,
        row.timeBeats,
        row.imageGenerationPrompt,
        row.videoMotionPrompt,
        (row.mustHave || []).join(" "),
        (row.optionalDetails || []).join(" "),
        row.continuityOut,
    ].filter(Boolean).join("\n");
}

function segment(label: string, value: string) {
    const normalized = value.trim();
    return normalized ? `${label}：${normalized}` : "";
}
