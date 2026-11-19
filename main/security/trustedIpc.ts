import { app, ipcMain as electronIpc, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { fileURLToPath } from 'url';
import * as path from 'path';

let mainWindow: BrowserWindow | undefined;
export function trustWorkbenchWindow(window: BrowserWindow): void { mainWindow = window; }

export function isTrustedRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') {
      const expected = path.resolve(__dirname, '../../renderer/index.html');
      return path.resolve(fileURLToPath(url)).toLowerCase() === expected.toLowerCase();
    }
    const dev = process.env.VITE_DEV_SERVER_URL;
    return !app.isPackaged && Boolean(dev) && url.origin === new URL(dev!).origin;
  } catch { return false; }
}

export function assertTrustedIpc(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
    || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url)) {
    throw new Error('该操作只允许工作台主窗口调用');
  }
}

type Listener = (event: IpcMainEvent, ...args: any[]) => void;
const listeners = new Map<string, Map<Listener, Listener>>();
// 显式注册边界，避免修改 Electron 全局对象或把远程 webview 当可信渲染器。
export const ipcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    electronIpc.handle(channel, (event, ...args) => { assertTrustedIpc(event); return listener(event, ...args); });
  },
  removeHandler(channel: string): void { electronIpc.removeHandler(channel); },
  on(channel: string, listener: Listener): void {
    const guarded: Listener = (event, ...args): void => {
      try { assertTrustedIpc(event); } catch { return; }
      listener(event, ...args);
    };
    const entries = listeners.get(channel) || new Map<Listener, Listener>();
    const previous = entries.get(listener);
    if (previous) electronIpc.removeListener(channel, previous);
    entries.set(listener, guarded);
    listeners.set(channel, entries);
    electronIpc.on(channel, guarded);
  },
  removeListener(channel: string, listener: Listener): void {
    const entries = listeners.get(channel);
    const guarded = entries?.get(listener);
    if (guarded) electronIpc.removeListener(channel, guarded);
    entries?.delete(listener);
    if (!entries?.size) listeners.delete(channel);
  },
};
