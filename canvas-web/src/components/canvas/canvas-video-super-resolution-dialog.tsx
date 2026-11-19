import { useEffect, useRef, useState } from "react";
import { Button, Modal, Select } from "antd";
import { ArrowUpRight, Info, ScanLine } from "lucide-react";

import { requestCreditEstimate } from "@/constant/credits";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelDisplayName, modelOptionName, resolveModelChannel, resolveModelRequestConfig, useEffectiveConfig } from "@/stores/use-config-store";
import { inspectSuperResolutionSource, prepareSuperResolutionSource, type PreparedSuperResolutionSource, type VideoSuperResolutionSelection } from "@/services/canvas-video-super-resolution";
import type { CanvasNodeData } from "@/types/canvas";
import "./canvas-video-super-resolution-dialog.css";

export function CanvasVideoSuperResolutionDialog({ node, submitting, onClose, onConfirm }: {
    node: CanvasNodeData;
    submitting: boolean;
    onClose: () => void;
    onConfirm: (selection: VideoSuperResolutionSelection) => Promise<void>;
}) {
    const config = useEffectiveConfig();
    const models = config.videoModels.filter((value) => {
        const channel = resolveModelChannel(config, value);
        return channel.scope === "system" && channel.enabled !== false && resolveModelRequestConfig(config, value).interfaceType === "tencent-mps-video";
    });
    const [model, setModel] = useState("");
    const [resolution, setResolution] = useState("");
    const [fps, setFps] = useState(0);
    const [source, setSource] = useState<PreparedSuperResolutionSource>();
    const [sourceError, setSourceError] = useState("");
    const [retry, setRetry] = useState(0);
    const sourceRequest = useRef<{ key: string; promise: ReturnType<typeof prepareSuperResolutionSource> } | null>(null);
    const sourceKey = JSON.stringify([node.id, node.metadata?.content, node.metadata?.storageKey]);
    const hasModel = models.length > 0;
    useEffect(() => {
        if (!hasModel) return;
        let active = true;
        setSource(undefined);
        setSourceError("");
        // 探测失败重试复用已上传资源，避免重复导入占用用户存储额度。
        if (sourceRequest.current?.key !== sourceKey) {
            const promise = prepareSuperResolutionSource(node);
            sourceRequest.current = { key: sourceKey, promise };
            void promise.catch(() => { if (sourceRequest.current?.promise === promise) sourceRequest.current = null; });
        }
        void sourceRequest.current.promise.then((reference) => active ? inspectSuperResolutionSource(node, reference) : undefined).then((value) => { if (active && value) setSource(value); }).catch((error: unknown) => {
            if (active) setSourceError(error instanceof Error ? error.message : "读取原视频失败，请重试");
        });
        return () => { active = false; };
    }, [hasModel, sourceKey, retry]);
    const selectedModel = model || models[0] || "";
    const capability = selectedModel ? modelCapabilityConfigFor(config, selectedModel)?.video : undefined;
    const resolutions = capability?.resolutions || [];
    const selectedResolution = resolutions.includes(resolution) ? resolution : capability?.defaultResolution || resolutions[0] || "";
    const channel = selectedModel ? resolveModelChannel(config, selectedModel) : undefined;
    const sourceMatches = source?.content === node.metadata?.content && source?.storageKey === node.metadata?.storageKey && source?.reference.id === node.id;
    const seconds = sourceMatches ? Math.ceil((source?.reference.durationMs || 0) / 1000) : 0;
    const outputFps = fps || (sourceMatches ? source?.frameRate || 0 : 0);
    const estimate = requestCreditEstimate({ channelMode: "remote", modelCosts: channel?.modelCosts, model: modelOptionName(selectedModel), seconds, resolution: selectedResolution, referenceVideoCount: 1, frameRate: outputFps });
    const canSubmit = sourceMatches && models.includes(selectedModel) && resolutions.includes(selectedResolution) && seconds > 0 && seconds <= 3600 && outputFps > 0 && outputFps <= 120 && estimate.kind === "exact";

    return <Modal
        className="canvas-super-resolution-dialog"
        title={<div className="canvas-super-resolution-heading"><span className="canvas-super-resolution-icon"><ScanLine aria-hidden /></span><span>视频超分</span></div>}
        open centered destroyOnHidden width="min(var(--modal-max-width), calc(100vw - var(--space-8)))"
        styles={{
            container: { padding: 0, borderRadius: "var(--modal-radius)", overflow: "hidden" },
            header: { margin: 0, padding: "var(--space-5) var(--space-6)" },
            body: { padding: "0 var(--space-6) var(--space-5)", maxHeight: "calc(100dvh - var(--space-24) * 2)", overflowY: "auto" },
            footer: { margin: 0, padding: "var(--space-4) var(--space-6)", borderTop: "var(--stroke-1) solid var(--border-semantic)" },
        }}
        closable={!submitting} maskClosable={!submitting} keyboard={!submitting} onCancel={onClose}
        footer={<div className="canvas-super-resolution-footer">
            <div className="canvas-super-resolution-cost" aria-live="polite">
                <span>预计消耗</span>
                <strong>{seconds > 0 && estimate.kind === "exact" ? `${estimate.credits.toLocaleString("zh-CN", { maximumFractionDigits: 4 })} 积分` : "—"}</strong>
            </div>
            <Button type="primary" className="canvas-super-resolution-submit" disabled={!canSubmit} loading={submitting} onClick={() => { if (source && canSubmit) void onConfirm({ model: selectedModel, resolution: selectedResolution, fps, source }); }}>开始超分<ArrowUpRight size={16} aria-hidden /></Button>
        </div>}
    >
        <div className="canvas-super-resolution-body" data-canvas-no-zoom data-canvas-wheel-scroll>
            <div className="canvas-super-resolution-source">
                <div className="canvas-super-resolution-thumbnail">
                    <video aria-label="原视频预览" src={node.metadata?.content} muted playsInline preload="metadata" />
                </div>
                <div className="canvas-super-resolution-source-info">
                    <span className="canvas-super-resolution-source-label">原视频<span>{seconds > 0 ? `${seconds} 秒 · ${source?.frameRate.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 帧/秒` : sourceError ? "读取失败" : hasModel ? "读取时长与帧率中…" : ""}</span></span>
                    <div className="canvas-super-resolution-source-name" title={node.title}>{node.title || "未命名视频"}</div>
                    <p>保持原比例与音轨</p>
                </div>
            </div>
            <div className="canvas-super-resolution-field"><label htmlFor="video-super-resolution-model">超分模型</label>
                <Select id="video-super-resolution-model" className="canvas-super-resolution-model" size="large" value={selectedModel || undefined} disabled={submitting || !models.length} placeholder="暂无可用超分模型" options={models.map((value) => ({ value, label: modelDisplayName(config, value) }))} onChange={(value) => { setModel(value); setResolution(""); }} />
            </div>
            <div className="canvas-super-resolution-field"><div id="video-super-resolution-label">目标分辨率</div>
                <div className="canvas-super-resolution-options" role="group" aria-labelledby="video-super-resolution-label">
                    {(resolutions.length ? resolutions : ["720p", "1080p", "1440p", "2160p"]).map((value) => <button key={value} type="button" disabled={submitting || !resolutions.length} aria-pressed={selectedResolution === value} className="canvas-super-resolution-option" onClick={() => setResolution(value)}>{value === "1440p" ? "2K" : value === "2160p" ? "4K" : value.toUpperCase()}</button>)}
                </div>
            </div>
            <div className="canvas-super-resolution-field"><label htmlFor="video-super-resolution-fps">输出帧率</label>
                <Select id="video-super-resolution-fps" className="canvas-super-resolution-model" size="large" disabled={submitting} value={fps} onChange={setFps} options={[{ value: 0, label: "保持原帧率" }, ...[24, 25, 30, 50, 60, 120].map((value) => ({ value, label: `${value} 帧/秒` }))]} />
            </div>
            {sourceError ? <div role="alert" className="canvas-super-resolution-note"><p>{sourceError}</p><Button size="small" disabled={submitting} onClick={() => setRetry((value) => value + 1)}>重试</Button></div> : null}
            <div className="canvas-super-resolution-note"><Info size={14} aria-hidden /><p>{!models.length ? "超分暂未开放，模型启用后即可使用。" : outputFps > 120 ? "原视频超过 120 帧，请选择较低的输出帧率。" : source && estimate.kind !== "exact" ? "当前分辨率或帧率尚未配置价格，请联系管理员。" : "按分钟计费，不足一分钟按一分钟计算。帧率越高，费用可能越高；调整帧率不等于 AI 补帧。结果保存为新视频。"}</p></div>
        </div>
    </Modal>;
}
