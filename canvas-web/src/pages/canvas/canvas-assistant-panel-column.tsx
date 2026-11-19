import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

// 根据视口宽度动态计算面板宽度约束，避免小屏幕上面板挤压画布
export function getPanelWidthBounds(): { min: number; max: number } {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    if (vw < 768) return { min: 260, max: Math.max(280, vw - 24) };
    const min = vw < 1024 ? 280 : vw < 1440 ? 320 : 360;
    // 保留画布的基本操作空间，同时允许用户在大屏上按自己的比例调整。
    return { min, max: Math.max(min, Math.round(vw * 0.75)) };
}

// 智能体面板列包裹器：承载面板宽度管理、resize 拖拽和顶部停靠偏移。
// 面板始终作为 flex 子元素避让画布；topInset 用于避让绝对定位的顶部栏（沉浸专注时顶部栏隐藏，传 0）。
// closing 期间保持宽度和渲染，让面板播放滑出动画；动画结束后由父组件卸载列。
export function AssistantPanelColumn({
    width,
    closing,
    floating = false,
    topInset,
    onWidthChange,
    children,
}: {
    width: number;
    closing: boolean;
    floating?: boolean;
    topInset: string;
    onWidthChange: (width: number) => void;
    children: (resizing: boolean) => ReactNode;
}) {
    const columnRef = useRef<HTMLDivElement>(null);
    const [resizing, setResizing] = useState(false);

    // 拖拽时列右边缘固定（flex 末位），左边缘随鼠标移动。
    const startResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const rightEdge = columnRef.current?.getBoundingClientRect().right ?? 0;
        const { min, max } = getPanelWidthBounds();
        const move = (e: PointerEvent) => {
            onWidthChange(Math.min(max, Math.max(min, rightEdge - e.clientX)));
        };
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        event.currentTarget.setPointerCapture?.(event.pointerId);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
        window.addEventListener("pointercancel", stop, { once: true });
    }, [onWidthChange]);

    const adjustWidth = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const { min, max } = getPanelWidthBounds();
        const delta = event.key === "ArrowLeft" ? 16 : -16;
        onWidthChange(Math.min(max, Math.max(min, width + delta)));
    };

    return (
        <div
            ref={columnRef}
            className={floating ? "pointer-events-none absolute inset-0 z-[var(--z-panel-floating)] h-full overflow-visible" : "relative flex h-full shrink-0 overflow-hidden"}
            style={{
                width: floating ? undefined : width,
                paddingTop: topInset,
                transition: resizing ? "none" : "width var(--motion-dur-base-calc) var(--motion-ease-out), padding-top var(--motion-dur-base-calc) var(--motion-ease-out)",
            }}
        >
            <div className="h-full w-full">
                {!closing && !floating ? (
                    <button
                        type="button"
                        className="absolute inset-y-0 left-0 z-[var(--z-panel-floating)] w-5 -translate-x-1/2 cursor-col-resize touch-none"
                        style={{ zIndex: "calc(var(--z-panel-floating) + 1)" }}
                        onPointerDown={startResize}
                        onKeyDown={adjustWidth}
                        aria-label="调整右侧面板宽度"
                        title="拖动调整宽度，使用左右方向键微调"
                    />
                ) : null}
                {children(resizing)}
            </div>
        </div>
    );
}
