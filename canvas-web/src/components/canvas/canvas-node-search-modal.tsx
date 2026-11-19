import { useMemo, useState } from "react";
import { Input, Modal } from "antd";
import { ArrowUpRight, BookOpenText, Clapperboard, FileText, Frame, Image, Music2, Pencil, Search, Settings2, Sparkles, Video, X } from "lucide-react";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import "./canvas-node-search-modal.css";

const nodeIcons = {
    [CanvasNodeType.Image]: Image,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Drawing]: Pencil,
    [CanvasNodeType.Text]: FileText,
    [CanvasNodeType.Script]: Clapperboard,
    [CanvasNodeType.Skill]: Sparkles,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Frame]: Frame,
};

export function CanvasNodeSearchModal({ open, nodes, onClose, onFocus }: { open: boolean; nodes: CanvasNodeData[]; onClose: () => void; onFocus: (nodeId: string) => void }) {
    const [query, setQuery] = useState("");
    const results = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        if (!keyword) return nodes.slice(0, 40);
        return nodes.filter((node) => [node.title, node.type, nodeTypeLabel(node.type), node.metadata?.prompt, node.metadata?.composerContent, node.metadata?.model, node.metadata?.chapterTitle, node.metadata?.workflowTitle, node.metadata?.workflowDescription, typeof node.metadata?.shotIndex === "number" ? `镜头 ${node.metadata.shotIndex + 1}` : "", ...(node.metadata?.assetTags || [])]
            .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(keyword))).slice(0, 80);
    }, [nodes, query]);

    return (
        <Modal
            title={<span className="canvas-node-search-heading">搜索画布节点<span className="canvas-node-search-total">{nodes.length} 个节点</span></span>}
            className="canvas-node-search-modal"
            open={open}
            footer={null}
            width="min(var(--canvas-search-width), calc(100vw - var(--space-8)))"
            styles={{ container: { padding: 0 }, header: { margin: 0, padding: "var(--space-5) var(--space-5) var(--space-4)" }, body: { padding: 0 } }}
            closeIcon={<X className="size-4" />}
            onCancel={onClose}
            afterClose={() => setQuery("")}
            centered
        >
            <div className="canvas-node-search-field" data-canvas-no-zoom>
                <Input
                    autoFocus
                    allowClear
                    variant="borderless"
                    className="canvas-node-search-input"
                    aria-label="搜索节点、章节、镜头、模型或标签"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    prefix={<Search className="size-4" aria-hidden />}
                    placeholder="搜索节点、章节、镜头、模型或标签"
                />
            </div>
            <div className="canvas-node-search-list-label" aria-live="polite">
                <span>{query.trim() ? "搜索结果" : "当前画布"}</span>
                <span>{!query.trim() && nodes.length > 40 ? "展示前 40 项" : query.trim() && results.length === 80 ? "展示前 80 项" : `${results.length} 项`}</span>
            </div>
            <div className="canvas-node-search-results thin-scrollbar" data-canvas-no-zoom data-canvas-wheel-scroll>
                {results.length ? results.map((node) => {
                    const Icon = nodeIcons[node.type] || FileText;
                    return (
                        <button
                            key={node.id}
                            type="button"
                            className="canvas-node-search-result"
                            onClick={() => { onFocus(node.id); onClose(); }}
                        >
                            <span className="canvas-node-search-icon" aria-hidden>
                                <Icon className="size-4" />
                            </span>
                            <span className="canvas-node-search-copy">
                                <span className="canvas-node-search-name">{node.title || nodeTypeLabel(node.type)}</span>
                                <span className="canvas-node-search-context">
                                    {node.metadata?.chapterTitle ? <BookOpenText className="size-3 shrink-0" /> : null}
                                    <span className="truncate">{nodeContextLabel(node)}</span>
                                </span>
                            </span>
                            <span className="canvas-node-search-type">{nodeTypeLabel(node.type).replace(/节点$/, "")}</span>
                            <ArrowUpRight className="canvas-node-search-locate size-4" aria-hidden />
                        </button>
                    );
                }) : (
                    <div className="canvas-node-search-empty">
                        <Search className="size-6" aria-hidden />
                        <strong>{nodes.length ? "没有找到匹配节点" : "画布还没有节点"}</strong>
                        <span>{nodes.length ? "试试节点名称、模型或标签" : "添加节点后，可在这里快速查找"}</span>
                    </div>
                )}
            </div>
            <div className="canvas-node-search-footer">
                <span><ArrowUpRight className="size-3.5" aria-hidden />点击结果定位节点</span>
                <span><kbd>Esc</kbd>关闭</span>
            </div>
        </Modal>
    );
}

function nodeContextLabel(node: CanvasNodeData) {
    const location = [node.metadata?.chapterTitle, typeof node.metadata?.shotIndex === "number" ? `镜头 ${node.metadata.shotIndex + 1}` : ""].filter(Boolean).join(" · ");
    return location || node.metadata?.prompt || node.metadata?.composerContent || node.metadata?.workflowDescription || nodeTypeLabel(node.type);
}

function nodeTypeLabel(type: CanvasNodeType) {
    return ({
        [CanvasNodeType.Image]: "图片节点",
        [CanvasNodeType.Text]: "文本节点",
        [CanvasNodeType.Drawing]: "绘图节点",
        [CanvasNodeType.Script]: "分镜脚本节点",
        [CanvasNodeType.Skill]: "技能节点",
        [CanvasNodeType.Config]: "生成配置节点",
        [CanvasNodeType.Video]: "视频节点",
        [CanvasNodeType.Audio]: "音频节点",
        [CanvasNodeType.Frame]: "背板",
    } as Record<CanvasNodeType, string>)[type] || "未知节点";
}
