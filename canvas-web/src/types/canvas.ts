import type { PortraitTextureSettings } from "@/lib/canvas/canvas-portrait-texture";
import type { ViralVideoWorkflow } from "@/types/canvas-viral-video";
import type { VideoAnalysisWorkflow } from "@/types/canvas-video-analysis";
import type { ScreenplayWorkflow, ScreenplayProvenance } from "@/types/canvas-screenplay";
import type { StyleExecutionPlan } from "@/lib/canvas/style-profile";
import type { SrtEntry, SubtitleHighlight, SubtitleStyle } from "@/types/timeline";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Drawing = "drawing",
    Script = "script",
    Skill = "skill",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Frame = "frame",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasMediaPerformanceMode = "auto" | "quality" | "performance";
export type CanvasWorkspaceMode = "simple" | "professional";
export type CanvasToolMode = "move" | "box-select";
export type StoryboardShotDuration = "auto" | "5" | "10" | "15" | "30";
export type StoryboardShotCount = "auto" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10";
export type StoryboardVideoInputMode = "direct" | "keyframe";
export type StoryboardColorMark = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasGenerationBatchMode = "storyboard_image" | "storyboard_video" | "action_board";
export type CanvasGenerationBatchStatus = "queued" | "running" | "partial_failed" | "completed" | "cancelled";
export type CanvasGenerationBatchItemStatus = "waiting" | "submitting" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type CanvasImageGenerationType = "generation" | "edit";
export type CanvasWorkflowKind = "free" | "script" | "story_input" | "character" | "scene" | "storyboard" | "shot" | "final" | "styleboard" | "reference_set" | "reference_video" | "action_board";
export type CanvasVideoEditOperation =
    | "text_to_video"
    | "image_to_video"
    | "reference_to_video"
    | "h3_context_ir_text"
    | "h3_context_ir_image"
    | "h3_context_ir_reference"
    | "video_regeneration_task"
    | "video_regeneration_text"
    | "video_regeneration_image"
    | "video_regeneration_reference"
    | "extend"
    | "inpaint"
    | "replace_element"
    | "camera_motion"
    | "style_transfer"
    | "audio_to_video"
    | "compare_versions"
    | "concat";
export type CanvasSkillCategory = "writing" | "storyboard" | "image" | "video" | "utility";
export type CanvasSkillOutputMode = "text" | "json" | "image_prompt" | "workflow";
export type StoryboardColumn = "shotNumber" | "durationSeconds" | "plotDescription" | "dialogue" | "narrativeIntent" | "viewerPOV" | "performanceBlocking" | "shotSize" | "emotion" | "lightingAndAtmosphere" | "audioEffects" | "camera" | "motion" | "timeBeats" | "imageGenerationPrompt" | "videoMotionPrompt" | "continuityOut" | "negativePrompt";

export type StoryboardCharacterReference = {
    characterName: string;
    characterAssetId?: string;
    characterVersionId?: string;
    characterDescription?: string;
    characterImageNodeId?: string;
};

export type StoryboardRow = {
    id: string;
    shotNumber: number;
    durationSeconds: number;
    plotDescription: string;
    dialogue: string;
    characters: StoryboardCharacterReference[];
    narrativeIntent: string;
    viewerPOV: string;
    performanceBlocking: string;
    shotSize: string;
    emotion: string;
    lightingAndAtmosphere: string;
    audioEffects: string;
    camera: string;
    motion: string;
    timeBeats: string;
    imageGenerationPrompt: string;
    videoMotionPrompt: string;
    imagePromptTemplateVariables?: Record<string, string>;
    videoPromptTemplateVariables?: Record<string, string>;
    mustHave: string[];
    optionalDetails: string[];
    continuityOut: string;
    negativePrompt: string;
    referenceNodeIds: string[];
    colorMark?: StoryboardColorMark;
    imageNodeId?: string;
    videoNodeId?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
};

export type StoryboardData = {
    rows: StoryboardRow[];
    visibleColumns: StoryboardColumn[];
    referenceNodeIds: string[];
};

export type CanvasGenerationBatchItem = {
    id: string;
    rowId: string;
    nodeId: string;
    taskId?: string;
    status: CanvasGenerationBatchItemStatus;
    retryCount: number;
    errorDetails?: string;
    costUncertain?: boolean;
};

export type CanvasGenerationBatch = {
    id: string;
    projectId: string;
    sourceNodeId: string;
    mode: CanvasGenerationBatchMode;
    status: CanvasGenerationBatchStatus;
    items: CanvasGenerationBatchItem[];
    createdAt: string;
    updatedAt: string;
};

export type CanvasSkillSnapshot = {
    id: string;
    name: string;
    description: string;
    category: CanvasSkillCategory;
    template: string;
    outputMode: CanvasSkillOutputMode;
    outputContract: string;
    version: number;
    tags: string[];
};

export type CanvasNodeMetadata = {
    screenplay?: ScreenplayWorkflow;
    screenplaySource?: ScreenplayProvenance;
    viralVideo?: ViralVideoWorkflow;
    viralVideoAnalysisNodeId?: string;
    videoAnalysis?: VideoAnalysisWorkflow;
    content?: string;
    richText?: Record<string, unknown>;
    composerContent?: string;
    prompt?: string;
    promptTemplateOperation?: string;
    promptTemplateVariables?: Record<string, string>;
    status?: CanvasNodeStatus;
    locked?: boolean;
    errorDetails?: string;
    generationErrorCode?: string;
    failedPromptFingerprint?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    /** Human-readable model label retained when a generated asset is added from the creation page. */
    modelName?: string;
    /** Generation source identity retained for traceability and duplicate checks. */
    messageId?: string;
    conversationId?: string;
    resultIndex?: number;
    aspectRatio?: string;
    resolution?: string;
    durationSeconds?: string;
    videoQuality?: string;
    size?: string;
    quality?: string;
    transparentBackground?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    audioReferenceStorageKey?: string;
    audioReferenceName?: string;
    audioReferenceMimeType?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    /** 上传标识可持久化；本地预览、进度和等待 Promise 仅保存在当前账号的内存中。 */
    mediaUploadId?: string;
    mimeType?: string;
    /** 已持久化的视频首帧封面；优先使用其资源键，避免画布直接解码原视频。 */
    videoPreview?: {
        content?: string;
        storageKey?: string;
    };
    /** 兼容旧画布快照中的视频封面地址。 */
    previewContent?: string;
    bytes?: number;
    durationMs?: number;
    assetId?: string;
    assetTags?: string[];
    /** 白模投递去重标识，不作为用户可见的素材标签。 */
    blenderImportId?: string;
    assetCategory?: "character" | "environment" | "wardrobe" | "prop" | "weapon" | "style" | "other";
    workflowKind?: CanvasWorkflowKind;
    workflowTitle?: string;
    workflowDescription?: string;
    referenceSourceUrl?: string;
    referenceSourcePlatform?: string;
    stylePresetId?: string;
    styleProfileJson?: string;
    styleExecutionPlan?: StyleExecutionPlan;
    chapterId?: string;
    chapterTitle?: string;
    shotIndex?: number;
    sceneId?: string;
    characterIds?: string[];
    referenceSetId?: string;
    referenceAssetNodeIds?: string[];
    characterName?: string;
    characterPrompt?: string;
    characterAliases?: string[];
    characterDefinition?: Record<string, unknown>;
    characterAssetId?: string;
    characterVersionId?: string;
    characterVersionPolicy?: "current" | "pinned";
    characterVisualStatus?: string;
    characterVoiceStatus?: string;
    characterVoiceName?: string;
    characterVoiceProfile?: {
        name: string;
        provider: string;
        language: string;
        timbre: string;
    };
    characterVoiceInstructions?: string;
    characterCoverUrl?: string;
    characterView?: "front" | "side" | "back" | "multi";
    characterViewNodeIds?: {
        front?: string;
        side?: string;
        back?: string;
    };
    actionBoardRows?: number;
    actionBoardColumns?: number;
    taskId?: string;
    taskStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
    taskProgress?: number;
    taskStage?: string;
    taskCreatedAt?: string;
    taskStartedAt?: string;
    taskUpdatedAt?: string;
    taskCompletedAt?: string;
    sessionId?: string;
    videoEditOperation?: CanvasVideoEditOperation;
    minimaxSourceTaskId?: string;
    sourceTaskId?: string;
    source_task_id?: string;
    minimaxBaseVideoId?: string;
    sourceVideoId?: string;
    minimaxBaseVideoUrl?: string;
    sourceVideoUrl?: string;
    videoCameraMoveId?: string;
    videoCameraMovePrompt?: string;
    videoStartFrameNodeId?: string;
    /** 仅替换当前视频节点的参考图；保存资源标识，不保存私有下载链接。 */
    coloredPencilReferences?: Record<string, {
        originalStorageKey: string;
        storageKey: string;
        type: string;
        width?: number;
        height?: number;
        bytes?: number;
    }>;
    videoEndFrameNodeId?: string;
    videoStartFrameImageId?: string;
    videoStartFrameStorageKey?: string;
    videoStartFrameUrl?: string;
    videoStartFrameWidth?: number;
    videoStartFrameHeight?: number;
    videoStartFrameBytes?: number;
    videoStartFrameMimeType?: string;
    videoEndFrameImageId?: string;
    videoEndFrameStorageKey?: string;
    videoEndFrameUrl?: string;
    videoEndFrameWidth?: number;
    videoEndFrameHeight?: number;
    videoEndFrameBytes?: number;
    videoEndFrameMimeType?: string;
    versionOfNodeId?: string;
    versionLabel?: string;
    versionPrimary?: boolean;
    copiedFromNodeId?: string;
    /** 重拍完成后要替换的时间线片段；仅在生成成功后由项目层应用。 */
    timelineReplaceClipId?: string;
    timelineSourceNodeId?: string;
    directorSceneId?: string;
    directorShotId?: string;
    directorPreviewNodeId?: string;
    directorDepthNodeId?: string;
    directorNormalNodeId?: string;
    directorClayVideoNodeId?: string;
    previsSceneId?: string;
    previsShotId?: string;
    previsPreviewNodeId?: string;
    previsDepthNodeId?: string;
    previsNormalNodeId?: string;
    previsClayVideoNodeId?: string;
    subtitleEntries?: SrtEntry[];
    subtitleHighlights?: SubtitleHighlight[];
    subtitleStyle?: SubtitleStyle;
    subtitleUpdatedAt?: string;
    skillId?: string;
    skillVersion?: number;
    skillSnapshot?: CanvasSkillSnapshot;
    storyboard?: StoryboardData;
    storyboardShotDuration?: StoryboardShotDuration;
    storyboardShotCount?: StoryboardShotCount;
    storyboardVideoInputMode?: StoryboardVideoInputMode;
    storyboardComposerHeight?: number;
    generationBatches?: CanvasGenerationBatch[];
    frame?: {
        collapsed: boolean;
        expandedWidth: number;
        expandedHeight: number;
    };
    drawingId?: string;
    drawingEngine?: "tldraw" | "excalidraw";
    drawingRevision?: number;
    drawingUpdatedAt?: string;
    drawingPreviewStorageKey?: string;
    drawingPreviewUrl?: string;
    drawingShapeCount?: number;
    drawingPageCount?: number;
    emotionEdit?: {
        sourceNodeId: string;
        characterName: string;
        presetId: string;
        intimacy: number;
        arousal: number;
        label: string;
        faceBox: {
            id: string;
            x: number;
            y: number;
            width: number;
            height: number;
            confidence?: number;
            source: "detected" | "manual";
        };
        editRegion?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        sourceWidth?: number;
        sourceHeight?: number;
        providerSize?: string;
        maskStorageKey?: string;
    };
    portraitTexture?: PortraitTextureSettings;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    position: Position;
    width: number;
    height: number;
    parentId?: string;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    fromHandleId?: string;
    toHandleId?: string;
    fromAnchorRatio?: number;
    toAnchorRatio?: number;
};

export type CanvasDisplayConnection = {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantPendingBackendSession = {
    id: string;
    kind: "cinematic";
    messageId: string;
    status: "pending";
    startedAt: string;
};

export type CanvasAssistantPendingOnlineTurn = {
    idempotencyKey: string;
    taskId?: string;
    prompt: string;
    userMessageId: string;
    assistantMessageId: string;
    step: number;
    messages: unknown[];
    tools?: unknown[];
    status?: "preparing" | "running" | "processing" | "awaiting_approval";
    result?: { content: string; toolCalls: unknown[] };
    startedAt: string;
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    pendingBackendSession?: CanvasAssistantPendingBackendSession;
    pendingOnlineTurn?: CanvasAssistantPendingOnlineTurn;
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
    handleId?: string;
    anchorRatio?: number;
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    subtractive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "canvas";
          x: number;
          y: number;
          position: Position;
      }
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
