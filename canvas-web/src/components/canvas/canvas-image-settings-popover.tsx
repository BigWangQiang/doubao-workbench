import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Ratio } from "lucide-react";
import { Button, Popover } from "antd";

import "@/components/studio-composer.css";
import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, normalizeImageValue } from "@/lib/model-capabilities";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    showCount?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, getPopupContainer, placement = "topLeft", autoAdjustOverflow = true, showCount = true }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    const [open, setOpen] = useState(false);
    const profile = modelCapabilityConfigFor(config, config.model || config.imageModel).image!;
    const normalized = normalizeImageValue(profile, config);
    const summaryParts = [
        ...(profile.size.parameter !== "none" ? [imageSizeLabel(normalized.size)] : []),
        ...(profile.quality.supported ? [imageQualityLabel(normalized.quality)] : []),
        ...(showCount && profile.maxOutputs > 1 ? [`${normalized.count} 张`] : []),
        ...(profile.transparentBackground.supported && normalized.transparentBackground === "true" ? ["透明"] : []),
    ];
    const summary = summaryParts.join(" · ");
    const hasSettings = profile.size.parameter !== "none" || profile.quality.supported || profile.transparentBackground.supported || (showCount && profile.maxOutputs > 1);
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            onOpenChange?.(false);
            buttonRef.current?.focus();
        };
        window.addEventListener("keydown", closeOnEscape, true);
        return () => window.removeEventListener("keydown", closeOnEscape, true);
    }, [onOpenChange, open]);

    if (!hasSettings) return null;

    return (
        <Popover
            open={open}
            onOpenChange={updateOpen}
            trigger="click"
            placement={placement}
            arrow={false}
            destroyOnHidden
            autoAdjustOverflow={autoAdjustOverflow}
            getPopupContainer={getPopupContainer}
            classNames={{ root: "canvas-settings-popover", container: "canvas-settings-popover-container" }}
            styles={{ container: { padding: 0, background: "transparent", boxShadow: "none" } }}
            // 与视频参数共用 AntD 的弹窗层级及定位，放大编辑时仍能点击和滚动。
            content={
                <div
                    id={panelId}
                    role="dialog"
                    aria-label="图像设置"
                    data-canvas-no-zoom
                    data-canvas-wheel-scroll
                    className="canvas-image-settings-popover canvas-image-settings-popover-segmented canvas-settings-popover-panel"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                >
                    <ImageSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} showTitle={false} showCount={showCount} quickCount={3} variant="canvas" className="canvas-image-settings-panel" />
                </div>
            }
        >
            <Button ref={buttonRef} size="small" type="text" className={`canvas-generation-settings-trigger ${buttonClassName || "canvas-settings-default-trigger"}`} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Ratio className="size-3.5" />} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog" aria-label={`图像设置：${summary}`} title={`图像设置 · ${summary}`}>
                <span className="truncate">{summary}</span>
                <ChevronDown className="canvas-image-settings-chevron size-3" />
                <span className="canvas-image-settings-dot" aria-hidden />
            </Button>
        </Popover>
    );
}
