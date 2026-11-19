import { ipcMain } from '../security/trustedIpc';
import type { StoryboardBatchInput } from '@doubao-studio/contracts';
import { replaceIpcHandlers } from '../ipc/lifecycle';
import { storyboardBatchService } from '../services/storyboardBatchService';

const CHANNELS = [
  'storyboardBatch:list', 'storyboardBatch:create', 'storyboardBatch:prepare',
  'storyboardBatch:start', 'storyboardBatch:pause', 'storyboardBatch:recover',
  'storyboardBatch:open', 'storyboardBatch:retryDownload', 'storyboardBatch:remove',
  'storyboardBatch:restoreUnsent',
] as const;

export function registerStoryboardBatchIPC(): () => void {
  const dispose = replaceIpcHandlers(ipcMain, CHANNELS);
  ipcMain.handle('storyboardBatch:list', () => storyboardBatchService.list());
  ipcMain.handle('storyboardBatch:create', (_event, input: StoryboardBatchInput) => storyboardBatchService.create(input));
  ipcMain.handle('storyboardBatch:prepare', (_event, id: string) => storyboardBatchService.prepare(String(id)));
  ipcMain.handle('storyboardBatch:start', (_event, id: string) => storyboardBatchService.start(String(id)));
  ipcMain.handle('storyboardBatch:pause', (_event, id: string) => storyboardBatchService.pause(String(id)));
  ipcMain.handle('storyboardBatch:recover', (_event, id: string) => storyboardBatchService.recover(String(id)));
  ipcMain.handle('storyboardBatch:restoreUnsent', (_event, payload: { id: string; rowId: string; confirmedNotSent: boolean }) => storyboardBatchService.restoreUnsent(String(payload.id), String(payload.rowId), payload.confirmedNotSent));
  ipcMain.handle('storyboardBatch:open', (_event, id: string) => storyboardBatchService.open(String(id)));
  ipcMain.handle('storyboardBatch:remove', (_event, id: string) => storyboardBatchService.remove(String(id)));
  ipcMain.handle('storyboardBatch:retryDownload', (_event, payload: { id: string; rowId: string }) => storyboardBatchService.retryDownload(String(payload.id), String(payload.rowId)));
  return () => { storyboardBatchService.dispose(); dispose(); };
}
