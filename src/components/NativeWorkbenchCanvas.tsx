import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import { useTaskStore } from '../store/useTaskStore';
import '../styles/native-workbench-canvas.css';

const canvasURL = import.meta.env.DEV
    ? `${import.meta.env.VITE_CANVAS_DEV_SERVER_URL || 'http://127.0.0.1:5174/'}`
    : 'lalor-canvas://app/index.html';
export const WorkbenchCanvas: React.FC = () => {
    const frame = useRef<HTMLIFrameElement>(null);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState('');
    useEffect((): (() => void) => {
        const listener = (event: MessageEvent): void => {
            const origin = canvasURL.startsWith('lalor-canvas:') ? 'lalor-canvas://app' : new URL(canvasURL).origin;
            if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
            if (event.data?.channel === 'lalor-canvas:ready') { setReady(true); setError(''); return; }
            if (event.data?.channel !== 'lalor-canvas:request' || typeof event.data.id !== 'string' || typeof event.data.method !== 'string') return;
            const { id, method, payload } = event.data;
            const reply = (response: Record<string, unknown>): void => { frame.current?.contentWindow?.postMessage({ channel: 'lalor-canvas:reply', id, ...response }, event.origin === 'null' ? '*' : event.origin); };
            const run = async (): Promise<unknown> => {
                if (!window.electronAPI?.workbenchCanvas?.invoke || !window.electronAPI?.workbenchApi) {
                    throw new Error('当前工作台仍在运行旧版画布接口，请重新启动本地工作台后再试；原有数据会保留。');
                }
                if (method === 'api.settings') return window.electronAPI.workbenchApi.get();
                const value = await window.electronAPI.workbenchCanvas.invoke(method, payload);
                if (method === 'tasks.create' || method === 'tasks.cancel') {
                    if (method === 'tasks.cancel') window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: payload?.id } }));
                    // 本地 TaskService 已落盘，再刷新同一个调度器；刷新失败也不能丢掉接单回执。
                    void useTaskStore.getState().loadTasks(false).then((): void => useTaskStore.getState().processQueue()).catch((): void => setError('任务已保存，任务列表刷新失败，请打开任务中心查看。'));
                }
                return value;
            };
            void run().then((value): void => reply({ value }), (reason: unknown): void => reply({ error: reason instanceof Error ? reason.message : '画布操作失败' }));
        };
        window.addEventListener('message', listener);
        const timer = setTimeout((): void => setError('画布尚未响应，请确认本地画布开发服务已启动。'), 60_000);
        return (): void => { window.removeEventListener('message', listener); clearTimeout(timer); };
    }, []);
    return <section className="native-workbench-canvas" aria-label="屿砚画布">
        {error && !ready ? <div className="native-workbench-canvas-feedback"><Alert type="warning" message={error} action={<Button onClick={(): void => { if (frame.current) frame.current.src = canvasURL; }}>重新加载</Button>} /></div> : null}
        <iframe ref={frame} src={canvasURL} title="屿砚画布" allow="clipboard-read; clipboard-write; fullscreen" />
    </section>;
};
