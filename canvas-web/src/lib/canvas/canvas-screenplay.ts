import { nanoid } from "nanoid";
import type { ScreenplayAsset, ScreenplayBeat, ScreenplayDocument, ScreenplayEpisode, ScreenplayScene, ScreenplayWorkflow } from "@/types/canvas-screenplay";

export const SCREENPLAY_SKILL_IDS = ["lalor-screenplay-outline", "lalor-screenplay-writing"] as const;
export const SCREENPLAY_SOURCE_LIMIT = 60000;
export const SCREENPLAY_NOVEL_LIMIT = 60000;
export const SCREENPLAY_RESULT_LIMIT = 180000;
export const screenplayBusy = (workflow: ScreenplayWorkflow) => ["submitting", "unknown", "running"].includes(workflow.task?.status || "");
export const emptyScene = (): ScreenplayScene => ({ id: nanoid(), title: "新场次", timeOfDay: "日 / 内", characterIds: [], beats: [{ id: nanoid(), kind: "action", text: "" }] });
export const emptyEpisode = (index: number): ScreenplayEpisode => ({ id: nanoid(), title: `第 ${index} 集`, synopsis: "", hook: "", cliffhanger: "", novelText: "", scenes: [] });
export function newScreenplay(): ScreenplayWorkflow {
    return { version: 1, history: [], document: { version: 1, revision: 0, title: "未命名剧本", mode: "original", brief: "", source: "", genre: "", audience: "", tone: "", episodeCount: 6, targetSeconds: 120, outline: "", assets: [], episodes: [] } };
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须为对象`);
    return value as Record<string, unknown>;
}
function text(value: unknown, label: string, limit = 12000) {
    if (typeof value !== "string" || value.length > limit) throw new Error(`${label}须为不超过 ${limit} 字的文本`);
    return value;
}
function list(value: unknown, label: string, limit: number): unknown[] {
    if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}须为不超过 ${limit} 项的数组`);
    return value;
}
function id(value: unknown) { const result = text(value, "ID", 100).trim(); if (!result) throw new Error("缺少稳定 ID"); return result; }
function unique(ids: string[], label: string) { if (new Set(ids).size !== ids.length) throw new Error(`${label}存在重复 ID`); }
export function parseScreenplayJson(raw: string) {
    if (!raw.trim() || raw.length > SCREENPLAY_RESULT_LIMIT) throw new Error("生成结果为空或超过可处理长度");
    return object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")), "生成结果");
}
export function validateScene(value: unknown, assets: ScreenplayAsset[]): ScreenplayScene {
    const data = object(value, "场次");
    const characters = assets.filter((asset) => asset.kind === "character").map((asset) => asset.id);
    const characterIds = list(data.characterIds, "出场人物", 40).map(id);
    unique(characterIds, "出场人物");
    if (characterIds.some((item) => !characters.includes(item))) throw new Error("场次引用了未定义的人物");
    const locationId = data.locationId ? id(data.locationId) : undefined;
    if (locationId && !assets.some((asset) => asset.id === locationId && asset.kind === "location")) throw new Error("场次引用了未定义的场景资产");
    const beats: ScreenplayBeat[] = list(data.beats, "动作与对白", 150).map((item) => {
        const beat = object(item, "段落");
        if (beat.kind !== "action" && beat.kind !== "dialogue") throw new Error("段落类型须为 action 或 dialogue");
        const characterId = beat.characterId ? id(beat.characterId) : undefined;
        if (beat.kind === "dialogue" && (!characterId || (characterId !== "VO" && !characterIds.includes(characterId)))) throw new Error("对白说话人须为本场人物 ID 或 VO");
        return { id: id(beat.id), kind: beat.kind, characterId, text: text(beat.text, "段落内容"), delivery: beat.delivery === undefined ? undefined : text(beat.delivery, "语气", 500) };
    });
    unique(beats.map((beat) => beat.id), "段落");
    return { id: id(data.id), title: text(data.title, "场次名", 200), timeOfDay: text(data.timeOfDay, "时空", 100), locationId, characterIds, beats };
}
export function validateEpisode(value: unknown, assets: ScreenplayAsset[]): ScreenplayEpisode {
    const data = object(value, "分集");
    if (data.scenesNeedAdaptation !== undefined && typeof data.scenesNeedAdaptation !== "boolean") throw new Error("分场同步状态无效");
    return { id: id(data.id), title: text(data.title, "集名", 200), synopsis: text(data.synopsis, "分集梗概"), hook: text(data.hook, "开场钩子", 3000), cliffhanger: text(data.cliffhanger, "集尾悬念", 3000), novelText: data.novelText === undefined ? "" : text(data.novelText, "本集小说正文", SCREENPLAY_NOVEL_LIMIT), scenesNeedAdaptation: data.scenesNeedAdaptation as boolean | undefined, scenes: list(data.scenes, "场次", 60).map((scene) => validateScene(scene, assets)) };
}
export function validateScreenplay(value: unknown): ScreenplayDocument {
    const data = object(value, "剧本");
    if (data.version !== 1 || !Number.isInteger(data.revision) || Number(data.revision) < 0) throw new Error("剧本版本无效");
    if (!["original", "adapt", "rewrite"].includes(String(data.mode))) throw new Error("创作模式无效");
    const assets: ScreenplayAsset[] = list(data.assets, "资产", 100).map((item) => {
        const asset = object(item, "资产");
        if (!["character", "location", "prop"].includes(String(asset.kind))) throw new Error("资产类型无效");
        const name = text(asset.name, "资产名", 100);
        if (!name.trim()) throw new Error("资产名称不能为空");
        return { id: id(asset.id), kind: asset.kind as ScreenplayAsset["kind"], name, description: text(asset.description, "资产描述", 5000), referenceNodeId: asset.referenceNodeId ? id(asset.referenceNodeId) : undefined };
    });
    unique(assets.map((asset) => asset.id), "资产");
    const episodes = list(data.episodes, "分集", 100).map((episode) => validateEpisode(episode, assets));
    unique(episodes.map((episode) => episode.id), "分集");
    unique(episodes.flatMap((episode) => episode.scenes.map((scene) => scene.id)), "场次");
    unique(episodes.flatMap((episode) => episode.scenes.flatMap((scene) => scene.beats.map((beat) => beat.id))), "段落");
    const totalSize = JSON.stringify({ assets, episodes }).length;
    if (totalSize > 600000) throw new Error("剧本正文超过单工作区容量，请按集拆成多个剧本工作区");
    const episodeCount = Number(data.episodeCount), targetSeconds = Number(data.targetSeconds);
    if (!Number.isInteger(episodeCount) || episodeCount < 1 || episodeCount > 100 || !Number.isInteger(targetSeconds) || targetSeconds < 15 || targetSeconds > 3600) throw new Error("集数须为 1–100，单集时长须为 15–3600 秒");
    return { version: 1, revision: Number(data.revision), title: text(data.title, "剧本名", 200), mode: data.mode as ScreenplayDocument["mode"], brief: text(data.brief, "创作要求"), source: text(data.source, "原始素材", SCREENPLAY_SOURCE_LIMIT), genre: text(data.genre, "题材", 200), audience: text(data.audience, "受众", 200), tone: text(data.tone, "风格", 500), episodeCount, targetSeconds, outline: text(data.outline, "故事大纲", 30000), assets, episodes };
}
export function reviseScreenplay(workflow: ScreenplayWorkflow, next: ScreenplayDocument, expectedRevision: number, label: string): ScreenplayWorkflow {
    if (workflow.document.revision !== expectedRevision) throw new Error("剧本已有新版本，请重新读取后再保存，避免覆盖修改");
    const document = validateScreenplay({ ...next, revision: expectedRevision + 1 });
    // 小说和分场独立保存；修改小说只提示同步，不覆盖人工场次。
    document.episodes = document.episodes.map((episode) => {
        const previous = workflow.document.episodes.find((item) => item.id === episode.id);
        return previous && (previous.novelText || "") !== (episode.novelText || "") && episode.scenes.length ? { ...episode, scenesNeedAdaptation: true } : episode;
    });
    return { ...workflow, document, approvedRevision: undefined, history: [...workflow.history, { id: nanoid(), label, createdAt: new Date().toISOString(), document: workflow.document }].slice(-12) };
}
export function screenplayText(doc: ScreenplayDocument) {
    const names = new Map(doc.assets.map((asset) => [asset.id, asset.name]));
    return [`# ${doc.title}`, doc.outline, ...doc.episodes.map((episode) => [`## ${episode.title}`, episode.synopsis, `开场：${episode.hook}`, ...(episode.novelText ? ["### 小说正文", episode.novelText] : []), ...(episode.scenes.length ? ["### 分场剧本", ...episode.scenes.map((scene) => [`#### ${scene.title} · ${names.get(scene.locationId || "") || "未指定场景"} · ${scene.timeOfDay}`, ...scene.beats.map((beat) => beat.kind === "action" ? `△ ${beat.text}` : `${names.get(beat.characterId || "") || "旁白"}${beat.delivery ? `（${beat.delivery}）` : ""}：${beat.text}`)].join("\n"))] : []), `集尾：${episode.cliffhanger}`].join("\n\n"))].join("\n\n");
}
export function screenplaySummary(workflow: ScreenplayWorkflow) {
    const doc = workflow.document;
    return { title: doc.title, revision: doc.revision, approved: workflow.approvedRevision === doc.revision, outline: doc.outline.slice(0, 1000), assets: doc.assets, episodes: doc.episodes.map(({ id, title, novelText, scenesNeedAdaptation, scenes }) => ({ id, title, novelLength: novelText?.length || 0, scenesNeedAdaptation: Boolean(scenesNeedAdaptation), scenes: scenes.map(({ id, title }) => ({ id, title })) })), task: workflow.task ? { ...workflow.task, resultText: undefined, instruction: undefined, baseDocument: undefined } : undefined };
}
