import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Button, Drawer, Dropdown, Empty, Input, Modal, Select } from "antd";
import type { MenuProps } from "antd";
import { Check, FilePenLine, Image as ImageIcon, Link2, RefreshCw, Video } from "lucide-react";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { composeStoryboardPrompt, editableStoryboardPrompt } from "@/lib/canvas/canvas-storyboard-prompts";
import type { StoryboardColorMark, StoryboardRow } from "@/types/canvas";

type StoryboardMarkOption = {
    value: StoryboardColorMark;
    label: string;
    dotClassName: string;
};

export const STORYBOARD_MARK_OPTIONS: StoryboardMarkOption[] = [
    { value: "red", label: "红色", dotClassName: "bg-red-500" },
    { value: "orange", label: "橙色", dotClassName: "bg-orange-500" },
    { value: "yellow", label: "黄色", dotClassName: "bg-yellow-400" },
    { value: "green", label: "绿色", dotClassName: "bg-emerald-500" },
    { value: "blue", label: "蓝色", dotClassName: "bg-blue-500" },
    { value: "purple", label: "紫色", dotClassName: "bg-violet-500" },
];

export function StoryboardMarkButton({ value, onChange }: { value?: StoryboardColorMark; onChange: (value?: StoryboardColorMark) => void }) {
    const selected = STORYBOARD_MARK_OPTIONS.find((option) => option.value === value);
    const items: MenuProps["items"] = [
        { key: "none", label: "无标记", onClick: () => onChange(undefined) },
        { type: "divider" },
        ...STORYBOARD_MARK_OPTIONS.map((option) => ({
            key: option.value,
            label: <span className="flex items-center gap-2"><span className={`size-2.5 rounded-full ${option.dotClassName}`} />{option.label}</span>,
            onClick: () => onChange(option.value),
        })),
    ];
    return (
        <Dropdown menu={{ items }} trigger={["click"]} placement="bottomLeft">
            <button
                type="button"
                className="grid size-7 place-items-center rounded outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10"
                title={selected ? `${selected.label}标记` : "设置颜色标记"}
                aria-label={selected ? `当前${selected.label}标记，点击修改` : "设置颜色标记"}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
            >
                <span className={`size-2.5 rounded-full border ${selected?.dotClassName || "border-foreground/25 bg-transparent"}`} />
            </button>
        </Dropdown>
    );
}

export function StoryboardMarkSelect({ value, onChange }: { value?: StoryboardColorMark; onChange: (value?: StoryboardColorMark) => void }) {
    return (
        <Select<StoryboardColorMark | "none">
            className="w-full"
            size="small"
            value={value || "none"}
            options={[
                { value: "none", label: "无标记" },
                ...STORYBOARD_MARK_OPTIONS.map((option) => ({ value: option.value, label: <span className="flex items-center gap-2"><span className={`size-2.5 rounded-full ${option.dotClassName}`} />{option.label}</span> })),
            ]}
            onChange={(next) => onChange(next === "none" ? undefined : next)}
        />
    );
}

export function StoryboardPromptEditorModal({ row, onClose, onSave }: { row: StoryboardRow | null; onClose: () => void; onSave: (rowId: string, patch: Pick<StoryboardRow, "imageGenerationPrompt" | "videoMotionPrompt">) => void }) {
    const [imagePrompt, setImagePrompt] = useState("");
    const [videoPrompt, setVideoPrompt] = useState("");
    useEffect(() => {
        if (!row) return;
        setImagePrompt(editableStoryboardPrompt(row, "image"));
        setVideoPrompt(editableStoryboardPrompt(row, "video"));
    }, [row]);
    return (
        <Modal
            title={row ? `镜头 ${row.shotNumber} · 最终提示词` : "最终提示词"}
            open={Boolean(row)}
            onCancel={onClose}
            width="min(760px, calc(100vw - 32px))"
            destroyOnHidden
            footer={[
                <Button key="reset" icon={<RefreshCw className="size-4" />} disabled={!row} onClick={() => {
                    if (!row) return;
                    setImagePrompt(composeStoryboardPrompt(row, "image"));
                    setVideoPrompt(composeStoryboardPrompt(row, "video"));
                }}>重新合成</Button>,
                <Button key="cancel" onClick={onClose}>取消</Button>,
                <Button key="save" type="primary" disabled={!row || (!imagePrompt.trim() && !videoPrompt.trim())} onClick={() => {
                    if (!row) return;
                    onSave(row.id, { imageGenerationPrompt: imagePrompt.trim(), videoMotionPrompt: videoPrompt.trim() });
                    onClose();
                }}>保存提示词</Button>,
            ]}
        >
            <div className="grid gap-4">
                <label className="grid gap-1.5">
                    <span className="flex items-center gap-2 text-sm font-semibold"><ImageIcon className="size-4" />图片最终提示词</span>
                    <Input.TextArea value={imagePrompt} autoSize={{ minRows: 5, maxRows: 10 }} placeholder="填写生成分镜图时使用的最终提示词" onChange={(event) => setImagePrompt(event.target.value)} />
                </label>
                <label className="grid gap-1.5">
                    <span className="flex items-center gap-2 text-sm font-semibold"><Video className="size-4" />视频最终提示词</span>
                    <Input.TextArea value={videoPrompt} autoSize={{ minRows: 5, maxRows: 10 }} placeholder="填写生成视频时使用的最终提示词" onChange={(event) => setVideoPrompt(event.target.value)} />
                </label>
            </div>
        </Modal>
    );
}

export function StoryboardAssetDrawer({ open, references, targetRowIds, onClose, onAutoLink, onAssignReferences }: {
    open: boolean;
    references: CanvasResourceReference[];
    targetRowIds: string[];
    onClose: () => void;
    onAutoLink: () => void;
    onAssignReferences: (referenceNodeIds: string[]) => void;
}) {
    const [query, setQuery] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
    useEffect(() => {
        if (!open) {
            setQuery("");
            setSelectedIds([]);
        }
    }, [open]);
    const filteredReferences = useMemo(() => deferredQuery
        ? references.filter((reference) => `${reference.title} ${reference.label} ${(reference.aliases || []).join(" ")}`.toLocaleLowerCase().includes(deferredQuery))
        : references, [deferredQuery, references]);
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const toggleReference = (referenceId: string) => setSelectedIds((current) => current.includes(referenceId) ? current.filter((id) => id !== referenceId) : [...current, referenceId]);
    return (
        <Drawer
            className="library-drawer"
            title="脚本素材"
            open={open}
            size="min(440px, 100vw)"
            destroyOnHidden
            onClose={onClose}
            extra={<Button icon={<Link2 className="size-4" />} disabled={!targetRowIds.length} onClick={onAutoLink}>智能关联</Button>}
            footer={<div className="flex items-center justify-between gap-3"><span className="text-xs text-foreground/55">将素材关联到 {targetRowIds.length} 个镜头</span><Button type="primary" disabled={!selectedIds.length || !targetRowIds.length} onClick={() => { onAssignReferences(selectedIds); setSelectedIds([]); }}>关联所选素材</Button></div>}
        >
            <Input.Search allowClear placeholder="搜索角色、场景、道具或素材" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="mt-3 grid gap-1">
                {filteredReferences.length ? filteredReferences.map((reference) => (
                    <button
                        key={reference.id}
                        type="button"
                        aria-pressed={selectedSet.has(reference.nodeId)}
                        className="flex min-h-14 w-full items-center gap-3 rounded-md border border-transparent px-2 py-1.5 text-left outline-none transition hover:border-foreground/10 hover:bg-foreground/5 focus-visible:ring-2 aria-pressed:border-primary/30 aria-pressed:bg-primary/5"
                        onClick={() => toggleReference(reference.nodeId)}
                    >
                        {reference.previewUrl ? <img className="size-11 shrink-0 rounded object-cover" src={reference.previewUrl} alt="" loading="lazy" /> : <span className="grid size-11 shrink-0 place-items-center rounded bg-foreground/5"><FilePenLine className="size-4" /></span>}
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{reference.title || reference.label}</span><span className="block truncate text-xs text-foreground/50">{resourceKindLabel(reference)}</span></span>
                        <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${selectedSet.has(reference.nodeId) ? "border-primary bg-primary" : "border-foreground/20"}`}>{selectedSet.has(reference.nodeId) ? <Check className="size-3 text-primary-foreground" /> : null}</span>
                    </button>
                )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配素材" />}
            </div>
        </Drawer>
    );
}

function resourceKindLabel(reference: CanvasResourceReference) {
    const labels: Record<CanvasResourceReference["kind"], string> = { image: "图片", video: "视频", audio: "音频", text: "文本", skill: "技能", character: "角色" };
    return labels[reference.kind];
}
