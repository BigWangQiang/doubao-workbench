import { useEffect, useRef, useState } from "react";
import { App } from "antd";

import { coloredPencilEstimate, coloredPencilSourceKey, supportsColoredPencil } from "@/lib/colored-pencil";
import { canvasColoredPencilImage } from "@/lib/canvas/canvas-colored-pencil";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { createClientId } from "@/lib/client-id";
import { generationErrorMessage } from "@/lib/generation-error";
import { cancelGenerationTask, GENERATION_WAIT_DETACHED, queryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { coloredPencilTaskImage, readColoredPencilReceipts, recoverColoredPencilTask, refreshColoredPencilConfig, updateColoredPencilReceipt, submitColoredPencilTask, waitForColoredPencilStep, type ColoredPencilReceipt } from "@/services/colored-pencil";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { useUserStore } from "@/stores/use-user-store";

export type PencilReference = ReferenceImage & { previewUrl: string };
export type ColoredPencilItem = {
    original: PencilReference;
    output?: PencilReference;
    selected: boolean;
    applied?: PencilReference;
    status: "idle" | "submitting" | "waiting" | "saving" | "recoverable" | "ready" | "failed" | "unknown";
    task?: GenerationTask;
    error?: string;
};

export function useCanvasColoredPencil({ node, config, references, onConfigChange }: {
    node: CanvasNodeData; config: AiConfig; references: CanvasResourceReference[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const userId = useUserStore((state) => state.user?.id);
    const scope = node.id;
    const attachments: PencilReference[] = references.filter((reference) => reference.active && reference.kind === "image").map((reference) => ({
        id: reference.nodeId, name: reference.title || reference.label, type: "image/png", storageKey: reference.storageKey,
        dataUrl: reference.previewUrl || "", previewUrl: reference.previewUrl || "",
    }));
    const { message, modal } = App.useApp();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState("");
    const [stopping, setStopping] = useState(false);
    const [items, setItems] = useState<ColoredPencilItem[]>([]);
    const [error, setError] = useState("");
    const itemsRef = useRef(items);
    const busyRef = useRef(false);
    const stoppingRef = useRef(false);
    const stopRef = useRef(false);
    const resultAbort = useRef<AbortController | null>(null);
    const runAbort = useRef<AbortController | null>(null);
    const beginAbort = useRef<AbortController | null>(null);
    const activeTaskIds = useRef(new Set<string>());
    const receipts = useRef<ColoredPencilReceipt[]>([]);
    const context = useRef({ userId, scope });
    const live = useRef(true);
    context.current = { userId, scope };
    itemsRef.current = items;
    useEffect(() => { live.current = true; return () => { live.current = false; stopRef.current = true; beginAbort.current?.abort(); runAbort.current?.abort(GENERATION_WAIT_DETACHED); resultAbort.current?.abort(); }; }, []);
    useEffect(() => { beginAbort.current?.abort(); beginAbort.current = null; runAbort.current?.abort(GENERATION_WAIT_DETACHED); runAbort.current = null; resultAbort.current?.abort(); setOpen(false); setItems([]); setError(""); setLoading(false); setBusy(false); setPhase(""); setStopping(false); busyRef.current = false; stoppingRef.current = false; stopRef.current = true; activeTaskIds.current.clear(); }, [userId, scope]);
    useEffect(() => { receipts.current = []; }, [userId]);

    const patch = (sourceKey: string, update: Partial<ColoredPencilItem>, owner = userId) => {
        if (!live.current || context.current.userId !== owner || context.current.scope !== scope) return;
        setItems((current) => current.map((item) => coloredPencilSourceKey(item.original) === sourceKey ? { ...item, ...update } : item));
    };
    const saveReceipt = async (owner: string, receipt: ColoredPencilReceipt, signal?: AbortSignal) => {
        const next = await waitForColoredPencilStep(updateColoredPencilReceipt(owner, receipt.sourceKey, receipt), signal);
        if (context.current.userId === owner && context.current.scope === scope) receipts.current = next;
    };
    const finishTask = async (owner: string, item: ColoredPencilItem, task: GenerationTask, receipt: ColoredPencilReceipt, signal?: AbortSignal) => {
        const sourceKey = coloredPencilSourceKey(item.original);
        const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
        const completed = terminal ? task : await waitForGenerationTask(task.id, { signal, initialTask: task, onTaskUpdate: (update) => patch(sourceKey, { task: update, status: "waiting" }, owner) });
        if (completed.status !== "succeeded") throw new Error(completed.error ? generationErrorMessage(completed.error) : completed.status === "cancelled" ? "任务已取消，费用以任务中心结算为准" : "转彩铅失败");
        await saveReceipt(owner, { ...receipt, taskId: completed.id, successTaskId: completed.id }, signal);
        if (!live.current || context.current.userId !== owner || context.current.scope !== scope) return;
        patch(sourceKey, { status: "saving", task: completed, error: undefined }, owner);
        const controller = new AbortController();
        resultAbort.current = controller;
        try {
            const uploaded = await coloredPencilTaskImage(completed, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
            patch(sourceKey, { status: "ready", task: completed, error: undefined, output: { ...item.original, ...uploaded, type: uploaded.mimeType, dataUrl: uploaded.url, previewUrl: uploaded.url } }, owner);
        } finally { if (resultAbort.current === controller) resultAbort.current = null; }
    };
    const begin = async () => {
        if (!userId || loading || busyRef.current || stoppingRef.current) { if (busyRef.current || stoppingRef.current) setOpen(true); return; }
        const owner = userId;
        const sourceScope = scope;
        const controller = new AbortController();
        beginAbort.current?.abort();
        beginAbort.current = controller;
        const signal = controller.signal;
        setOpen(true); setLoading(true); setError("");
        const next = attachments.map((image): ColoredPencilItem => {
            const existing = itemsRef.current.find((item) => item.original.id === image.id && [coloredPencilSourceKey(item.original), item.output && coloredPencilSourceKey(item.output), item.applied && coloredPencilSourceKey(item.applied)].includes(coloredPencilSourceKey(image)));
            const applied = canvasColoredPencilImage(image, node.metadata?.coloredPencilReferences);
            const output = applied !== image ? { ...applied, previewUrl: "" } : undefined;
            return existing ? { ...existing, applied: output } : { original: image, output, applied: output, selected: true, status: output ? "ready" : "idle" };
        });
        setItems(next);
        try {
            const fresh = await refreshColoredPencilConfig(owner, signal);
            if (!supportsColoredPencil(fresh, config.model)) throw new Error("管理员尚未为当前视频模型开启转彩铅");
            coloredPencilEstimate(fresh, 1);
            const saved = await waitForColoredPencilStep(readColoredPencilReceipts(owner), signal);
            if (context.current.userId !== owner || context.current.scope !== sourceScope) return;
            receipts.current = saved;
            // 恢复只查询已有任务，绝不因刷新或断线重复创建付费请求。
            for (const item of next) {
                if (signal.aborted || !live.current || context.current.userId !== owner || context.current.scope !== sourceScope) break;
                if (item.output && item.status === "ready") continue;
                const receipt = saved.find((entry) => entry.sourceKey === coloredPencilSourceKey(item.original));
                if (!receipt) continue;
                let recovered: GenerationTask | null = null;
                try {
                    const task = await recoverColoredPencilTask(receipt, signal);
                    recovered = task;
                    if (!task) { patch(receipt.sourceKey, { status: "unknown", error: "未找到提交凭证，请先核对任务中心，避免重复计费" }, owner); continue; }
                    await saveReceipt(owner, { ...receipt, taskId: task.id }, signal);
                    if (task.status === "succeeded") await finishTask(owner, item, task, { ...receipt, taskId: task.id }, signal);
                    else if (task.status === "queued" || task.status === "running") patch(receipt.sourceKey, { status: "waiting", task }, owner);
                    else patch(receipt.sourceKey, { status: "failed", task, error: task.error ? generationErrorMessage(task.error) : "上次任务已结束，可重新生成" }, owner);
                    if (task.status !== "succeeded" && receipt.successTaskId && receipt.successTaskId !== task.id) {
                        const previous = await coloredPencilTaskImage(await queryGenerationTask(receipt.successTaskId, { signal }), { signal });
                        patch(receipt.sourceKey, { output: { ...item.original, ...previous, type: previous.mimeType, dataUrl: previous.url, previewUrl: previous.url } }, owner);
                    }
                } catch (reason) {
                    if (signal.aborted) break;
                    const succeeded = recovered?.status === "succeeded" || Boolean(receipt.taskId && receipt.successTaskId === receipt.taskId);
                    patch(receipt.sourceKey, { status: succeeded ? "recoverable" : receipt.taskId ? "waiting" : "unknown", task: recovered || item.task, error: generationErrorMessage(reason) }, owner);
                }
            }
        } catch (reason) { if (!signal.aborted && live.current && context.current.userId === owner && context.current.scope === sourceScope) setError(generationErrorMessage(reason)); }
        finally {
            if (beginAbort.current === controller) {
                beginAbort.current = null;
                if (live.current && context.current.userId === owner && context.current.scope === sourceScope) setLoading(false);
            }
        }
    };
    const run = async (ids?: string[], regenerate = false) => {
        if (!userId || busyRef.current || stoppingRef.current || loading) return;
        const owner = userId;
        const sourceScope = scope;
        const targets = itemsRef.current.filter((item) => ids ? ids.includes(item.original.id) : item.selected && (!item.output || ["waiting", "recoverable"].includes(item.status)));
        if (!targets.length) return;
        busyRef.current = true; stopRef.current = false; setBusy(true); setError(""); setPhase("正在读取模型配置，尚未提交任务…");
        const controller = new AbortController();
        runAbort.current = controller;
        const signal = controller.signal;
        try {
            const fresh = await refreshColoredPencilConfig(owner, signal);
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (!supportsColoredPencil(fresh, config.model)) throw new Error("管理员已关闭当前视频模型的转彩铅，请收起窗口");
            const needsNew = targets.some((item) => regenerate || !["waiting", "recoverable", "unknown"].includes(item.status));
            // 点击时重新读取后台目录；价格变动须再次确认，不按旧界面价格静默下单。
            if (needsNew && JSON.stringify(coloredPencilEstimate(config, 1)) !== JSON.stringify(coloredPencilEstimate(fresh, 1))) throw new Error("后台价格已更新，请查看最新费用后再次点击生成");
            setPhase("");
            for (const item of targets) {
                if (stopRef.current || signal.aborted || context.current.userId !== owner || context.current.scope !== sourceScope) break;
                const sourceKey = coloredPencilSourceKey(item.original);
                let receipt = receipts.current.find((entry) => entry.sourceKey === sourceKey);
                let submitted = false;
                try {
                    if (item.status === "unknown") continue;
                    const recovering = !regenerate && ["waiting", "recoverable"].includes(item.status);
                    let task = recovering && receipt ? await recoverColoredPencilTask(receipt, signal) : null;
                    if (recovering && !task) throw new Error("未找到已有任务，请重新读取或核对任务中心，不会自动重新生成");
                    if (!task) {
                        receipt = { sourceKey, requestId: createClientId(), successTaskId: receipt?.successTaskId };
                        await saveReceipt(owner, receipt, signal);
                        signal.throwIfAborted();
                        patch(sourceKey, { status: "submitting", error: undefined, task: undefined }, owner);
                        submitted = true;
                        task = await waitForColoredPencilStep(submitColoredPencilTask(fresh, item.original, receipt.requestId, signal), signal);
                        activeTaskIds.current.add(task.id);
                        receipt = { ...receipt, taskId: task.id };
                        patch(sourceKey, { status: "waiting", task }, owner);
                        await saveReceipt(owner, receipt, signal);
                        if (signal.aborted || stopRef.current) {
                            await cancelGenerationTask(task.id, { timeout: 30_000 });
                            throw new DOMException("Aborted", "AbortError");
                        }
                    } else if (task) {
                        activeTaskIds.current.add(task.id);
                    }
                    await finishTask(owner, item, task, receipt!, signal);
                } catch (reason) {
                    if (signal.aborted || stopRef.current) {
                        const succeeded = Boolean(receipt?.taskId) && receipts.current.some((entry) => entry.sourceKey === sourceKey && entry.successTaskId === receipt?.taskId);
                        patch(sourceKey, { status: succeeded ? "recoverable" : receipt?.taskId ? "waiting" : submitted ? "unknown" : item.status, error: submitted || receipt?.taskId ? "已停止等待，请重新检查原任务；不会自动重新提交" : "已停止准备，尚未提交生成任务" }, owner);
                        continue;
                    }
                    let status: ColoredPencilItem["status"] = submitted && !receipt?.taskId ? "unknown" : "failed";
                    if (receipt?.taskId) {
                        try {
                            const latest = await queryGenerationTask(receipt.taskId, { signal });
                            if (latest.status === "queued" || latest.status === "running") status = "waiting";
                            else if (latest.status === "succeeded") status = "recoverable";
                            patch(sourceKey, { task: latest }, owner);
                        } catch {
                            // 已有任务编号就只恢复；查询断线不代表任务未提交，不能引导重置后再扣费。
                            status = receipts.current.some((entry) => entry.sourceKey === sourceKey && entry.successTaskId === receipt?.taskId) ? "recoverable" : "waiting";
                        }
                    }
                    patch(sourceKey, { status, error: generationErrorMessage(reason) }, owner);
                } finally {
                    if (receipt?.taskId) activeTaskIds.current.delete(receipt.taskId);
                }
            }
        } catch (reason) {
            if (!signal.aborted && !stopRef.current && live.current && context.current.userId === owner && context.current.scope === sourceScope) setError(generationErrorMessage(reason));
        } finally {
            if (runAbort.current === controller) {
                runAbort.current = null;
                if (live.current && context.current.userId === owner && context.current.scope === sourceScope) { busyRef.current = false; setBusy(false); setPhase(""); }
            }
        }
    };
    const apply = (restoreId?: string) => {
        if (busyRef.current || stoppingRef.current || context.current.scope !== scope || context.current.userId !== userId) return;
        const chosen = itemsRef.current.filter((item) => restoreId ? item.original.id === restoreId : item.selected && item.output);
        const overrides = { ...node.metadata?.coloredPencilReferences };
        const appliedIds = new Set<string>();
        for (const item of chosen) {
            const current = attachments.find((image) => image.id === item.original.id);
            if (!current?.storageKey || coloredPencilSourceKey(current) !== coloredPencilSourceKey(item.original)) continue;
            if (restoreId) delete overrides[item.original.id];
            else if (item.output?.storageKey?.startsWith("resource:")) {
                const output = item.output;
                overrides[item.original.id] = { originalStorageKey: current.storageKey, storageKey: output.storageKey!, type: output.type, width: output.width, height: output.height, bytes: output.bytes };
            } else continue;
            appliedIds.add(item.original.id);
        }
        if (!appliedIds.size) { message.warning("参考素材已改变，请重新打开转彩铅"); return; }
        onConfigChange(node.id, { coloredPencilReferences: overrides });
        setItems((current) => current.map((item) => appliedIds.has(item.original.id) ? { ...item, applied: restoreId ? undefined : item.output } : item));
        if (!restoreId) { setOpen(false); message.success(`当前视频已使用 ${appliedIds.size} 张彩铅图`); }
    };
    const cancel = async () => {
        if (stoppingRef.current) return;
        stoppingRef.current = true;
        setStopping(true);
        stopRef.current = true;
        resultAbort.current?.abort();
        // 先解除上传、创建任务和轮询的等待，停止按钮应立即有反馈；随后再核对服务端取消结果。
        runAbort.current?.abort(GENERATION_WAIT_DETACHED);
        const taskIds = new Set(activeTaskIds.current);
        itemsRef.current.forEach((item) => {
            if (item.task && ["queued", "running"].includes(item.task.status)) taskIds.add(item.task.id);
        });
        // 前端等待已解除后，再请求服务端取消；用 detached 原因避免轮询层重复发取消请求。
        message.info(taskIds.size ? "已停止本地等待，正在确认服务端任务状态" : "已停止处理；已发出的请求仍需核对提交结果");
        const cancellations = await Promise.allSettled([...taskIds].map((id) => cancelGenerationTask(id, { timeout: 30_000 })));
        const cancelledById = new Map<string, GenerationTask>();
        const errors: unknown[] = [];
        cancellations.forEach((result, index) => {
            const id = [...taskIds][index];
            if (result.status === "fulfilled") cancelledById.set(id, result.value);
            else errors.push(result.reason);
        });
        if (live.current && context.current.userId === userId && context.current.scope === scope) {
            setItems((current) => current.map((item) => {
                const taskId = item.task?.id;
                if (!taskId && ["submitting", "waiting", "saving"].includes(item.status)) return { ...item, status: "unknown", error: "已请求停止，提交状态待核对" };
                const cancelled = taskId ? cancelledById.get(taskId) : undefined;
                if (!taskId || !taskIds.has(taskId)) return item;
                if (cancelled?.status === "cancelled") return { ...item, status: "failed", task: cancelled, error: "任务已取消，费用以任务中心结算为准" };
                if (cancelled?.status === "succeeded") return { ...item, status: "recoverable", task: cancelled, error: "任务已经生成完成，可以恢复结果" };
                return { ...item, status: "unknown", task: cancelled || item.task, error: "已请求停止，请到任务中心核对任务状态后再继续" };
            }));
            if (errors.length) setError(generationErrorMessage(errors[0]));
            stoppingRef.current = false;
            setStopping(false);
        }
    };
    const resetUnknown = (id: string) => modal.confirm({
        title: "已核对任务中心没有这次任务？", content: "提交结果暂时无法确认。请先核对任务中心；仅在确认未提交后重置，再次生成将创建新的计费任务。",
        okText: "确认未提交，重置", cancelText: "继续核对",
        onOk: async () => {
            const item = itemsRef.current.find((entry) => entry.original.id === id);
            if (!item || !userId || context.current.userId !== userId || context.current.scope !== scope) return;
            const next = await updateColoredPencilReceipt(userId, coloredPencilSourceKey(item.original));
            receipts.current = next;
            patch(coloredPencilSourceKey(item.original), { status: "idle", error: undefined, task: undefined });
        },
    });
    return { open, loading, busy: busy || stopping, phase, stopping, items, error, begin, run, apply, cancel, resetUnknown, close: () => setOpen(false), toggle: (id: string) => setItems((current) => current.map((item) => item.original.id === id ? { ...item, selected: !item.selected } : item)) };
}
