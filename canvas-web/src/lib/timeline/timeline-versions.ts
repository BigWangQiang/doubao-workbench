import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineClipVersion, TimelineProject } from "@/types/timeline";

function clipVersion(clip: TimelineClip, id = clip.activeVersionId || clip.nodeId): TimelineClipVersion {
    return {
        id,
        nodeId: clip.nodeId,
        title: clip.title,
        directMedia: clip.directMedia,
        sourceStartMs: clip.sourceStartMs,
        sourceDurationMs: clip.sourceDurationMs,
        durationMs: clip.durationMs,
        createdAt: new Date().toISOString(),
    };
}

function uniqueVersions(versions: TimelineClipVersion[]) {
    const byId = new Map<string, TimelineClipVersion>();
    versions.forEach((version) => byId.set(version.id, version));
    return [...byId.values()];
}

/** 仅生成成功且已有媒体时替换，排队、失败和空结果不会动原时间线。 */
export function applyCompletedTimelineReplacements(timeline: TimelineProject, nodes: CanvasNodeData[]) {
    const replacementByClipId = new Map(
        nodes
            .filter((node) => node.metadata?.timelineReplaceClipId && node.metadata?.status === "success" && Boolean(node.metadata?.content || node.metadata?.storageKey))
            .map((node) => [node.metadata!.timelineReplaceClipId!, node]),
    );
    let changed = false;
    const clips = timeline.clips.map((clip) => {
        const replacement = replacementByClipId.get(clip.id);
        if (!replacement || replacement.id === clip.nodeId || clip.kind !== "video") return clip;
        changed = true;
        const nextDurationMs = replacement.metadata?.durationMs && replacement.metadata.durationMs > 0 ? Math.round(replacement.metadata.durationMs) : clip.durationMs;
        const currentVersion = clipVersion(clip);
        const nextVersion: TimelineClipVersion = {
            id: replacement.id,
            nodeId: replacement.id,
            title: replacement.title,
            sourceStartMs: 0,
            sourceDurationMs: nextDurationMs,
            durationMs: nextDurationMs,
            createdAt: new Date().toISOString(),
        };
        return {
            ...clip,
            nodeId: replacement.id,
            title: replacement.title || clip.title,
            directMedia: undefined,
            sourceStartMs: 0,
            sourceDurationMs: nextDurationMs,
            durationMs: nextDurationMs,
            activeVersionId: replacement.id,
            versions: uniqueVersions([...(clip.versions || []), currentVersion, nextVersion]),
        };
    });
    if (!changed) return timeline;
    return {
        ...timeline,
        clips,
        durationMs: clips.reduce((max, clip) => Math.max(max, clip.startMs + clip.durationMs), 0),
        updatedAt: new Date().toISOString(),
    };
}

export function restoreTimelineClipVersion(timeline: TimelineProject, clipId: string, versionId: string) {
    let changed = false;
    const clips = timeline.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const version = clip.versions?.find((item) => item.id === versionId);
        if (!version || version.nodeId === clip.nodeId) return clip;
        changed = true;
        return {
            ...clip,
            nodeId: version.nodeId,
            title: version.title,
            directMedia: version.directMedia,
            sourceStartMs: version.sourceStartMs,
            sourceDurationMs: version.sourceDurationMs,
            durationMs: version.durationMs,
            activeVersionId: version.id,
        };
    });
    if (!changed) return timeline;
    return {
        ...timeline,
        clips,
        durationMs: clips.reduce((max, clip) => Math.max(max, clip.startMs + clip.durationMs), 0),
        updatedAt: new Date().toISOString(),
    };
}
