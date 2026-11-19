import { BookOpen, CheckCircle2, ChevronRight, FilePenLine, LoaderCircle } from "lucide-react";
import { screenplayBusy } from "@/lib/canvas/canvas-screenplay";
import type { CanvasNodeData } from "@/types/canvas";
import "./canvas-screenplay.css";

export function CanvasScreenplayNode({ node, onOpen }: { node: CanvasNodeData; onOpen: () => void }) {
    const workflow = node.metadata!.screenplay!, doc = workflow.document;
    const count = doc.episodes.flatMap((episode) => episode.scenes).length;
    const busy = screenplayBusy(workflow);
    return <div className="screenplay-node">
        <div className="screenplay-node-heading"><FilePenLine aria-hidden="true" /><span>剧本工作区</span><span className="screenplay-node-status">{busy ? <LoaderCircle className="animate-spin" /> : workflow.approvedRevision === doc.revision ? <CheckCircle2 /> : <BookOpen />}{busy ? "创作中" : workflow.approvedRevision === doc.revision ? "已确认" : "草稿"}</span></div>
        <h3>{doc.title}</h3><p>{doc.outline || doc.brief || "从一个故事想法，开始写出可制作的剧本。"}</p>
        <div className="screenplay-node-metrics"><span>{doc.episodes.length} 集</span><span>{count} 场</span><span>{doc.assets.filter((asset) => asset.kind === "character").length} 位人物</span></div>
        {workflow.task?.error ? <span className="screenplay-node-error">{workflow.task.error}</span> : null}
        <button type="button" className="screenplay-node-open" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpen(); }}>打开剧本<ChevronRight aria-hidden="true" /></button>
    </div>;
}
