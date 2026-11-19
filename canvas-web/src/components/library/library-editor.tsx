import { useState } from "react";
import { App, Button, Input, InputNumber, Modal, Select, Switch, Upload } from "antd";
import { Upload as UploadIcon } from "lucide-react";
import { saveLibraryItem, type LibraryInput, type LibraryItem, type LibraryKind, type LibraryPayload } from "@/services/api/library";
import { uploadResourceFile } from "@/services/api/resources";
import type { InsertAssetPayload } from "@/types/asset-insertion";
import "@/pages/teams/teams.css";

export const libraryKinds = [{ value: "template", label: "画布模板" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }, { value: "text", label: "文本" }, { value: "character", label: "虚拟人像模板" }];
export function LibraryEditor({ item, initial, teamId = "", onClose, onSaved }: { item: LibraryItem | null; initial?: Partial<LibraryInput>; teamId?: string; onClose: () => void; onSaved: () => void }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<LibraryInput>({ teamId, kind: item?.kind || "image", name: item?.name || "", category: item?.category || "", tags: item?.tags || "", coverResourceId: item?.coverResourceId || "", payload: item?.payloadJson ? JSON.parse(item.payloadJson) : {}, published: item?.published || false, sortOrder: item?.sortOrder || 0, ...initial });
    const [json, setJson] = useState(JSON.stringify(draft.payload, null, 2)); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0);
    const template = draft.kind === "template" || draft.kind === "character";
    const save = async () => { setBusy(true); try { const payload = template ? JSON.parse(json) as LibraryPayload : draft.payload; if (payload.asset) payload.asset.title = draft.name; await saveLibraryItem(item?.id, { ...draft, payload }); message.success("素材已保存"); onSaved(); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } };
    const upload = async (file: File, cover: boolean) => {
        setBusy(true); setProgress(0);
        try {
            const kind = cover ? "image" : draft.kind as "image" | "video" | "audio";
            if (!file.type.startsWith(`${kind}/`)) throw new Error(`请选择${cover ? "图片封面" : libraryKinds.find((k) => k.value === kind)?.label}文件`);
            const resource = await uploadResourceFile(file, kind, { fileName: file.name, onProgress: setProgress });
            setDraft((v) => {
                if (cover) return { ...v, coverResourceId: resource.id };
                const storageKey = `resource:${resource.id}`;
                const asset: InsertAssetPayload = kind === "image" ? { kind, title: v.name || file.name, storageKey, dataUrl: storageKey } : { kind, title: v.name || file.name, storageKey, url: storageKey, width: resource.width, height: resource.height, durationMs: resource.durationMs, bytes: resource.size, mimeType: resource.mimeType };
                return { ...v, name: v.name || file.name, coverResourceId: kind === "image" ? resource.id : v.coverResourceId, payload: { asset } };
            });
            message.success("文件已归档，保存条目后可使用");
        } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
        return false;
    };
    return <Modal title={item ? "编辑素材" : "添加素材"} open onCancel={onClose} onOk={() => void save()} confirmLoading={busy} okButtonProps={{ disabled: !draft.name.trim() }} width={720} destroyOnHidden><div className="team-form">
        <label>名称<Input maxLength={240} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>类型<Select disabled={!!item} value={draft.kind} options={libraryKinds} onChange={(kind: LibraryKind) => { setDraft({ ...draft, kind, payload: {}, coverResourceId: "" }); setJson('{"nodes":[],"connections":[]}'); }} /></label>
        <div className="grid grid-cols-2 gap-4"><label>分类<Input value={draft.category} maxLength={100} onChange={(e) => setDraft({ ...draft, category: e.target.value })} /></label><label>标签<Input value={draft.tags} maxLength={1000} placeholder="用空格分隔" onChange={(e) => setDraft({ ...draft, tags: e.target.value })} /></label></div>
        {template ? <label>画布模板 JSON<Input.TextArea rows={9} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} /></label> : draft.kind === "text" ? <label>文本内容<Input.TextArea rows={6} value={draft.payload.asset?.kind === "text" ? draft.payload.asset.content : ""} onChange={(e) => setDraft({ ...draft, payload: { asset: { kind: "text", content: e.target.value, title: draft.name } } })} /></label> : <label>素材文件<Upload showUploadList={false} beforeUpload={(f) => upload(f, false)} accept={`${draft.kind}/*`} disabled={busy}><Button icon={<UploadIcon size={16} />} loading={busy}>上传{busy ? ` ${progress}%` : "文件"}</Button></Upload><span className="team-muted">{draft.payload.asset ? "文件已归档" : "尚未上传"}</span></label>}
        <label>封面<Upload accept="image/*" beforeUpload={(f) => upload(f, true)} showUploadList={false} disabled={busy}><Button icon={<UploadIcon size={16} />}>{draft.coverResourceId ? "更换封面" : "上传封面"}</Button></Upload></label>
        <div className="grid grid-cols-2 gap-4"><label>排序权重（越大越靠前）<InputNumber precision={0} value={draft.sortOrder} onChange={(v) => setDraft({ ...draft, sortOrder: v || 0 })} /></label><label>发布<Switch checked={draft.published} onChange={(published) => setDraft({ ...draft, published })} /></label></div>
    </div></Modal>;
}
