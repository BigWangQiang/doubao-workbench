import { Button, Image, Modal } from "antd";

import { TaskDetailItem, taskStatusText } from "./canvas-project-feedback";
import type { GenerationTask, TaskLog } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { VideoPlayer } from "@/components/video-player";
import { CanvasVideoSuperResolutionDialog } from "@/components/canvas/canvas-video-super-resolution-dialog";
import type { VideoSuperResolutionSelection } from "@/services/canvas-video-super-resolution";
import { generationErrorMessage } from "@/lib/generation-error";
import { useGenerationTaskProgress } from "@/hooks/use-generation-task-progress";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { modelDisplayName, useEffectiveConfig } from "@/stores/use-config-store";

type CanvasProjectStatusDialogsProps = {
    theme: CanvasTheme;
    task: GenerationTask | null;
    taskLogs: TaskLog[];
    taskLoading: boolean;
    onCloseTask: () => void;
    superResolveNode: CanvasNodeData | null;
    superResolveSubmitting: boolean;
    onConfirmSuperResolve: (selection: VideoSuperResolutionSelection) => Promise<void>;
    onCloseSuperResolve: () => void;
    previewNode: CanvasNodeData | null;
    onClosePreview: () => void;
    clearConfirmOpen: boolean;
    onCancelClear: () => void;
    onConfirmClear: () => void;
};

export function CanvasProjectStatusDialogs({ theme, task, taskLogs, taskLoading, superResolveNode, superResolveSubmitting, onConfirmSuperResolve, previewNode, clearConfirmOpen, onCloseTask, onCloseSuperResolve, onClosePreview, onCancelClear, onConfirmClear }: CanvasProjectStatusDialogsProps) {
    const config = useEffectiveConfig();
    const progress = useGenerationTaskProgress(task || {});
    return (
        <>
            <Modal title="任务详情" open={Boolean(task)} footer={null} width={760} onCancel={onCloseTask}>
                {task ? (
                    <div className="space-y-4 text-sm">
                        <div className="grid grid-cols-2 gap-3 rounded-lg border p-3" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                            <TaskDetailItem label="当前阶段" value={progress.stage || taskStatusText(task.status)} />
                            <TaskDetailItem label="任务进度" value={progress.percent !== undefined ? progress.label : "未提供百分比"} />
                            <TaskDetailItem label="模型" value={task.model ? modelDisplayName(config, task.model) : "默认模型"} />
                            <TaskDetailItem label="任务 ID" value={task.id} />
                        </div>
                        {task.error || task.status === "failed" || task.status === "cancelled" ? (
                            <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: `${theme.node.stroke}`, background: theme.node.panel }}>
                                <div className="text-xs font-semibold" style={{ color: theme.node.muted }}>失败原因</div>
                                <div className="whitespace-pre-wrap break-words text-sm" style={{ color: theme.accent.danger }}>
                                    {task.error ? generationErrorMessage(task.error) : task.status === "cancelled" ? "任务已取消" : "生成失败，服务未返回具体原因。"}
                                </div>
                            </div>
                        ) : null}
                        <div>
                            <div className="mb-2 text-xs font-semibold" style={{ color: theme.node.muted }}>提示词</div>
                            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 text-xs leading-5" style={{ background: theme.node.fill }}>{task.prompt || "未记录"}</div>
                        </div>
                        <div>
                            <div className="mb-2 text-xs font-semibold" style={{ color: theme.node.muted }}>任务日志</div>
                            <pre className="max-h-64 overflow-auto rounded-lg bg-neutral-950 p-3 text-[var(--fs-label)] leading-5 text-neutral-100">{taskLoading ? "加载中..." : taskLogs.length ? taskLogs.map((log) => `[${new Date(log.createdAt).toLocaleString()}] ${log.level.toUpperCase()} ${log.message}`).join("\n") : "暂无日志"}</pre>
                        </div>
                    </div>
                ) : null}
            </Modal>

            {superResolveNode?.type === CanvasNodeType.Video && superResolveNode.metadata?.content ? <CanvasVideoSuperResolutionDialog key={superResolveNode.id} node={superResolveNode} submitting={superResolveSubmitting} onClose={onCloseSuperResolve} onConfirm={onConfirmSuperResolve} /> : null}
            <Modal title="图片超分" open={Boolean(superResolveNode?.type === CanvasNodeType.Image && superResolveNode.metadata?.content)} centered footer={null} onCancel={onCloseSuperResolve}>
                <div className="py-6 text-center text-sm text-foreground/60">图片 AI 超分暂未开放，可使用图片工具栏中的“高清放大”。</div>
            </Modal>

            <Modal title="视频预览" open={Boolean(previewNode?.metadata?.content && previewNode.type === CanvasNodeType.Video)} centered onCancel={onClosePreview} footer={null} width="min(1200px, calc(100vw - 32px))" styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "84vh", overflow: "hidden", background: "#090909" } }}>
                {previewNode?.metadata?.content && previewNode.type === CanvasNodeType.Video ? <VideoPlayer src={previewNode.metadata.content} mimeType={previewNode.metadata.mimeType} title={previewNode.title || "视频预览"} className="max-h-[84vh] max-w-full bg-black" /> : null}
            </Modal>

            {previewNode?.metadata?.content && previewNode.type === CanvasNodeType.Image ? (
                <Image
                    src={previewNode.metadata.content}
                    alt={previewNode.title || "图片"}
                    style={{ display: "none" }}
                    preview={{
                        open: true,
                        movable: true,
                        minScale: 0.5,
                        maxScale: 12,
                        scaleStep: 0.25,
                        onOpenChange: (open) => !open && onClosePreview(),
                    }}
                />
            ) : null}

            <Modal
                title="清空画布？"
                open={clearConfirmOpen}
                centered
                onCancel={onCancelClear}
                footer={<><Button onClick={onCancelClear}>取消</Button><Button danger type="primary" onClick={onConfirmClear}>清空</Button></>}
            >
                <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
            </Modal>
        </>
    );
}
