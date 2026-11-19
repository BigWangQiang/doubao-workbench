export type ViralVideoAsset = {
    id: string;
    kind: "character" | "product" | "scene" | "prop" | "style";
    name: string;
    description: string;
    frameIndex: number;
};

export type ViralVideoShot = {
    id: string;
    startSeconds: number;
    endSeconds: number;
    evidence: string;
    confidence: "high" | "medium" | "low";
    assetIds: string[];
    description: string;
    dialogue: string;
    camera: string;
    motion: string;
    imagePrompt: string;
    videoPrompt: string;
    negativePrompt: string;
};

export type ViralVideoAnalysis = {
    summary: string;
    hook: string;
    globalPrompt: string;
    limitations: string[];
    assets: ViralVideoAsset[];
    shots: ViralVideoShot[];
};

export type ViralVideoFrame = { storageKey: string; timeSeconds: number; width: number; height: number };

export type ViralVideoWorkflow = {
    version: 1;
    sourceNodeId: string;
    stage: "sampling" | "analyzing" | "ready" | "error";
    model: string;
    taskId?: string;
    taskStatus?: string;
    progress?: number;
    error?: string;
    pollingError?: string;
    durationSeconds?: number;
    frames: ViralVideoFrame[];
    analysis?: ViralVideoAnalysis;
    promptOverride?: string;
    bindings: Record<string, string>;
    assetNodeIds: Record<string, string>;
    promptNodeId?: string;
    storyboardNodeId?: string;
};

export type ViralVideoAgentRequest = {
    action: "read" | "analyze" | "open" | "replace_asset" | "preview" | "generate" | "compose";
    nodeId: string;
    assetId?: string;
    replacementNodeId?: string;
    rowIds?: string[];
};
