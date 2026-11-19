export const isDesktop = window.parent !== window;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let requestId = 0;
window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || event.data?.channel !== 'lalor-canvas:reply') return;
    const request = pending.get(event.data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.value);
});

/** 仅允许宿主工作台响应，画布拿不到 Electron API 或账号凭据。 */
export function desktopCall<T>(method: string, payload?: unknown): Promise<T> {
    if (!isDesktop) return Promise.reject(new Error('请在工作台中执行生成；浏览器预览只用于编辑与本地素材。'));
    const id = `canvas-${++requestId}`;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('工作台响应超时，请查看任务中心；已提交任务不会自动重发。')); }, 120_000);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        window.parent.postMessage({ channel: 'lalor-canvas:request', id, method, payload }, '*');
    });
}
