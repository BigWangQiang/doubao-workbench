import { CanvasNodeType, type CanvasMediaPerformanceMode, type CanvasNodeData } from "@/types/canvas";

const STORAGE_KEY = "canvas-media-performance-mode";

export function readCanvasMediaPerformanceMode(): CanvasMediaPerformanceMode {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === "quality" || stored === "performance" ? stored : "auto";
    } catch {
        return "auto";
    }
}

export function persistCanvasMediaPerformanceMode(mode: CanvasMediaPerformanceMode) {
    try {
        window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // 浏览器禁用本地存储时保留当前会话内的选择。
    }
}

export function shouldReduceCanvasMediaEffects(
    mode: CanvasMediaPerformanceMode,
    _nodes: CanvasNodeData[],
    visibleVideoCount = 0,
    device = readCanvasDeviceProfile(),
) {
    if (mode === "performance") return true;
    if (mode === "quality") return false;
    const constrainedDevice = (device.memoryGiB !== undefined && device.memoryGiB <= 4) || (device.hardwareConcurrency !== undefined && device.hardwareConcurrency <= 4);
    // 自动模式只根据当前视口压力和设备能力切换；画布总节点数/媒体总数
    // 不再作为阈值，避免用户必须堆到 32 个媒体节点才进入轻量模式。
    const visibleVideoLimit = constrainedDevice ? 2 : 4;
    return visibleVideoCount >= visibleVideoLimit;
}

function readCanvasDeviceProfile() {
    if (typeof navigator === "undefined") return {};
    const device = navigator as Navigator & { deviceMemory?: number };
    return { memoryGiB: device.deviceMemory, hardwareConcurrency: device.hardwareConcurrency };
}
