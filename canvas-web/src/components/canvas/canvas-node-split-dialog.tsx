import { useEffect, useRef, useState } from "react";
import { Button, InputNumber, Modal } from "antd";
import { Grid2x2, RotateCcw } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { createEvenSplitPoints, normalizeSplitPoints, type ImageSplitParams } from "@/lib/canvas/canvas-image-data";

export type CanvasImageSplitParams = ImageSplitParams;

const createDefaultParams = (): CanvasImageSplitParams => ({ rows: 2, columns: 2, rowSplits: [0.5], columnSplits: [0.5] });
const maxGridSize = 12;

export function CanvasNodeSplitDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageSplitParams) => void }) {
    const [params, setParams] = useState(createDefaultParams);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const total = params.rows * params.columns;
    const pieceSize = image ? { width: Math.max(1, Math.floor(image.width / params.columns)), height: Math.max(1, Math.floor(image.height / params.rows)) } : null;

    useEffect(() => {
        if (!open) return;
        setParams(createDefaultParams());
        setImage(null);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const updateGridSize = (key: "rows" | "columns", value: string | number | null) => {
        setParams((current) => {
            const count = clampGrid(value ?? current[key]);
            return {
                ...current,
                [key]: count,
                ...(key === "rows" ? { rowSplits: createEvenSplitPoints(count) } : { columnSplits: createEvenSplitPoints(count) }),
            };
        });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={780} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">切分图片</h2>
                    <p className="mt-1 text-sm opacity-60">生成 {total} 个图片子节点，并按原图网格排列到画布右侧</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_280px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[300px] place-items-center rounded-lg bg-black/5">
                            <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-black shadow-xl">
                                <img src={dataUrl} alt="" className="block max-h-[340px] max-w-full object-contain opacity-95" draggable={false} />
                                <SplitGrid
                                    rows={params.rows}
                                    columns={params.columns}
                                    rowSplits={params.rowSplits}
                                    columnSplits={params.columnSplits}
                                    onChange={(patch) => setParams((current) => ({ ...current, ...patch }))}
                                />
                            </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">原图</span>
                            <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : "读取中"}</span>
                        </div>
                    </div>
                    <div className="space-y-5 py-2">
                        <NumberField label="行数" value={params.rows} onChange={(value) => updateGridSize("rows", value)} />
                        <NumberField label="列数" value={params.columns} onChange={(value) => updateGridSize("columns", value)} />
                        <Button
                            icon={<RotateCcw className="size-4" />}
                            onClick={() => setParams((current) => ({ ...current, rowSplits: createEvenSplitPoints(current.rows), columnSplits: createEvenSplitPoints(current.columns) }))}
                        >
                            恢复等分
                        </Button>
                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">子节点</span>
                                <span className="font-semibold">{total} 个</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between">
                                <span className="opacity-60">单块约</span>
                                <span className="font-semibold">{pieceSize ? `${pieceSize.width} x ${pieceSize.height}` : "未知"}</span>
                            </div>
                        </div>
                        <Button type="primary" size="large" className="w-full" icon={<Grid2x2 className="size-4" />} onClick={() => onConfirm(params)}>
                            生成子节点
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: string | number | null) => void }) {
    return (
        <label className="block space-y-2">
            <span className="font-medium opacity-75">{label}</span>
            <InputNumber className="w-full" min={1} max={maxGridSize} precision={0} value={value} onChange={onChange} />
        </label>
    );
}

function SplitGrid({
    rows,
    columns,
    rowSplits,
    columnSplits,
    onChange,
}: CanvasImageSplitParams & { onChange: (patch: Pick<CanvasImageSplitParams, "rowSplits" | "columnSplits">) => void }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const rowsResolved = normalizeSplitPoints(rowSplits, rows);
    const columnsResolved = normalizeSplitPoints(columnSplits, columns);

    const updatePoint = (axis: "row" | "column", index: number, value: number) => {
        const source = axis === "row" ? rowsResolved : columnsResolved;
        const previous = index > 0 ? source[index - 1] : 0;
        const next = index + 1 < source.length ? source[index + 1] : 1;
        const resolved = Math.max(previous + 0.04, Math.min(next - 0.04, value));
        const points = source.map((point, pointIndex) => (pointIndex === index ? resolved : point));
        onChange(axis === "row" ? { rowSplits: points, columnSplits: columnsResolved } : { rowSplits: rowsResolved, columnSplits: points });
    };

    const pointerValue = (event: React.PointerEvent<HTMLButtonElement>, axis: "row" | "column") => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return 0;
        return axis === "row" ? (event.clientY - rect.top) / Math.max(1, rect.height) : (event.clientX - rect.left) / Math.max(1, rect.width);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, axis: "row" | "column", index: number) => {
        const negative = axis === "row" ? event.key === "ArrowUp" : event.key === "ArrowLeft";
        const positive = axis === "row" ? event.key === "ArrowDown" : event.key === "ArrowRight";
        if (!negative && !positive) return;
        event.preventDefault();
        const points = axis === "row" ? rowsResolved : columnsResolved;
        updatePoint(axis, index, points[index] + (positive ? 0.01 : -0.01));
    };

    return (
        <div ref={rootRef} className="absolute inset-0" data-canvas-no-zoom>
            {columnsResolved.map((point, index) => (
                <button
                    key={`column-${index}`}
                    type="button"
                    className="group absolute inset-y-0 w-8 -translate-x-1/2 cursor-col-resize touch-none bg-transparent focus-visible:outline-none"
                    style={{ left: `${point * 100}%` }}
                    aria-label={`调整第 ${index + 1} 条纵向分割线`}
                    aria-orientation="vertical"
                    onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                    onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePoint("column", index, pointerValue(event, "column"));
                    }}
                    onKeyDown={(event) => handleKeyDown(event, "column", index)}
                >
                    <span className="absolute inset-y-0 left-1/2 border-l border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)] group-focus-visible:border-sky-300" />
                </button>
            ))}
            {rowsResolved.map((point, index) => (
                <button
                    key={`row-${index}`}
                    type="button"
                    className="group absolute inset-x-0 h-8 -translate-y-1/2 cursor-row-resize touch-none bg-transparent focus-visible:outline-none"
                    style={{ top: `${point * 100}%` }}
                    aria-label={`调整第 ${index + 1} 条横向分割线`}
                    aria-orientation="horizontal"
                    onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                    onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePoint("row", index, pointerValue(event, "row"));
                    }}
                    onKeyDown={(event) => handleKeyDown(event, "row", index)}
                >
                    <span className="absolute inset-x-0 top-1/2 border-t border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)] group-focus-visible:border-sky-300" />
                </button>
            ))}
        </div>
    );
}

function clampGrid(value: string | number) {
    const numberValue = Number(value);
    return Math.min(maxGridSize, Math.max(1, Math.round(Number.isFinite(numberValue) ? numberValue : 1)));
}
