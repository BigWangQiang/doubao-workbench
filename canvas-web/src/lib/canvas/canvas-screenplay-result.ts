import { parseScreenplayJson, SCREENPLAY_NOVEL_LIMIT, validateEpisode, validateScene, validateScreenplay } from "@/lib/canvas/canvas-screenplay";
import type { ScreenplayDocument, ScreenplayTask } from "@/types/canvas-screenplay";

// 结果合并独立于画布节点创建，便于检查正文保留、分集隔离和覆盖边界。
export function mergeScreenplayResult(document: ScreenplayDocument, task: ScreenplayTask, raw: string) {
    const result = parseScreenplayJson(raw);
    if (task.action === "outline") {
        if (document.episodes.some((episode) => episode.scenes.length || episode.novelText?.trim())) throw new Error("已有小说或分场剧本，不能用新大纲覆盖；请新建剧本或恢复到空白版本");
        // 大纲阶段尚未写正文，只补齐省略的空场次；显式错误类型和正文仍交给严格校验。
        const episodes = Array.isArray(result.episodes) ? result.episodes.map((episode: unknown) => episode && typeof episode === "object" && !Array.isArray(episode) && !("scenes" in episode) ? { ...episode, scenes: [] } : episode) : result.episodes;
        const next = validateScreenplay({ ...document, title: result.title, outline: result.outline, assets: result.assets, episodes });
        if (next.episodes.length !== document.episodeCount || !next.outline.trim() || next.episodes.some((episode) => episode.scenes.length || episode.novelText?.trim())) throw new Error("大纲须包含约定集数的分集梗概，正文应在下一阶段生成");
        return next;
    }
    const episode = document.episodes.find((item) => item.id === task.episodeId);
    if (!episode) throw new Error("目标分集已删除");
    let updated = episode;
    if (task.action === "write_novel" || task.action === "rewrite_novel") {
        if (result.episodeId !== episode.id) throw new Error("小说正文与目标分集不一致");
        if (task.action === "write_novel" && episode.novelText?.trim()) throw new Error("本集已有小说正文，请使用改写小说正文");
        if (task.action === "rewrite_novel" && !episode.novelText?.trim()) throw new Error("本集还没有小说正文，请先生成正文");
        if (typeof result.novelText !== "string" || !result.novelText.trim() || result.novelText.length > SCREENPLAY_NOVEL_LIMIT) throw new Error("本集完整小说正文为空或超出长度限制");
        updated = { ...episode, novelText: result.novelText };
    } else if (task.action === "adapt_episode") {
        if (!episode.novelText?.trim()) throw new Error("请先完成本集小说正文，再改编分场剧本");
        if (episode.scenes.length && !task.replaceExistingScenes) throw new Error("本集已有场次，重新改编须明确确认替换");
        const adapted = validateEpisode(result.episode, document.assets);
        if (adapted.id !== episode.id || !adapted.scenes.length || adapted.scenes.some((scene) => !scene.beats.length || scene.beats.some((beat) => !beat.text.trim()))) throw new Error("改编结果与目标集不一致或分场内容为空");
        updated = { ...episode, scenes: adapted.scenes, scenesNeedAdaptation: false };
    } else if (task.action === "rewrite_scene") {
        const scene = validateScene(result.scene, document.assets);
        if (scene.id !== task.sceneId || !episode.scenes.some((item) => item.id === scene.id) || !scene.beats.length) throw new Error("改写结果与目标场次不一致或正文为空");
        const target = episode.scenes.find((item) => item.id === scene.id)!;
        if (scene.locationId !== target.locationId || scene.characterIds.slice().sort().join("|") !== target.characterIds.slice().sort().join("|")) throw new Error("场次改写改变了人物或地点，请在工作区明确调整设定后再改写");
        updated = { ...episode, scenes: episode.scenes.map((item) => item.id === scene.id ? scene : item) };
    } else if (task.action === "continue_episode") {
        if (!Array.isArray(result.scenes) || !result.scenes.length || result.scenes.length > 60) throw new Error("续写结果缺少新增场次或超过上限");
        updated = { ...episode, scenes: [...episode.scenes, ...result.scenes.map((scene) => validateScene(scene, document.assets))] };
    } else if (task.action === "write_episode") {
        const generated = validateEpisode(result.episode, document.assets);
        updated = { ...generated, novelText: episode.novelText, scenesNeedAdaptation: episode.scenesNeedAdaptation };
        if (updated.id !== episode.id || !updated.scenes.length || updated.scenes.some((scene) => !scene.beats.length)) throw new Error("正文与目标分集不一致或内容为空");
        if (episode.scenes.length) throw new Error("本集已有正文，请使用逐场改写或续写，避免整集覆盖");
    } else throw new Error("此动作不支持合并为剧本正文");
    return validateScreenplay({ ...document, episodes: document.episodes.map((item) => item.id === updated.id ? updated : item) });
}
