import type { DownloadJob, Task } from '@doubao-studio/contracts';

/**
 * Select only backup tasks that are provably still referenced by a completed
 * local download. An intentionally empty task list is otherwise left alone.
 */
export function selectTasksBackedByCompletedDownloads(
  currentTasks: readonly Task[],
  backupTasks: readonly Task[],
  downloads: readonly DownloadJob[],
  fileExists: (filePath: string) => boolean,
): Task[] {
  if (currentTasks.length > 0) return [];

  const referencedTaskIds = new Set(
    downloads
      .filter((job) => job.status === 'done' && typeof job.filePath === 'string' && job.filePath.length > 0 && fileExists(job.filePath))
      .map((job) => job.taskId)
      .filter((taskId) => taskId && !/^manual-/i.test(taskId)),
  );
  if (referencedTaskIds.size === 0) return [];
  return backupTasks.filter((task) => referencedTaskIds.has(task.id));
}
