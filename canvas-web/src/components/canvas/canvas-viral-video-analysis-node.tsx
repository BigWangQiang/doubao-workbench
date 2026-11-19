import { Button, Progress } from "antd";
import { AlertCircle, ArrowUpRight, Check, Clapperboard, FileText, GripVertical, ScanEye } from "lucide-react";
import { viralVideoAnalysisErrorMessage } from "@/lib/canvas/canvas-viral-video";
import type { CanvasNodeData } from "@/types/canvas";
import "./canvas-viral-video.css";

export function CanvasViralVideoAnalysisNode({ node, onOpen }: { node: CanvasNodeData; onOpen: () => void }) {
    const workflow = node.metadata?.viralVideo;
    if (!workflow) return null;
    const busy = workflow.stage === "sampling" || workflow.stage === "analyzing";
    const labels = { sampling: "准备视频素材", analyzing: "AI 正在反推视频", ready: "复刻方案已就绪", error: "分析需要处理" };
    const StatusIcon = workflow.stage === "ready" ? Check : workflow.stage === "error" ? AlertCircle : ScanEye;
    const progress = Math.min(100, Math.max(0, workflow.progress || 0));
    return (
        // 卡片内容属于拖动区域；仅按钮隔离指针事件，不能把整张卡标为 no-zoom。
        <div className="canvas-viral-analysis" data-stage={workflow.stage}>
            <div className="canvas-viral-analysis-heading">
                <span className="canvas-viral-status-icon"><StatusIcon className="size-5" aria-hidden="true" /></span>
                <div className="min-w-0"><span className="canvas-viral-eyebrow">爆款复刻</span><h3>{labels[workflow.stage]}</h3></div>
            </div>
            {busy ? <div className="canvas-viral-analysis-progress"><div><span>{workflow.stage === "sampling" ? "提取参考画面" : "整片提示词与分镜"}</span><strong>{workflow.progress === undefined ? "进行中" : `${progress}%`}</strong></div><Progress percent={progress} status="active" showInfo={false} strokeColor="var(--viral-accent)" railColor="var(--viral-track)" aria-label="视频分析进度" /></div> : null}
            <p className="canvas-viral-analysis-summary" role={workflow.error ? "alert" : undefined} title={workflow.error ? viralVideoAnalysisErrorMessage(workflow.error) : undefined}>
                {(workflow.error ? viralVideoAnalysisErrorMessage(workflow.error) : undefined) || workflow.pollingError || workflow.analysis?.summary || "自动生成整片提示词、分镜表和可替换资产。"}
            </p>
            <div className="canvas-viral-analysis-outputs">
                <span><FileText className="size-3.5" aria-hidden="true" />整片提示词</span>
                <span><Clapperboard className="size-3.5" aria-hidden="true" />{workflow.analysis ? `${workflow.analysis.shots.length} 个分镜` : "自动分镜"}</span>
                {workflow.analysis ? <span>{workflow.analysis.assets.length} 项资产</span> : null}
            </div>
            <div className="canvas-viral-analysis-footer">
                <Button block icon={<ArrowUpRight className="size-4" aria-hidden="true" />} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpen(); }}>打开复刻工作区</Button>
                <span className="canvas-viral-drag-hint"><GripVertical className="size-3" aria-hidden="true" />拖动卡片移动</span>
            </div>
        </div>
    );
}
