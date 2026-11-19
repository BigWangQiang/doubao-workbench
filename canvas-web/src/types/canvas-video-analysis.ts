export type VideoAnalysisDimension = "storyboard" | "motion" | "music";
export type VideoAnalysisInputMode = "video" | "frames";

export type VideoAnalysisFrame = {
    storageKey: string;
    timeSeconds: number;
    width: number;
    height: number;
};

export type VideoAnalysisShot = {
    startSeconds: number;
    endSeconds: number;
    frameIndex: number;
    description: string;
    camera: string;
    motion: string;
    dialogue: string;
    sound: string;
    imagePrompt: string;
    videoPrompt: string;
};

export type VideoAnalysisResult = {
    summary: string;
    globalPrompt: string;
    motionSummary: string;
    music: { status: "analyzed" | "unavailable" | "not_requested"; description: string };
    limitations: string[];
    shots: VideoAnalysisShot[];
};

export type VideoAnalysisWorkflow = {
    version: 1;
    sourceNodeId: string;
    stage: "idle" | "preparing" | "submitting" | "recovering" | "analyzing" | "ready" | "error";
    dimensions: VideoAnalysisDimension[];
    inputMode: VideoAnalysisInputMode;
    model: string;
    frames: VideoAnalysisFrame[];
    durationSeconds?: number;
    runId?: string;
    taskId?: string;
    taskStatus?: string;
    progress?: number;
    error?: string;
    pollingError?: string;
    result?: VideoAnalysisResult;
    documentNodeId?: string;
    storyboardNodeId?: string;
};
