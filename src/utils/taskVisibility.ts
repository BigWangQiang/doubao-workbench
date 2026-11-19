import type { Task } from '../types';

/** Lalor 下发任务属于全局执行队列，本地创建任务仍按项目隔离。 */
export function isTaskVisibleInProject(task: Task, activeProjectId: string): boolean {
  return task.source === 'lalor'
    || (task.projectId || 'default-project') === activeProjectId;
}
