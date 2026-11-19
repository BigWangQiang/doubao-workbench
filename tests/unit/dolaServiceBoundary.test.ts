import { describe, expect, it } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';

function fixture(initial: Task[] = []) {
  let stored = structuredClone(initial);
  const service = new TaskService({
    store: {
      read: () => structuredClone(stored),
      replace: (next: Task[]) => { stored = structuredClone(next); return true; },
    },
    defaultProjectId: () => 'default',
    accountPlatformById: (accountId) => accountId.startsWith('dola') ? 'dola' : 'doubao',
    id: () => 'new-task',
    now: () => 'now',
  });
  return { service, stored: () => stored };
}

describe('Dola service capability boundary', () => {
  it.each(['chat', 'image', 'music'] as const)('allows Dola %s tasks without a local capability restriction', (mode) => {
    const { service, stored } = fixture();
    const result = service.create({ prompts: [mode], mode, targetPlatform: 'dola' });
    expect(result.success).toBe(true);
    expect(stored()).toHaveLength(1);
  });

  it('continues to allow existing Doubao conversation and image modes', () => {
    const { service, stored } = fixture();
    expect(service.create({ prompts: ['chat'], mode: 'chat', targetPlatform: 'doubao' }).success).toBe(true);
    expect(service.create({ prompts: ['image'], mode: 'image', targetPlatform: 'doubao' }).success).toBe(true);
    expect(stored()).toHaveLength(2);
  });

  it('keeps platform matching while allowing legacy non-video Dola tasks', () => {
    const legacy: Task = {
      id: 'legacy', prompt: 'old', assignedAccountId: null, status: 'queued', mode: 'chat',
      targetPlatform: 'dola', result: null, outputs: [], artifacts: [], createdAt: 'old', updatedAt: 'old',
    };
    const { service, stored } = fixture([legacy]);
    expect(service.assign({ taskId: 'legacy', accountId: 'dola-1' }).success).toBe(true);
    expect(service.update({ taskId: 'legacy', updates: { prompt: 'still allowed' } }).success).toBe(true);
    expect(stored()[0].prompt).toBe('still allowed');
  });
});
