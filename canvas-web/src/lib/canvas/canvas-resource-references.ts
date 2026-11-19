import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { Skill } from "@/services/api/skills";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";

export type CanvasResourceKind = "image" | "video" | "audio" | "text" | "skill" | "character";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    storageKey?: string;
    text?: string;
    aliases?: string[];
    active: boolean;
    sourceType?: CanvasNodeType;
    skill?: Skill;
};

export type CanvasResourceMentionMatch = {
    value: string;
    matchedReferences: CanvasResourceReference[];
    addedReferences: CanvasResourceReference[];
};

const CHINESE_REFERENCE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

/** 视频引用的短名称只用于界面展示，稳定的 node token 和原始资源标题保持不变。 */
export function canvasVideoReferenceLabel(index: number) {
    const value = Math.max(1, Math.floor(index) + 1);
    if (value < 10) return `视频${CHINESE_REFERENCE_DIGITS[value]}`;
    if (value < 20) return `视频十${value === 10 ? "" : CHINESE_REFERENCE_DIGITS[value - 10]}`;
    if (value < 100) {
        const tens = Math.floor(value / 10);
        const ones = value % 10;
        return `视频${CHINESE_REFERENCE_DIGITS[tens]}十${ones ? CHINESE_REFERENCE_DIGITS[ones] : ""}`;
    }
    return `视频${value}`;
}

export function canvasVideoReferenceDisplayLabel(reference: Pick<CanvasResourceReference, "kind" | "label">) {
    if (reference.kind !== "video") return reference.label;
    const match = /^视频(\d+)$/.exec(reference.label.trim());
    if (!match) return reference.label;
    return canvasVideoReferenceLabel(Number(match[1]) - 1);
}

const GENERIC_REFERENCE_ALIASES = new Set(["图片", "视频", "音频", "文本", "绘图", "角色", "人物", "场景", "环境", "道具", "服装", "武器", "风格", "素材", "技能", "image", "video", "audio", "text", "character", "scene", "prop", "style", "asset"]);

export function matchCanvasResourceReferences(text: string, references: CanvasResourceReference[]) {
    const normalizedText = normalizeReferenceText(text);
    if (!normalizedText) return [];
    const aliasesByReference = new Map(references.map((reference) => [reference.nodeId, referenceAliases(reference).map(normalizeReferenceText)]));
    const aliasOwners = new Map<string, number>();
    aliasesByReference.forEach((aliases) => aliases.forEach((alias) => aliasOwners.set(alias, (aliasOwners.get(alias) || 0) + 1)));
    return references.filter((reference) => {
        if (text.includes(`@[node:${reference.nodeId}]`)) return true;
        return (aliasesByReference.get(reference.nodeId) || []).some((alias) => aliasOwners.get(alias) === 1 && normalizedText.includes(alias));
    });
}

export function appendMatchedCanvasResourceMentions(text: string, references: CanvasResourceReference[]): CanvasResourceMentionMatch {
    const eligibleReferences = references.filter((reference) => reference.active && reference.kind !== "skill");
    const matchedReferences = matchCanvasResourceReferences(text, eligibleReferences);
    const initialMatches = findReferenceAliasMatches(text, eligibleReferences);
    if (!initialMatches.length) return { value: text, matchedReferences, addedReferences: [] };

    const matchedNodeIds = new Set(initialMatches.map((match) => match.reference.nodeId));
    const baseText = stripMatchedReferenceTokens(text, matchedNodeIds);
    const localizedMatches = findReferenceAliasMatches(baseText, eligibleReferences).filter((match) => matchedNodeIds.has(match.reference.nodeId));
    let value = baseText;
    for (const match of [...localizedMatches].reverse()) {
        const token = canvasResourceMentionToken(match.reference);
        const nextCharacter = value[match.end];
        const suffix = nextCharacter && !isMentionBoundaryCharacter(nextCharacter) ? " " : "";
        value = `${value.slice(0, match.end)} ${token}${suffix}${value.slice(match.end)}`;
    }

    if (value === text) return { value: text, matchedReferences, addedReferences: [] };
    const addedNodeIds = new Set(localizedMatches.map((match) => match.reference.nodeId));
    const addedReferences = eligibleReferences.filter((reference) => addedNodeIds.has(reference.nodeId));
    return {
        value,
        matchedReferences,
        addedReferences,
    };
}

type ReferenceAliasMatch = {
    reference: CanvasResourceReference;
    start: number;
    end: number;
};

function findReferenceAliasMatches(text: string, references: CanvasResourceReference[]): ReferenceAliasMatch[] {
    const aliasesByReference = references.map((reference, referenceIndex) => ({
        reference,
        referenceIndex,
        aliases: referenceAliases(reference).map((alias) => ({ alias, normalized: normalizeReferenceText(alias) })),
    }));
    const aliasOwners = new Map<string, number>();
    aliasesByReference.forEach(({ aliases }) => {
        new Set(aliases.map(({ normalized }) => normalized)).forEach((alias) => aliasOwners.set(alias, (aliasOwners.get(alias) || 0) + 1));
    });

    const normalizedText = normalizeReferenceTextWithSourceMap(text);
    const mentionRanges = Array.from(text.matchAll(/@\[node:[^\]]+\]/g)).flatMap((match) =>
        match.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }],
    );
    const matches: Array<ReferenceAliasMatch & { aliasLength: number; referenceIndex: number }> = [];
    aliasesByReference.forEach(({ reference, referenceIndex, aliases }) => {
        aliases.forEach(({ normalized }) => {
            if (!normalized || aliasOwners.get(normalized) !== 1) return;
            let normalizedIndex = normalizedText.value.indexOf(normalized);
            while (normalizedIndex >= 0) {
                const start = normalizedText.starts[normalizedIndex];
                const end = normalizedText.ends[normalizedIndex + normalized.length - 1];
                const overlapsMention = mentionRanges.some((range) => start < range.end && end > range.start);
                if (!overlapsMention) matches.push({ reference, start, end, aliasLength: end - start, referenceIndex });
                normalizedIndex = normalizedText.value.indexOf(normalized, normalizedIndex + 1);
            }
        });
    });

    matches.sort((left, right) => left.start - right.start || right.aliasLength - left.aliasLength || left.referenceIndex - right.referenceIndex);
    const localized: ReferenceAliasMatch[] = [];
    let occupiedUntil = -1;
    matches.forEach((match) => {
        if (match.start < occupiedUntil) return;
        localized.push({ reference: match.reference, start: match.start, end: match.end });
        occupiedUntil = match.end;
    });
    return localized;
}

function normalizeReferenceTextWithSourceMap(value: string) {
    const normalized: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (let index = 0; index < value.length; ) {
        const codePoint = value.codePointAt(index);
        if (codePoint === undefined) break;
        const character = String.fromCodePoint(codePoint);
        const end = index + character.length;
        const normalizedCharacter = character.normalize("NFKC").toLocaleLowerCase();
        for (let offset = 0; offset < normalizedCharacter.length; offset += 1) {
            const unit = normalizedCharacter[offset];
            if (/\s/u.test(unit)) continue;
            normalized.push(unit);
            starts.push(index);
            ends.push(end);
        }
        index = end;
    }
    return { value: normalized.join(""), starts, ends };
}

function stripMatchedReferenceTokens(text: string, nodeIds: Set<string>) {
    let value = text;
    nodeIds.forEach((nodeId) => {
        value = value.replaceAll(`@[node:${nodeId}]`, "");
    });
    return value.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+(?=\r?\n|$)/g, "");
}

function isMentionBoundaryCharacter(character: string) {
    return /\s|[,.!?;:，。！？；：、\]}】）]/u.test(character);
}

export function canvasResourceMentionToken(reference: CanvasResourceReference) {
    if (reference.kind === "skill" && reference.skill?.skill_id) return `@[skill:${reference.skill.skill_id}]`;
    return `@[node:${reference.nodeId}]`;
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null) {
    const contextNodes = contextNodeId ? getMentionResourceNodes(contextNodeId, nodes, connections) : [];
    const globalReferences = labelResourceNodes(nodes.filter(isResourceNode), false);
    const activeByNodeId = new Map(labelResourceNodes(contextNodes, true).map((reference) => [reference.nodeId, reference]));
    return globalReferences.map((reference) => activeByNodeId.get(reference.nodeId) || reference);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    const node = nodes.find((item) => item.id === nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    return [];
}

/** 收集节点自身及其上游链路中的视频节点，用于时间线片段导入定位真正的视频源。 */
export function collectUpstreamVideoNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const queue = [nodeId];
    const visited = new Set<string>();
    const result: CanvasNodeData[] = [];
    while (queue.length) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        const node = nodes.find((item) => item.id === currentId);
        if (node?.type === CanvasNodeType.Video && Boolean(node.metadata?.content || node.metadata?.storageKey)) result.push(node);
        connections.filter((connection) => connection.toNodeId === currentId).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return result;
}

function getContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
}

function getConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0, skill: 0, character: 0 };
    let drawingCount = 0;
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const index = node.type === CanvasNodeType.Drawing ? drawingCount++ : counts[kind]++;
        const label = node.type === CanvasNodeType.Drawing ? `绘图${index + 1}` : labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.workflowKind === "character" ? node.metadata.characterCoverUrl || mediaPreviewUrl(node) : node.type === CanvasNodeType.Drawing ? node.metadata?.drawingPreviewUrl : mediaPreviewUrl(node),
                storageKey: node.metadata?.storageKey,
                text: node.metadata?.workflowKind === "character"
                    ? node.metadata.characterPrompt
                    : node.type === CanvasNodeType.Text
                      ? node.metadata?.content || node.metadata?.prompt
                      : node.type === CanvasNodeType.Skill
                        ? skillResourceText(node)
                        : node.metadata?.prompt || node.metadata?.composerContent,
                aliases: [node.title, label, node.metadata?.characterName, ...(node.metadata?.characterAliases || []), ...(node.metadata?.assetTags || [])].filter((value): value is string => Boolean(value?.trim())),
                active,
                sourceType: node.type,
            },
        ];
    });
}

function referenceAliases(reference: CanvasResourceReference) {
    return Array.from(new Set([reference.title, reference.label, ...(reference.aliases || []), ...referenceDescriptionAliases(reference)]))
        .map((value) => value.trim())
        .filter((value) => value.length >= 2 && !GENERIC_REFERENCE_ALIASES.has(normalizeReferenceText(value)));
}

function referenceDescriptionAliases(reference: CanvasResourceReference) {
    if (!reference.text || !["image", "character"].includes(reference.kind)) return [];
    return reference.text
        .split(/[\n,，。；;、|/]+/)
        .map((value) => value.replace(/^[^：:]{1,8}[：:]/, "").trim())
        .filter((value) => value.length >= 2 && value.length <= 20);
}

function normalizeReferenceText(value: string) {
    return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "character") return `角色${index + 1}`;
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return seedanceReferenceLabel("video", index);
    if (kind === "audio") return seedanceReferenceLabel("audio", index);
    if (kind === "skill") return `技能${index + 1}`;
    return `文本${index + 1}`;
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId) return "character";
    if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey || node.metadata?.mediaUploadId)) return "image";
    if (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId) return "image";
    if (node.type === CanvasNodeType.Video && (node.metadata?.content || node.metadata?.storageKey || node.metadata?.mediaUploadId)) return "video";
    if (node.type === CanvasNodeType.Audio && (node.metadata?.content || node.metadata?.storageKey)) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    if (node.type === CanvasNodeType.Skill && (node.metadata?.skillSnapshot || node.metadata?.content)) return "text";
    return null;
}

function mediaPreviewUrl(node: CanvasNodeData) {
    if (node.metadata?.content) return node.metadata.content;
    const resourceId = node.metadata?.storageKey ? resourceIdFromStorageKey(node.metadata.storageKey) : undefined;
    return resourceId ? resourceFileUrl(resourceId) : undefined;
}

function skillResourceText(node: CanvasNodeData) {
    const skill = node.metadata?.skillSnapshot;
    if (!skill) return node.metadata?.content || "";
    return [skill.name, skill.description, skill.template, skill.outputContract].filter(Boolean).join("\n\n");
}
