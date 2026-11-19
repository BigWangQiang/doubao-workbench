import { ipcRenderer } from 'electron';

// 仅驻留 Electron 隔离世界；不向豆包主页面暴露通用 IPC、文件或网络能力。
const parserWorld = globalThis as typeof globalThis & {
  __lalorCanvasParserTransport?: {
    send: (message: unknown) => void;
    listen: (listener: (message: unknown) => void) => void;
    unlisten: (listener: (message: unknown) => void) => void;
  };
};
const listeners = new Map<(message: unknown) => void, (_event: Electron.IpcRendererEvent, message: unknown) => void>();
parserWorld.__lalorCanvasParserTransport = {
  send: (message: unknown): void => ipcRenderer.send('storyboard-parser:action', message),
  listen: (listener: (message: unknown) => void): void => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown): void => listener(message);
    listeners.set(listener, handler);
    ipcRenderer.on('storyboard-parser:message', handler);
  },
  unlisten: (listener: (message: unknown) => void): void => {
    const handler = listeners.get(listener);
    if (!handler) return;
    ipcRenderer.removeListener('storyboard-parser:message', handler);
    listeners.delete(listener);
  },
};
