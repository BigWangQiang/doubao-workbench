import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "antd";
import { Maximize } from "lucide-react";
import { InfiniteCanvas } from "./infinite-canvas";
import { ConnectionPath } from "./canvas-connections";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { ViewportTransform } from "@/types/canvas";

/** 只读预览保留节点空间关系；拖动与缩放仅改变本次浏览视图，不写入项目。 */
export function TeamCanvasPreview({ project }: { project: CanvasProject }) {
    const container = useRef<HTMLDivElement>(null);
    const fitted = useRef("");
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const nodes = useMemo(() => project.nodes.map((node) => {
        const key = resourceIdFromStorageKey(node.metadata?.storageKey);
        return { ...node, metadata: { ...node.metadata, content: key ? resourceFileUrl(key) : node.metadata?.content } };
    }), [project.nodes]);
    const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
    const fit = () => {
        const rect = container.current?.getBoundingClientRect();
        if (!rect || !nodes.length) return;
        const left = Math.min(...nodes.map((n) => n.position.x));
        const top = Math.min(...nodes.map((n) => n.position.y));
        const width = Math.max(...nodes.map((n) => n.position.x + n.width)) - left;
        const height = Math.max(...nodes.map((n) => n.position.y + n.height)) - top;
        const k = Math.max(0.05, Math.min(1, rect.width / (width + 160), rect.height / (height + 160)));
        setViewport({ k, x: (rect.width - width * k) / 2 - left * k, y: (rect.height - height * k) / 2 - top * k });
    };
    useEffect(() => { if (fitted.current !== project.id && nodes.length) { fitted.current = project.id; fit(); } }, [project.id, nodes]);
    return <div className="team-canvas-preview">
        <InfiniteCanvas containerRef={container} viewport={viewport} onViewportChange={setViewport} panOverNodes onDrop={(e) => e.preventDefault()}>
            <svg className="team-preview-lines">{project.connections.map((connection) => {
                const from = byId.get(connection.fromNodeId), to = byId.get(connection.toNodeId);
                return from && to ? <ConnectionPath key={connection.id} connection={connection} from={from} to={to} active={false} onSelect={() => undefined} /> : null;
            })}</svg>
            {nodes.map((node) => <article key={node.id} className={`team-preview-node${node.type === "frame" ? " is-frame" : ""}`} style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height }}>
                <h2>{node.title || "未命名节点"}</h2>
                {node.type === "frame" ? null : node.type === "image" && node.metadata.content ? <img src={node.metadata.content} alt={node.title} loading="lazy" /> : node.type === "video" && node.metadata.content ? <video data-canvas-no-zoom src={node.metadata.content} controls preload="metadata" /> : node.type === "audio" && node.metadata.content ? <audio data-canvas-no-zoom src={node.metadata.content} controls /> : <p>{node.metadata.content || node.metadata.prompt || "尚未生成"}</p>}
            </article>)}
        </InfiniteCanvas>
        {!nodes.length && <div className="team-preview-empty">画布还没有内容</div>}
        <div className="team-preview-tools"><span>{Math.round(viewport.k * 100)}%</span><Button icon={<Maximize size={16} />} onClick={fit}>适应画布</Button></div>
    </div>;
}
