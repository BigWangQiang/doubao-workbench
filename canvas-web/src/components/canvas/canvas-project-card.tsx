import { Check, Clapperboard, Download, FileText, Frame, Image as ImageIcon, MoreHorizontal, Music2, Pencil, Plus, Settings2, Sparkles, Trash2, Video, X } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Dropdown, Input } from "antd";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveBackendApiUrl } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

export function CanvasCreateCard({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
    return <button type="button" className="app-canvas-create-card" disabled={disabled} onClick={onClick}>
        <span className="app-canvas-create-preview"><Plus className="app-canvas-create-icon" /><span className="app-canvas-create-label">开始创作</span></span>
        <span className="app-canvas-create-title">创建画布</span>
    </button>;
}

export function CanvasProjectCard({ project, projectName, variant = "library", readOnly = false, footer }: { project: CanvasProject; projectName?: string; variant?: "library" | "recent" | "gallery"; readOnly?: boolean; footer?: ReactNode }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const open = () => navigate(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };

    const compact = variant === "recent";
    const gallery = variant === "gallery";
    return (
        <article className={cn("app-canvas-project-card group h-full cursor-pointer", gallery ? "is-gallery" : compact ? "is-recent" : "is-library", selected && "is-selected")} onClick={() => (!editing || readOnly) && open()}>
            <div className="app-canvas-project-preview relative">
                <button
                    type="button"
                    className={cn("canvas-project-preview-button block w-full overflow-hidden text-left", compact ? "aspect-[16/10]" : "aspect-video")}
                    onClick={(event) => {
                        event.stopPropagation();
                        open();
                    }}
                >
                    <ProjectPreview project={project} gallery={gallery} />
                </button>
                {!compact && !readOnly ? <span className={`canvas-project-select ${selected ? "is-visible" : ""}`} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected} onChange={(event) => toggleSelected(project.id, event.target.checked)} className="app-canvas-project-checkbox" aria-label={`选择 ${project.title}`} /></span> : null}
                {!gallery ? <div className="canvas-project-cover-meta" aria-hidden="true"><span className="canvas-project-node-count">{project.nodes.length} 节点</span></div> : null}
            </div>

            <div className={cn("app-canvas-project-body", compact ? "is-compact" : "")}>
                <div className="canvas-project-heading-row">
                    {editing && !readOnly ? (
                        <Input className="canvas-project-title-input" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
                    ) : (
                        <button
                            type="button"
                            className="canvas-project-title-button"
                            onClick={(event) => {
                                event.stopPropagation();
                                open();
                            }}
                        >
                            <h2>{project.title}</h2>
                        </button>
                    )}
                    {editing && !readOnly ? (
                        <div className="canvas-project-actions" onClick={(event) => event.stopPropagation()}>
                            <button type="button" onClick={saveTitle} aria-label="保存名称"><Check className="size-3.5" /></button>
                            <button type="button" onClick={stopEditing} aria-label="取消重命名"><X className="size-3.5" /></button>
                        </div>
                    ) : !readOnly && !gallery ? (
                        <div className="canvas-project-actions" onClick={(event) => event.stopPropagation()}>
                            <button type="button" onClick={() => startEditing(project.id, project.title)} aria-label={`重命名 ${project.title}`} title="重命名"><Pencil className="size-3.5" /></button>
                            <Dropdown
                                trigger={["click"]}
                                menu={{
                                    onClick: ({ domEvent }) => domEvent.stopPropagation(),
                                    items: [
                                        { key: "export", icon: <Download className="size-3.5" />, label: "导出画布", onClick: () => void exportCanvasProjects([project], project.title || "Lalor画布") },
                                        { type: "divider" },
                                        { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: "删除", onClick: () => setDeleteIds([project.id]) },
                                    ],
                                }}
                            >
                                <button type="button" aria-label={`${project.title} 画布操作`} title="更多操作"><MoreHorizontal className="size-4" /></button>
                            </Dropdown>
                        </div>
                    ) : !readOnly ? (
                        <div className="canvas-project-actions is-always-visible" onClick={(event) => event.stopPropagation()}>
                            <Dropdown
                                trigger={["click"]}
                                menu={{
                                    onClick: ({ domEvent }) => domEvent.stopPropagation(),
                                    items: [
                                        { key: "rename", icon: <Pencil className="size-3.5" />, label: "重命名", onClick: () => startEditing(project.id, project.title) },
                                        { key: "export", icon: <Download className="size-3.5" />, label: "导出画布", onClick: () => void exportCanvasProjects([project], project.title || "Lalor画布") },
                                        { type: "divider" },
                                        { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: "删除", onClick: () => setDeleteIds([project.id]) },
                                    ],
                                }}
                            >
                                <button type="button" aria-label={`${project.title} 画布操作`} title="更多操作"><MoreHorizontal className="size-4" /></button>
                            </Dropdown>
                        </div>
                    ) : null}
                </div>
                {gallery ? <time className="canvas-project-date" dateTime={project.updatedAt}>{formatProjectDate(project.updatedAt)}</time> : <div className="canvas-project-stats"><span>{projectName || "自由画布"}</span><span aria-hidden="true">·</span><time dateTime={project.updatedAt}>{formatProjectTime(project.updatedAt)}</time></div>}
                {footer ? <div className="canvas-project-card-footer" onClick={(event) => event.stopPropagation()}>{footer}</div> : null}
            </div>
        </article>
    );
}

function ProjectPreview({ project, gallery = false }: { project: CanvasProject; gallery?: boolean }) {
    const emptyCover = <div className="canvas-project-empty size-full"><ImageIcon className="canvas-project-empty-icon" aria-hidden="true" /></div>;
    const mediaNodes = project.nodes
        .flatMap((node) => {
            if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) return [];
            const sourceUrl = getNodeMediaUrl(node);
            const storageKey = node.metadata?.storageKey;
            // 工作台资源通过本机协议读取；持久化图片不能只凭旧 blob 地址筛掉。
            const storedImage = node.type === CanvasNodeType.Image && (resourceIdFromStorageKey(storageKey) || storageKey?.startsWith("image:"));
            return storedImage || isPreviewUrl(sourceUrl) ? [{ node, url: sourceUrl }] : [];
        });
    const media = mediaNodes.find(({ node }) => node.type === CanvasNodeType.Image) || mediaNodes[0];
    if (media) {
        const { node, url } = media;
        return (
            <div className="canvas-project-media size-full">
                {node.type === CanvasNodeType.Video
                    ? <div className="canvas-project-video size-full"><Video className="size-8" aria-label={node.title || "项目视频"} /></div>
                    : <CachedResourceImage key={node.id} storageKey={node.metadata?.storageKey} src={url} alt={node.title || "画布图片封面"} loading="lazy" decoding="async" className="size-full min-h-0 object-cover" fallback={<div className="canvas-project-empty size-full" role="img" aria-label="画布封面暂时无法读取"><ImageIcon className="canvas-project-empty-icon" aria-hidden="true" /></div>} loadingFallback={emptyCover} />}
            </div>
        );
    }
    const nodes = project.nodes.slice(0, 8);
    if (gallery || !nodes.length) return emptyCover;
    const previewNodes = buildNodePreviewLayout(nodes);

    return (
        <div className="canvas-project-preview-canvas relative size-full overflow-hidden">
            {previewNodes.map(({ node, style }) => {
                const presentation = getNodePresentation(node);
                return (
                    <span key={node.id} className="canvas-project-preview-node absolute flex min-w-0 items-center gap-1.5 overflow-hidden" style={style}>
                        <span className="canvas-project-preview-node-icon">{presentation.icon}</span>
                        <span className="canvas-project-preview-node-label">{node.title || presentation.label}</span>
                    </span>
                );
            })}
        </div>
    );
}

function getNodeMediaUrl(node: CanvasNodeData) {
    const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
    if (resourceId) return resourceFileUrl(resourceId);
    return resolveBackendApiUrl(node.metadata?.content || "");
}

function buildNodePreviewLayout(nodes: CanvasNodeData[]) {
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const maxX = Math.max(...nodes.map((node) => node.position.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.position.y + node.height));
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    return nodes.map((node) => {
        const left = 6 + ((node.position.x - minX) / spanX) * 70;
        const top = 8 + ((node.position.y - minY) / spanY) * 66;
        const width = Math.min(92 - left, Math.max(16, Math.min(38, (node.width / spanX) * 78)));
        const height = Math.min(94 - top, Math.max(13, Math.min(24, (node.height / spanY) * 72)));
        return { node, style: { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` } };
    });
}

function getNodePresentation(node: CanvasNodeData) {
    switch (node.type) {
        case CanvasNodeType.Text:
            return { label: "文本", icon: <FileText className="size-3.5" /> };
        case CanvasNodeType.Script:
            return { label: "分镜脚本", icon: <Clapperboard className="size-3.5" /> };
        case CanvasNodeType.Image:
            return { label: "图片", icon: <ImageIcon className="size-3.5" /> };
        case CanvasNodeType.Video:
            return { label: "视频", icon: <Video className="size-3.5" /> };
        case CanvasNodeType.Audio:
            return { label: "音频", icon: <Music2 className="size-3.5" /> };
        case CanvasNodeType.Drawing:
            return { label: "绘图", icon: <Pencil className="size-3.5" /> };
        case CanvasNodeType.Frame:
            return { label: "背板", icon: <Frame className="size-3.5" /> };
        case CanvasNodeType.Config:
            return { label: "生成配置", icon: <Settings2 className="size-3.5" /> };
        default:
            return { label: "技能", icon: <Sparkles className="size-3.5" /> };
    }
}

function isPreviewUrl(value?: string) {
    return Boolean(value && (/^(https?:|blob:|data:image\/|data:video\/|\/api\/|lalor-canvas:\/\/resources\/)/.test(value)));
}

function formatProjectTime(value: string) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "刚刚修改";
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "刚刚修改";
    if (minutes < 60) return `${minutes} 分钟前修改`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前修改`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前修改`;
    return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " 修改";
}

function formatProjectDate(value: string) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "---- -- --";
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
