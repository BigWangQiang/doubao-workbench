import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Ratio } from "lucide-react";
import { Button, Popover } from "antd";

import "@/components/studio-composer.css";
import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    const [open, setOpen] = useState(false);
    const summary = `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.size)} · ${videoSecondsLabel(config.videoSeconds)}`;

    useEffect(() => {
        if (!open) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            buttonRef.current?.focus();
        };
        window.addEventListener("keydown", closeOnEscape, true);
        return () => window.removeEventListener("keydown", closeOnEscape, true);
    }, [open]);

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            placement={placement}
            arrow={false}
            destroyOnHidden
            autoAdjustOverflow
            classNames={{ root: "canvas-settings-popover", container: "canvas-settings-popover-container" }}
            styles={{ container: { padding: 0, background: "transparent", boxShadow: "none" } }}
            // 使用 AntD 浮层上下文继承 Modal 层级，不能把参数面板固定在遮罩下面。
            content={
                <div
                    id={panelId}
                    role="dialog"
                    aria-label="视频设置"
                    data-canvas-no-zoom
                    data-canvas-wheel-scroll
                    className="canvas-image-settings-popover canvas-image-settings-popover-segmented canvas-video-settings-popover canvas-settings-popover-panel"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                >
                    <VideoSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} showTitle={false} variant="canvas" className="canvas-image-settings-panel canvas-video-settings-panel" />
                </div>
            }
        >
            <Button ref={buttonRef} size="small" type="text" className={`canvas-generation-settings-trigger ${buttonClassName || "canvas-settings-default-trigger"}`} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Ratio className="size-3.5" />} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog" aria-label={`视频设置：${summary}`} title={`视频设置 · ${summary}`}>
                <span className="truncate">{summary}</span>
                <ChevronDown className="canvas-image-settings-chevron size-3" />
                <span className="canvas-image-settings-dot" aria-hidden />
            </Button>
        </Popover>
    );
}
