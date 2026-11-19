import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, Select } from "antd";
import { BookOpen, ChevronDown, FilePenLine, FileText, Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { emptyScene, SCREENPLAY_NOVEL_LIMIT, SCREENPLAY_SOURCE_LIMIT } from "@/lib/canvas/canvas-screenplay";
import type { ScreenplayDocument, ScreenplayEpisode, ScreenplayScene } from "@/types/canvas-screenplay";

export function ScreenplaySettings({ document: doc, onChange }: { document: ScreenplayDocument; onChange: (doc: ScreenplayDocument) => void }) {
    const hasOutline = Boolean(doc.outline);
    const [view, setView] = useState<"brief" | "outline">(hasOutline ? "outline" : "brief");
    useEffect(() => { if (hasOutline) setView("outline"); }, [hasOutline]);
    const field = (key: "brief" | "source" | "tone" | "outline", label: string, rows: number, placeholder: string) => <label className="screenplay-field"><span>{label}</span><Input.TextArea aria-label={label} value={doc[key]} rows={rows} placeholder={placeholder} maxLength={key === "source" ? SCREENPLAY_SOURCE_LIMIT : key === "outline" ? 30000 : 12000} onChange={(event) => onChange({ ...doc, [key]: event.target.value })} /></label>;
    return <div className="screenplay-settings">
        <div className="screenplay-page-heading"><span className="screenplay-eyebrow">{doc.episodeCount} 集 · 单集约 {doc.targetSeconds} 秒</span><h2>{view === "outline" ? "故事大纲" : "创作简报"}</h2></div>
        <div className="screenplay-document-tabs" role="group" aria-label="故事编辑内容"><button type="button" aria-pressed={view === "brief"} onClick={() => setView("brief")}><FilePenLine aria-hidden="true" />故事设定</button><button type="button" aria-pressed={view === "outline"} onClick={() => setView("outline")}><BookOpen aria-hidden="true" />大纲正文</button></div>
        {view === "brief" ? <>
        <section className="screenplay-form-section" aria-label="故事简报">
            <div className="screenplay-mode-switch" role="group" aria-label="创作方式">
                {([{ value: "original", label: "原创故事", icon: FilePenLine }, { value: "adapt", label: "小说改编", icon: BookOpen }, { value: "rewrite", label: "改写 / 续写", icon: FileText }] as const).map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={doc.mode === value} onClick={() => onChange({ ...doc, mode: value })}><Icon aria-hidden="true" />{label}</button>)}
            </div>
            {field("brief", "故事想法", 3, "主角是谁？遇到了什么困境？你希望故事如何发展？")}
            <div className="screenplay-form-grid">
                <label className="screenplay-field"><span>题材</span><Input value={doc.genre} placeholder="如：悬疑、都市、轻喜剧" maxLength={12000} onChange={(event) => onChange({ ...doc, genre: event.target.value })} /></label>
                <label className="screenplay-field"><span>目标受众</span><Input value={doc.audience} placeholder="如：年轻观众、亲子家庭" maxLength={12000} onChange={(event) => onChange({ ...doc, audience: event.target.value })} /></label>
                <label className="screenplay-field"><span>计划集数</span><InputNumber min={1} max={100} precision={0} value={doc.episodeCount} suffix="集" onChange={(value) => onChange({ ...doc, episodeCount: value || 1 })} /></label>
                <label className="screenplay-field"><span>单集时长 · 预计</span><InputNumber min={15} max={3600} precision={0} value={doc.targetSeconds} suffix="秒" onChange={(value) => onChange({ ...doc, targetSeconds: value || 120 })} /></label>
            </div>
        </section>
        <details className="screenplay-details" key={doc.mode} open={doc.mode !== "original" || Boolean(doc.source) || undefined}>
            <summary><FileText aria-hidden="true" /><span>补充素材与风格<small>{doc.source ? `${doc.source.length.toLocaleString()} 字素材` : "选填"}</small></span><ChevronDown aria-hidden="true" /></summary>
            <div className="screenplay-details-body">{field("tone", "叙事风格与限制", 2, "如：节奏紧凑、对白自然；需要保留或避免的内容")}{field("source", "原始素材", 6, "粘贴小说、已有剧本或参考文案，也可以从顶部导入文本文件")}</div>
        </details>
        </> : <section className="screenplay-form-section screenplay-outline" aria-label="故事大纲">
            <div className="screenplay-section-title"><span>{hasOutline ? "可直接编辑 · 保存后生效" : "在右侧生成大纲，或直接开始写作"}</span><span>{doc.outline.length.toLocaleString()} 字</span></div>
            {field("outline", "大纲正文", 16, "写下故事的起承转合，或在右侧生成故事大纲。")}
        </section>}
    </div>;
}

export function ScreenplayEpisodeEditor({ document: doc, episode, view, onViewChange, selectedSceneId, onSelectScene, onChange, onConfirmScenesSync, expandNovel = false }: { document: ScreenplayDocument; episode: ScreenplayEpisode; view: "novel" | "scenes"; onViewChange: (view: "novel" | "scenes") => void; selectedSceneId?: string; onSelectScene: (id: string) => void; onChange: (episode: ScreenplayEpisode) => void; onConfirmScenesSync: () => void; expandNovel?: boolean }) {
    const updateScene = (scene: ScreenplayScene) => onChange({ ...episode, scenes: episode.scenes.map((old) => old.id === scene.id ? scene : old) });
    const characters = doc.assets.filter((asset) => asset.kind === "character");
    return <div className="screenplay-episode-editor">
        <div className="screenplay-page-heading"><span className="screenplay-eyebrow">小说 {(episode.novelText?.length || 0).toLocaleString()} 字 · 分场 {episode.scenes.length} 场</span><label className="screenplay-episode-title"><Input aria-label="分集名称" value={episode.title} placeholder="分集名称" maxLength={200} onChange={(event) => onChange({ ...episode, title: event.target.value })} /><FilePenLine aria-hidden="true" /></label></div>
        <div className="screenplay-document-tabs" role="group" aria-label="分集编辑内容"><button type="button" aria-pressed={view === "novel"} onClick={() => onViewChange("novel")}><BookOpen aria-hidden="true" />小说正文</button><button type="button" aria-pressed={view === "scenes"} onClick={() => onViewChange("scenes")}><FileText aria-hidden="true" />分场剧本</button></div>
        <details className="screenplay-details" key={episode.id}>
            <summary><BookOpen aria-hidden="true" /><span>分集梗概与悬念</span><ChevronDown aria-hidden="true" /></summary>
            <div className="screenplay-details-body">
                <label className="screenplay-field"><span>本集梗概</span><Input.TextArea value={episode.synopsis} placeholder="这一集发生了什么，推动了怎样的变化？" autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event) => onChange({ ...episode, synopsis: event.target.value })} /></label>
                <div className="screenplay-form-grid">{([['hook', '开场钩子'], ['cliffhanger', '集尾悬念']] as const).map(([key, label]) => <label className="screenplay-field" key={key}><span>{label}</span><Input.TextArea value={episode[key]} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event) => onChange({ ...episode, [key]: event.target.value })} /></label>)}</div>
            </div>
        </details>
        {view === "novel" ? <section className="screenplay-form-section screenplay-novel" aria-label="本集完整小说正文">
            <div className="screenplay-section-title"><h2>本集完整小说正文</h2><span>{(episode.novelText?.length || 0).toLocaleString()} / {SCREENPLAY_NOVEL_LIMIT.toLocaleString()} 字</span></div>
            <label className="screenplay-field"><span>本集小说正文</span><Input.TextArea aria-label="本集小说正文" value={episode.novelText || ""} placeholder="粘贴或直接撰写本集完整小说；也可以在右侧由 AI 根据分集大纲展开正文。这里保存连续叙事与对白，梗概和分场剧本各自独立。" rows={18} autoSize={expandNovel ? { minRows: 18 } : false} maxLength={SCREENPLAY_NOVEL_LIMIT} onChange={(event) => onChange({ ...episode, novelText: event.target.value, scenesNeedAdaptation: episode.scenes.length ? true : episode.scenesNeedAdaptation })} /></label>
        </section> : <>
        {episode.scenesNeedAdaptation ? <Alert type="warning" showIcon title="小说正文已更新，现有分场仍保留" description="可在小说正文页重新改编，或手动校对分场；不会自动覆盖已有场次和分镜。" /> : null}
        <div className="screenplay-section-title"><h2>分场剧本</h2><span>{episode.scenes.length} 场</span></div>
        {!episode.scenes.length ? <div className="screenplay-empty"><h3>这一集还没有分场剧本</h3><p>{episode.novelText?.trim() ? "在右侧将本集小说改编为分场剧本。" : "先完成小说正文后改编，也可以手动添加场次。"}</p></div> : null}
        {episode.scenes.map((scene, sceneIndex) => <section key={scene.id} className="screenplay-scene" data-active={selectedSceneId === scene.id} onFocus={() => onSelectScene(scene.id)} onClick={() => onSelectScene(scene.id)}>
            <div className="screenplay-scene-heading"><span className="screenplay-scene-index">{String(sceneIndex + 1).padStart(2, "0")}</span><Input aria-label="场次名称" value={scene.title} maxLength={200} onChange={(event) => updateScene({ ...scene, title: event.target.value })} /><Button type="text" danger icon={<Trash2 className="size-4" />} aria-label={`删除场次${scene.title}`} onClick={() => onChange({ ...episode, scenes: episode.scenes.filter((item) => item.id !== scene.id) })} /></div>
            <div className="screenplay-scene-meta"><Select aria-label="场景资产" placeholder="选择场景" allowClear value={scene.locationId} onChange={(locationId) => updateScene({ ...scene, locationId })} options={doc.assets.filter((asset) => asset.kind === "location").map((asset) => ({ value: asset.id, label: asset.name }))} /><Input aria-label="场次时空" value={scene.timeOfDay} placeholder="日 / 内" maxLength={100} onChange={(event) => updateScene({ ...scene, timeOfDay: event.target.value })} /></div>
            <label className="screenplay-field"><span>出场人物</span><Select mode="multiple" aria-label="出场人物" value={scene.characterIds} onChange={(characterIds) => updateScene({ ...scene, characterIds })} options={characters.map((asset) => ({ value: asset.id, label: asset.name }))} /></label>
            {scene.beats.map((beat, beatIndex) => <div className="screenplay-beat" key={beat.id} data-kind={beat.kind}>
                <div className="screenplay-beat-meta"><span>{beat.kind === "action" ? "△ 动作" : "对白"}</span>{beat.kind === "dialogue" ? <><Select aria-label={`第${beatIndex + 1}段说话人`} value={beat.characterId} onChange={(characterId) => updateScene({ ...scene, beats: scene.beats.map((item) => item.id === beat.id ? { ...item, characterId } : item) })} options={[{ value: "VO", label: "旁白 / VO" }, ...characters.filter((asset) => scene.characterIds.includes(asset.id)).map((asset) => ({ value: asset.id, label: asset.name }))]} /><Input aria-label="对白语气" placeholder="语气（选填）" maxLength={500} value={beat.delivery || ""} onChange={(event) => updateScene({ ...scene, beats: scene.beats.map((item) => item.id === beat.id ? { ...item, delivery: event.target.value } : item) })} /></> : null}<Button type="text" aria-label={`删除第${beatIndex + 1}段`} icon={<Trash2 className="size-3.5" />} onClick={() => updateScene({ ...scene, beats: scene.beats.filter((item) => item.id !== beat.id) })} /></div>
                <Input.TextArea aria-label={`第${beatIndex + 1}段${beat.kind === "action" ? "动作" : "对白"}`} value={beat.text} autoSize={{ minRows: 2, maxRows: 12 }} onChange={(event) => updateScene({ ...scene, beats: scene.beats.map((item) => item.id === beat.id ? { ...item, text: event.target.value } : item) })} />
            </div>)}
            <div className="screenplay-actions"><Button size="small" className="screenplay-secondary-action" icon={<Plus className="size-4" />} onClick={() => updateScene({ ...scene, beats: [...scene.beats, { id: nanoid(), kind: "action", text: "" }] })}>添加动作</Button><Button size="small" className="screenplay-secondary-action" icon={<Plus className="size-4" />} onClick={() => updateScene({ ...scene, beats: [...scene.beats, { id: nanoid(), kind: "dialogue", characterId: scene.characterIds[0] || "VO", text: "" }] })}>添加对白</Button></div>
        </section>)}
        <Button block type="dashed" className="screenplay-secondary-action" icon={<Plus className="size-4" />} onClick={() => { const scene = emptyScene(); onChange({ ...episode, scenes: [...episode.scenes, scene] }); onSelectScene(scene.id); }}>添加场次</Button>
        {episode.scenesNeedAdaptation && episode.scenes.length ? <Button className="screenplay-secondary-action" onClick={onConfirmScenesSync}>已手动校对分场，保存并标记同步</Button> : null}
        </>}
    </div>;
}
