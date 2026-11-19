import { App, Input, Modal } from "antd";
import { useEffect, useState, type ReactNode } from "react";

import { localizeErrorMessage } from "@/lib/generation-error";
import "./delete-confirmation.css";

const acceptsDeletion = (value: string) => ["确认删除", "确定删除"].includes(value.trim());
const confirmationActions = {
    delete: {
        verb: "删除", okText: "删除", cancelText: "取消",
        hint: "请输入“确认删除”或“确定删除”后点击删除",
        invalidMessage: "请输入确认删除或确定删除",
        failureMessage: "删除失败，请重试", accepts: acceptsDeletion,
    },
    cancelVideo: {
        verb: "取消", okText: "仍要取消", cancelText: "继续等待",
        hint: <>请输入“<strong className="cancel-confirmation-keyword">确认取消</strong>”后点击“仍要取消”</>,
        invalidMessage: "请输入确认取消",
        failureMessage: "任务取消失败，请重试",
        accepts: (value: string) => value.trim() === "确认取消",
    },
};

type DeleteOptions = {
    title: string;
    targetLabel: string;
    description: ReactNode;
    onConfirm: () => unknown | Promise<unknown>;
};

function ActionChallenge({ targetLabel, description, value, onChange, disabled, error, action = "delete" }: {
    targetLabel: string;
    description: ReactNode;
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
    error?: string;
    action?: keyof typeof confirmationActions;
}) {
    const copy = confirmationActions[action];
    return <div className="delete-confirmation-body">
        <p className="delete-confirmation-question">您确认要{copy.verb} <strong>【{targetLabel}】</strong> 吗？</p>
        <div className="delete-confirmation-description">{description}</div>
        <label className="delete-confirmation-field">
            <span>输入{copy.verb}确认文字</span>
            <Input autoFocus size="large" className={action === "cancelVideo" && copy.accepts(value) ? "cancel-confirmation-input" : undefined} aria-label={`${copy.verb}确认文字`} placeholder={action === "cancelVideo" ? "请输入确认取消" : "请输入"} value={value} disabled={disabled} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
        </label>
        <p className="delete-confirmation-hint">{copy.hint}</p>
        {error ? <p className="delete-confirmation-error" role="alert">{error}</p> : null}
    </div>;
}

export function DeleteConfirmationDialog({ open, targetKey, onCancel, loading = false, title, targetLabel, description, onConfirm }: DeleteOptions & {
    open: boolean;
    targetKey: string;
    onCancel: () => void;
    loading?: boolean;
}) {
    const [value, setValue] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const busy = submitting || loading;
    useEffect(() => { setValue(""); setError(""); }, [open, targetKey]);
    const confirm = async () => {
        // 禁用按钮之外再校验一次，键盘和异步回调也不能绕过确认文字。
        if (busy || !acceptsDeletion(value)) return;
        setSubmitting(true);
        setError("");
        try { await onConfirm(); }
        catch (cause) { setError(localizeErrorMessage(cause, "删除失败，请重试")); }
        finally { setSubmitting(false); }
    };
    return <Modal className="typed-delete-modal" title={title} open={open} centered width="calc(var(--space-24) * 6 + var(--space-16))" closable={!busy} maskClosable={false} keyboard={!busy}
        onCancel={() => { if (!busy) onCancel(); }} onOk={() => void confirm()} okText="删除" cancelText="取消" confirmLoading={busy} okButtonProps={{ danger: true, disabled: !acceptsDeletion(value) }} cancelButtonProps={{ disabled: busy }} destroyOnHidden>
        <ActionChallenge targetLabel={targetLabel} description={description} value={value} onChange={setValue} disabled={busy} error={error} />
    </Modal>;
}

type AppModal = ReturnType<typeof App.useApp>["modal"];

export function confirmDeletion(modal: AppModal, options: DeleteOptions & { afterClose?: () => void }) {
    return confirmAction(modal, { ...options, action: "delete" });
}

export function confirmVideoCancellation(modal: AppModal, options: Omit<DeleteOptions, "targetLabel">) {
    return confirmAction(modal, { ...options, targetLabel: "当前视频生成任务", action: "cancelVideo" });
}

/** 删除与取消复用输入校验和异步提交状态，避免画布各入口漏掉确认保护。 */
function confirmAction(modal: AppModal, { title, targetLabel, description, onConfirm, afterClose, action }: DeleteOptions & { afterClose?: () => void; action: keyof typeof confirmationActions }) {
    const copy = confirmationActions[action];
    let value = "";
    let busy = false;
    let error = "";
    const content = () => <ActionChallenge action={action} targetLabel={targetLabel} description={description} value={value} disabled={busy} error={error} onChange={(next) => {
        if (busy) return;
        value = next;
        dialog.update({ content: content(), okButtonProps: { danger: true, disabled: !copy.accepts(value) } });
    }} />;
    const dialog = modal.confirm({
        className: "typed-delete-modal",
        title, icon: null, centered: true, closable: true, maskClosable: false,
        width: "calc(var(--space-24) * 6 + var(--space-16))",
        content: content(), okText: copy.okText, cancelText: copy.cancelText, autoFocusButton: null,
        okButtonProps: { danger: true, disabled: true }, afterClose,
        onOk: async () => {
            // 按钮禁用之外再次校验，不能通过键盘或重复回调绕过确认文字。
            if (busy || !copy.accepts(value)) throw new Error(copy.invalidMessage);
            busy = true;
            error = "";
            dialog.update({ closable: false, keyboard: false, cancelButtonProps: { disabled: true }, content: content() });
            try { await onConfirm(); }
            catch (cause) {
                busy = false;
                error = localizeErrorMessage(cause, copy.failureMessage);
                dialog.update({ closable: true, keyboard: true, cancelButtonProps: { disabled: false }, content: content() });
                throw cause;
            }
        },
    });
    return dialog;
}
