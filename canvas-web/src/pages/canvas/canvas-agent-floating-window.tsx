import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { clampCanvasAgentFloatingOffset, type CanvasAgentFloatingOffset, type CanvasAgentFloatingSize } from "@/lib/canvas/canvas-agent-floating-window";

type DragState = {
    pointerId: number;
    startX: number;
    startY: number;
    offset: CanvasAgentFloatingOffset;
};

type FloatingWindowStyle = CSSProperties & {
    "--canvas-agent-floating-width": string;
    "--canvas-agent-floating-height": string;
};

export function CanvasAgentFloatingWindow({ children, size, expanded = false }: { children: ReactNode; size: CanvasAgentFloatingSize; expanded?: boolean }) {
    const boundsRef = useRef<HTMLDivElement | null>(null);
    const windowRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const offsetRef = useRef<CanvasAgentFloatingOffset>({ x: 0, y: 0 });
    const [offset, setOffsetState] = useState<CanvasAgentFloatingOffset>(offsetRef.current);
    const [dragging, setDragging] = useState(false);

    const setOffset = useCallback((next: CanvasAgentFloatingOffset) => {
        const bounds = boundsRef.current?.getBoundingClientRect();
        const panel = windowRef.current?.getBoundingClientRect();
        const constrained = bounds && panel
            ? clampCanvasAgentFloatingOffset(next, bounds, panel)
            : next;
        offsetRef.current = constrained;
        setOffsetState(constrained);
    }, []);

    const stopDragging = useCallback((pointerId?: number) => {
        const current = dragRef.current;
        if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return;
        dragRef.current = null;
        setDragging(false);
        if (windowRef.current) delete windowRef.current.dataset.agentFloatingDragging;
    }, []);

    useEffect(() => {
        const bounds = boundsRef.current;
        const panel = windowRef.current;
        if (expanded || !bounds || !panel) return;
        const clampCurrentOffset = () => setOffset(offsetRef.current);
        const observer = new ResizeObserver(clampCurrentOffset);
        observer.observe(bounds);
        observer.observe(panel);
        return () => observer.disconnect();
    }, [expanded, setOffset]);

    useEffect(() => {
        const handleWindowBlur = () => stopDragging();
        window.addEventListener("blur", handleWindowBlur);
        return () => window.removeEventListener("blur", handleWindowBlur);
    }, [stopDragging]);

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (expanded) return;
        if (event.button !== 0 || !(event.target instanceof Element)) return;
        const target = event.target;
        const dragHandle = target.closest("[data-canvas-agent-drag-handle]");
        if (!dragHandle && !target.closest(".canvas-agent-header")) return;
        if (target.closest("button,input,textarea,select,[data-canvas-no-drag]") && !dragHandle) return;

        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offset: offsetRef.current };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.agentFloatingDragging = "true";
        setDragging(true);
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setOffset({
            x: drag.offset.x + event.clientX - drag.startX,
            y: drag.offset.y + event.clientY - drag.startY,
        });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-canvas-agent-drag-handle]")) return;
        const step = event.shiftKey ? 48 : 16;
        const delta = event.key === "ArrowLeft" ? { x: -step, y: 0 }
            : event.key === "ArrowRight" ? { x: step, y: 0 }
                : event.key === "ArrowUp" ? { x: 0, y: -step }
                    : event.key === "ArrowDown" ? { x: 0, y: step }
                        : null;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        setOffset({ x: offsetRef.current.x + delta.x, y: offsetRef.current.y + delta.y });
    };

    return (
        <div ref={boundsRef} className={expanded ? "relative h-full w-full" : "pointer-events-none absolute inset-0 z-[var(--z-panel-floating)]"}>
            <div
                ref={windowRef}
                className="canvas-agent-floating-window pointer-events-auto absolute left-1/2 top-1/2"
                style={
                    {
                        "--canvas-agent-floating-width": `${size.width}px`,
                        "--canvas-agent-floating-height": `${size.height}px`,
                        ...(expanded ? { inset: 0, width: "100%", height: "100%", transform: "none" } : { transform: `translate3d(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px), 0)` }),
                        willChange: !expanded && dragging ? "transform" : undefined,
                    } as FloatingWindowStyle
                }
                onPointerDown={(event) => {
                    event.stopPropagation();
                    handlePointerDown(event);
                }}
                onPointerMove={(event) => {
                    event.stopPropagation();
                    handlePointerMove(event);
                }}
                onPointerUp={(event) => {
                    event.stopPropagation();
                    stopDragging(event.pointerId);
                }}
                onPointerCancel={(event) => {
                    event.stopPropagation();
                    stopDragging(event.pointerId);
                }}
                onLostPointerCapture={(event) => {
                    event.stopPropagation();
                    stopDragging(event.pointerId);
                }}
                onKeyDown={handleKeyDown}
            >
                {children}
            </div>
        </div>
    );
}
