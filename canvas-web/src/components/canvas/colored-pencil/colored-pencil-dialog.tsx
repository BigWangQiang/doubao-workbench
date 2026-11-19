import { Alert, Button, Checkbox, Modal, Progress, Tooltip } from "antd";
import { Check, Image as ImageIcon, LoaderCircle, Minimize2, Pencil, RefreshCw, RotateCcw } from "lucide-react";

import { PersistentResourceImage } from "@/components/persistent-resource-image";
import { coloredPencilEstimate } from "@/lib/colored-pencil";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { useCanvasColoredPencil } from "./use-colored-pencil";
import "./colored-pencil.css";

export function ColoredPencilDialog({ controller, config }: { controller: ReturnType<typeof useCanvasColoredPencil>; config: AiConfig }) {
    const { items, busy, loading } = controller;
    const creditsEnabled = useUserStore((state) => state.features.creditsEnabled);
    const selected = items.filter((item) => item.selected);
    const ready = selected.filter((item) => item.output);
    const waiting = selected.filter((item) => item.status === "waiting");
    const recoverable = selected.filter((item) => item.status === "recoverable");
    const newCount = selected.filter((item) => !item.output && !["waiting", "saving", "recoverable", "unknown"].includes(item.status)).length;
    const unknown = selected.some((item) => item.status === "unknown");
    let price = "读取模型价格…";
    let regenerationPrice = "按后台当前价格计费";
    let priceAvailable = false;
    try {
        const estimate = coloredPencilEstimate(config, newCount);
        const unit = coloredPencilEstimate(config, 1);
        const unitText = unit.kind === "exact" ? `${unit.credits.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分 / 张` : "按模型实际用量结算";
        regenerationPrice = creditsEnabled ? `重新生成预计 ${unitText}` : "当前未启用积分计费";
        priceAvailable = estimate.kind === "exact" || estimate.kind === "usage" || !creditsEnabled;
        price = !creditsEnabled ? "当前未启用积分计费" : !newCount ? `${unitText} · 已有结果可复用` : estimate.kind === "exact" ? `本次预计 ${estimate.credits.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分 · ${unitText}` : estimate.kind === "usage" ? "按模型实际用量结算" : "模型计价暂不可用";
    } catch { price = "后台图片模型暂不可用"; }

    return (
        <Modal
            open={controller.open}
            className="colored-pencil-dialog"
            title={null} footer={null} closable={false} centered
            maskClosable={!busy} keyboard={!busy}
            width="min(calc(var(--space-24) * 9), calc(100vw - var(--space-6)))"
            onCancel={controller.close}
            styles={{ container: { padding: 0, overflow: "hidden" }, body: { padding: 0 } }}
        >
            <div className="pencil-shell" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                <header className="pencil-header">
                    <span className="pencil-heading-icon"><Pencil aria-hidden="true" /></span>
                    <div className="pencil-heading"><h2>参考图转彩铅</h2><p>保留完整构图，预览后用于本次视频</p></div>
                    <Button type="text" icon={<Minimize2 aria-hidden="true" />} onClick={controller.close}>收起</Button>
                </header>
                <div className="pencil-summary"><span>参考图片 <strong>{selected.length} / {items.length}</strong> 已选</span><span className="pencil-model"><Pencil aria-hidden="true" />GPT Image 2<span>原比例重绘</span></span></div>
                {controller.error ? <div className="pencil-alert"><Alert type="error" showIcon title={controller.error} action={<Button size="small" onClick={() => void controller.begin()} disabled={busy || loading}>重新读取</Button>} /></div> : null}
                <div className="pencil-content" aria-busy={busy || loading}>
                    {loading ? <div className="pencil-loading" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" />正在读取模型配置和历史任务…</div> : null}
                    {!items.length ? <div className="pencil-empty"><ImageIcon aria-hidden="true" /><strong>先添加参考图片</strong><span>上传图片或从素材库选择后，即可进行彩铅重绘</span></div> : null}
                    {items.map((item, index) => (
                        <section className={`pencil-item${item.selected ? " is-selected" : ""}`} key={item.original.id}>
                            <header className="pencil-item-header">
                                <Checkbox className="pencil-selection" checked={item.selected} disabled={busy || loading} onChange={() => controller.toggle(item.original.id)}><span className="pencil-item-name" title={item.original.name}>参考图 {String(index + 1).padStart(2, "0")}</span><span className="pencil-selection-state">{item.selected ? "已选择" : "未选择"}</span></Checkbox>
                                {item.applied && item.applied.storageKey === item.output?.storageKey ? <span className="pencil-applied"><Check aria-hidden="true" />已使用</span> : null}
                                {item.status === "submitting" || item.status === "waiting" || item.status === "saving" ? <span className="pencil-item-progress" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" />{item.status === "saving" ? "已生成，正在保存结果" : item.status === "submitting" ? "正在提交" : item.task?.stage || "正在生成"}</span> : null}
                                <div className="pencil-item-actions">
                                    {item.applied ? <Button type="text" size="small" disabled={busy || loading} icon={<RotateCcw aria-hidden="true" />} onClick={() => controller.apply(item.original.id)}>恢复原图</Button> : null}
                                    {item.status === "recoverable" ? <Button type="text" size="small" disabled={busy || loading} icon={<RefreshCw aria-hidden="true" />} onClick={() => void controller.run([item.original.id])}>恢复结果</Button> : null}
                                    {item.output || item.status === "failed" || item.status === "recoverable" ? <Tooltip title={regenerationPrice}><Button type="text" size="small" disabled={busy || loading || item.status === "unknown" || !priceAvailable || Boolean(controller.error)} icon={<RefreshCw aria-hidden="true" />} onClick={() => void controller.run([item.original.id], true)}>重新生成</Button></Tooltip> : null}
                                    {item.status === "unknown" ? <><Button type="text" size="small" disabled={busy || loading} onClick={() => void controller.begin()}>重新检查</Button><Button type="text" size="small" disabled={busy || loading} onClick={() => controller.resetUnknown(item.original.id)}>核对后重置</Button></> : null}
                                </div>
                            </header>
                            <div className="pencil-comparison">
                                <figure><figcaption>原始参考<span>{item.original.width && item.original.height ? `${item.original.width} × ${item.original.height}` : "保留完整构图"}</span></figcaption><div className="pencil-media"><PersistentResourceImage src={item.original.previewUrl} storageKey={item.original.storageKey} alt={`图片 ${index + 1} 原图`} loading="lazy" /></div></figure>
                                <figure><figcaption>彩铅效果<span>{item.output ? `${item.output.width} × ${item.output.height}` : "生成后预览"}</span></figcaption><div className="pencil-media">
                                    {item.output ? <PersistentResourceImage src={item.output.previewUrl} storageKey={item.output.storageKey} alt={`图片 ${index + 1} 彩铅重绘结果`} loading="lazy" /> : <div className="pencil-placeholder">
                                        {item.status === "submitting" || item.status === "waiting" || item.status === "saving" ? <><LoaderCircle className="animate-spin" aria-hidden="true" /><strong>{item.status === "saving" ? "图片已生成，正在保存并读取预览" : item.status === "submitting" ? "正在提交图片任务" : item.task?.stage || "等待图片生成"}</strong><Progress percent={Math.max(5, Math.min(95, item.task?.progress || 5))} showInfo={false} status="active" /><span>收起后任务仍会保留，不会自动提交视频</span></> : <><Pencil aria-hidden="true" /><strong>{item.status === "recoverable" ? "图片已生成，等待恢复结果" : item.status === "failed" ? "本次转图未完成" : item.status === "unknown" ? "提交状态待核对" : "等待彩铅重绘"}</strong><span>{item.status === "recoverable" ? "恢复已有任务，无需重新生成或扣费" : "原图与原始素材始终保留"}</span></>}
                                    </div>}
                                </div></figure>
                            </div>
                            {item.error ? <div className="pencil-item-error" role="alert">{item.error}</div> : null}
                        </section>
                    ))}
                </div>
                <footer className="pencil-footer">
                    <div className="pencil-cost" role="status"><strong>{controller.stopping ? "已停止等待，正在核对任务状态…" : busy ? controller.phase || `正在处理 · 已有 ${items.filter((item) => item.output).length} 张结果` : price}</strong><span>转图与视频分别结算；人物与构图效果以实际结果为准</span></div>
                    <div className="pencil-footer-actions">
                        {busy ? <Button loading={controller.stopping} onClick={() => void controller.cancel()}>{controller.stopping ? "正在确认停止" : "停止处理"}</Button> : newCount || waiting.length || recoverable.length || !ready.length ? <Button disabled={loading || unknown || !selected.length || (!newCount && !waiting.length && !recoverable.length) || !priceAvailable || Boolean(controller.error)} loading={loading} onClick={() => void controller.run()} icon={<Pencil aria-hidden="true" />}>{newCount ? `生成 ${newCount} 张彩铅图` : recoverable.length ? `恢复 ${recoverable.length} 张已有结果` : waiting.length ? `继续等待 ${waiting.length} 个任务` : "生成彩铅图"}</Button> : null}
                        <Button type="primary" disabled={busy || loading || !ready.length} icon={<Check aria-hidden="true" />} onClick={() => controller.apply()}>{ready.length ? `使用 ${ready.length} 张彩铅图` : "使用彩铅图"}</Button>
                    </div>
                </footer>
            </div>
        </Modal>
    );
}
