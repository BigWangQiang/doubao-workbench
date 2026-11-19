import type { GenerationTask, TaskStatus } from "@/services/api/task-center";

// 保留服务端原始百分比语义；时间估算仅在展示层计算，不写回任务。
export function taskProgressPercent(progress: number | undefined): number | undefined {
    return typeof progress === "number" && Number.isFinite(progress) && progress >= 0
        ? Math.min(100, Math.round(progress))
        : undefined;
}

export type TaskProgressInput = Partial<Pick<GenerationTask, "type" | "progress" | "stage" | "startedAt" | "createdAt">> & { status?: string };

const VIDEO_ESTIMATED_DURATION_MS = 20 * 60 * 1_000;

export function taskDisplayProgress(task: TaskProgressInput, now = Date.now()) {
    const stage = task.stage?.replaceAll("上游", "");
    const actual = taskProgressPercent(task.progress);
    const active = task.status === "queued" || task.status === "running";
    const video = task.type === "canvas_video" || task.type === "video" || task.type?.startsWith("video_");
    let percent = actual;
    let estimated = false;

    if (task.status === "succeeded") {
        percent = 100;
    } else if (video && active) {
        // 生成完成仍需取回和保存文件，统一放在最后 5%，避免下载从 0% 重新开始。
        if (/已取回|正在保存|持久化|已保存|同步画布/.test(stage || "")) {
            percent = 99;
        } else if (/下载|视频已生成/.test(stage || "")) {
            percent = actual === undefined ? 95 : Math.min(99, 95 + Math.floor(actual / 25));
        } else if (actual !== undefined && actual > 0) {
            percent = Math.min(99, actual);
        } else {
            // 部分渠道始终返回 0；与未知值一样使用约 20 分钟的时间线，并显式标为估算。
            const start = taskTimestamp(task.startedAt) ?? taskTimestamp(task.createdAt) ?? now;
            const elapsed = Math.max(0, now - start);
            percent = Math.min(95, 5 + Math.round(elapsed / VIDEO_ESTIMATED_DURATION_MS * 90));
            estimated = true;
        }
    }

    return { percent, estimated, stage, label: percent === undefined ? "处理中" : `${estimated ? "约 " : ""}${percent}%` };
}

function taskTimestamp(value?: string) {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

export const statusLabel: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "生成中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
};

export const operationOptions = [
    { label: "Agent 会话：拆解影视工作流", value: "agent_session" },
    { label: "文生视频", value: "text_to_video" },
    { label: "图生视频", value: "image_to_video" },
    { label: "视频续写", value: "extend" },
    { label: "视频局部修改", value: "inpaint" },
    { label: "元素替换", value: "replace_element" },
    { label: "镜头/运镜调整", value: "camera_motion" },
    { label: "风格迁移", value: "style_transfer" },
    { label: "参考音频生成视频", value: "audio_to_video" },
    { label: "结果版本对比", value: "compare_versions" },
];

export const operationLabelByValue = new Map(operationOptions.map((item) => [item.value, item.label]));

export const taskTypeLabel: Record<string, string> = {
    agent_session: "Agent 会话",
    agent_storyboard: "Agent 分镜",
    agent_storyboard_rows: "分镜脚本",
    canvas_image: "画布生图",
    canvas_video: "画布视频",
    canvas_audio: "画布音频",
    canvas_text: "画布文本",
};

export function formatTaskKind(task: GenerationTask) {
    if (task.type === "agent_session" || task.operation === "agent_session") return "Agent 会话";

    const typeLabel = taskTypeLabel[task.type];
    const operationLabel = task.operation ? operationLabelByValue.get(task.operation) : "";

    if (task.type === "canvas_video" && operationLabel) return `${typeLabel || "画布视频"} · ${operationLabel}`;
    if (typeLabel) return typeLabel;
    if (operationLabel) return operationLabel;
    if (task.type.startsWith("video_")) return "视频任务";
    return "生成任务";
}

