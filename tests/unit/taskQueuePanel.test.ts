import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { isTaskVisibleInProject } from '../../src/utils/taskVisibility';

describe('2.5.1 task queue layout regression', () => {
  const railSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'WorkspaceRail.tsx'), 'utf8');
  const componentSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'TaskConsole.tsx'), 'utf8');
  const stylesSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'styles', 'global.css'), 'utf8');
  const taskIpcSource = readFileSync(resolve(__dirname, '..', '..', 'main', 'ipc', 'tasks.ts'), 'utf8');

  it('keeps the original task queue navigation name', () => {
    expect(railSource).toContain("{ key: 'tasks' as const, label: '任务队列'");
    expect(railSource).not.toContain("{ key: 'tasks' as const, label: '任务列表'");
  });

  it('keeps the original single task-card list without an extra bottom panel', () => {
    expect(componentSource).toContain('className="task-list"');
    expect(componentSource).not.toContain('TaskQueuePanel');
    expect(componentSource).not.toContain('className="task-queue-panel"');
    expect(componentSource).not.toContain('当前队列为空');
    expect(stylesSource).not.toContain('.task-queue-panel');
  });

  it('preserves the existing queue scheduler rather than replacing it in the view', () => {
    expect(componentSource).toContain('processQueue');
    expect(componentSource).toContain('queuedCount');
    expect(componentSource).toContain('tasks.map(renderTaskItem)');
  });

  it('shows Lalor upstream tasks in the original list regardless of the selected local project', () => {
    const baseTask: Task = {
      id: 'remote-task',
      prompt: 'remote prompt',
      assignedAccountId: 'dola-1',
      status: 'generating',
      mode: 'video',
      result: null,
      outputs: [],
      source: 'lalor',
      projectId: 'default-project',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    };

    expect(isTaskVisibleInProject(baseTask, 'project-123')).toBe(true);
    expect(isTaskVisibleInProject({ ...baseTask, source: 'manual' }, 'project-123')).toBe(false);
    expect(isTaskVisibleInProject({ ...baseTask, source: 'manual', projectId: 'project-123' }, 'project-123')).toBe(true);
    expect(taskIpcSource).toContain("taskService.create(params, 'lalor')");
  });
});
