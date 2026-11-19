import { describe, expect, it } from 'vitest';
import type { DownloadJob, Task } from '@doubao-studio/contracts';
import { selectTasksBackedByCompletedDownloads } from '../../main/utils/taskStoreRecovery';

const task = (id: string): Task => ({
  id,
  prompt: id,
  assignedAccountId: null,
  status: 'paused',
  mode: 'video',
  result: null,
  outputs: [],
  artifacts: [],
  source: 'manual',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  dependsOnTaskIds: [],
  projectId: 'default-project',
});

const download = (taskId: string, status: DownloadJob['status'] = 'done', filePath = 'C:\\video.mp4'): DownloadJob => ({
  id: `download-${taskId}`,
  taskId,
  accountId: null,
  mode: 'video',
  url: 'https://cdn.example/video.mp4',
  status,
  attempts: 1,
  saveDir: 'C:\\downloads',
  filePath,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('task store backup recovery', () => {
  it('recovers only backup tasks referenced by an existing completed file', () => {
    const result = selectTasksBackedByCompletedDownloads(
      [],
      [task('keep'), task('ignore')],
      [download('keep'), download('ignore', 'failed')],
      (filePath) => filePath === 'C:\\video.mp4',
    );
    expect(result.map((item) => item.id)).toEqual(['keep']);
  });

  it('does not resurrect tasks when the current store is non-empty or only manual orphan IDs exist', () => {
    expect(selectTasksBackedByCompletedDownloads([task('current')], [task('backup')], [download('backup')], () => true)).toEqual([]);
    expect(selectTasksBackedByCompletedDownloads([], [task('backup')], [download('manual-123')], () => true)).toEqual([]);
  });
});
