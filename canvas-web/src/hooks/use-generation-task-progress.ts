import { useEffect, useState } from "react";

import { taskDisplayProgress, type TaskProgressInput } from "@/lib/generation-task-display";

// 仅活跃任务更新时间；展示时钟不依赖接口轮询，也不回写任务或画布存储。
export function useGenerationTaskProgress(task: TaskProgressInput) {
    const active = task.status === "queued" || task.status === "running";
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [active]);
    return { ...taskDisplayProgress(task, now), now };
}
