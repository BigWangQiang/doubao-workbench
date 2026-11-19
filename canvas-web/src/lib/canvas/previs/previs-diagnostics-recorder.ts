import { formatPrevisDiagnosticCode, projectPrevisDiagnostic, type PrevisDiagnosticCode, type PrevisDiagnosticFields } from "@/lib/canvas/previs/previs-diagnostics";

/**
 * 预演台故障事件的唯一记录入口。
 *
 * 本地分支没有统一 client-diagnostics 服务；通过稳定事件暴露安全诊断，开发环境可在控制台查看。
 * 只传固定 message 与安全 code/字段；stack 一律不填。
 */

/** 去重窗口：同一 code+字段组合在窗口内只记一次，避免高频路径灌满缓冲区。 */
const DEDUPE_WINDOW_MS = 1500;
const lastSeen = new Map<string, number>();

function now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** 测试与页面重置用：清空去重状态。 */
export function resetPrevisDiagnosticDedupe(): void {
    lastSeen.clear();
}

/**
 * 记录一条预演台诊断事件。
 * 返回是否真的写入（未知 code 或命中去重窗口时返回 false），便于测试断言。
 */
export function recordPrevisDiagnostic(code: PrevisDiagnosticCode, fields: PrevisDiagnosticFields = {}): boolean {
    const event = projectPrevisDiagnostic(code, fields);
    if (!event) return false;

    const signature = formatPrevisDiagnosticCode(event);
    const timestamp = now();
    const previous = lastSeen.get(signature);
    if (previous !== undefined && timestamp - previous < DEDUPE_WINDOW_MS) return false;
    lastSeen.set(signature, timestamp);

    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("canvas:previs-diagnostic", { detail: { ...event, code: signature } }));
    }
    if (import.meta.env.DEV) console.debug("[previs diagnostic]", signature, event.message);
    return true;
}
