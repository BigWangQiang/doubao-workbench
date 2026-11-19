export type ScreenplayMode = "original" | "adapt" | "rewrite";
export type ScreenplayAsset = { id: string; kind: "character" | "location" | "prop"; name: string; description: string; referenceNodeId?: string };
export type ScreenplayBeat = { id: string; kind: "action" | "dialogue"; characterId?: string; text: string; delivery?: string };
export type ScreenplayScene = { id: string; title: string; locationId?: string; timeOfDay: string; characterIds: string[]; beats: ScreenplayBeat[] };
export type ScreenplayEpisode = { id: string; title: string; synopsis: string; hook: string; cliffhanger: string; novelText?: string; scenesNeedAdaptation?: boolean; scenes: ScreenplayScene[] };
export type ScreenplayDocument = {
    version: 1; revision: number; title: string; mode: ScreenplayMode; brief: string; source: string;
    genre: string; audience: string; tone: string; episodeCount: number; targetSeconds: number;
    outline: string; assets: ScreenplayAsset[]; episodes: ScreenplayEpisode[];
};
export type ScreenplayGenerationAction = "outline" | "write_novel" | "rewrite_novel" | "adapt_episode" | "write_episode" | "rewrite_scene" | "continue_episode" | "storyboard";
export type ScreenplayTask = {
    requestId: string; action: ScreenplayGenerationAction; baseRevision: number; model: string;
    episodeId?: string; sceneId?: string; instruction: string; taskId?: string; replaceExistingScenes?: boolean;
    status: "submitting" | "unknown" | "running" | "succeeded" | "failed" | "cancelled" | "conflict" | "invalid";
    progress?: number; error?: string; resultText?: string;
    baseDocument?: ScreenplayDocument;
};
export type ScreenplayWorkflow = {
    version: 1; document: ScreenplayDocument; approvedRevision?: number;
    history: { id: string; label: string; createdAt: string; document: ScreenplayDocument }[];
    task?: ScreenplayTask;
};
export type ScreenplayProvenance = { nodeId: string; revision: number; episodeId?: string; assetId?: string; stale?: boolean };
export type ScreenplayGenerationRequest = { action: ScreenplayGenerationAction; episodeId?: string; sceneId?: string; instruction?: string; model?: string; replaceExistingScenes?: boolean };
export type ScreenplayAgentRequest = {
    action: "create" | "read" | "open" | "save_novel" | "save_scene" | "bind_asset" | "approve" | "extract_assets" | ScreenplayGenerationAction;
    nodeId?: string; revision?: number; title?: string; brief?: string; mode?: ScreenplayMode;
    episodeCount?: number; targetSeconds?: number; episodeId?: string; sceneId?: string;
    instruction?: string; model?: string; scene?: ScreenplayScene; novelText?: string; replaceExistingScenes?: boolean;
    source?: string; genre?: string; audience?: string; tone?: string;
    assetId?: string; referenceNodeId?: string;
};
