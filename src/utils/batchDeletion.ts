import type { Account, Task } from '../types';

export interface BatchDeleteItem {
  id: string;
  label: string;
  detail?: string;
  blockedReason?: string;
  dependsOnIds?: string[];
}
export interface BatchDeleteResult {
  deletedIds: string[];
  failures: Array<{ id: string; label: string; error: string }>;
}
export interface DeleteItemResult { success: boolean; error?: string; }

export function taskDeletionBlocker(task: Task | undefined, executingIds: string[] = []): string | undefined {
  if (!task) return '任务已不存在，请刷新列表';
  if (!['queued', 'paused', 'done', 'fail', 'cancelled'].includes(task.status) || executingIds.includes(task.id)) {
    return '任务仍在执行，请先暂停';
  }
  if (task.lock && (!Number.isFinite(Date.parse(task.lock.expiresAt)) || Date.parse(task.lock.expiresAt) > Date.now())) return '任务执行锁尚未释放，请稍后重试';
  return undefined;
}

export function accountDeletionBlocker(account: Account | undefined, tasks: Task[], busy = false): string | undefined {
  if (!account) return '账号已不存在，请刷新列表';
  if (busy || account.status === 'busy') return '账号正在执行任务，请先暂停';
  const linked = tasks.filter(task => task.assignedAccountId === account.id && (
    !['paused', 'done', 'fail', 'cancelled'].includes(task.status) || Boolean(taskDeletionBlocker(task))
  )).length;
  return linked ? `仍有 ${linked} 个排队或运行中任务，请先暂停或改派` : undefined;
}

/** 先删选中项中的后置任务；未选中的依赖关系仍由主进程最终校验。 */
export function orderBatchDeletion(items: readonly BatchDeleteItem[]): BatchDeleteItem[] {
  const remaining = new Map(items.map(item => [item.id, item]));
  const ordered: BatchDeleteItem[] = [];
  while (remaining.size) {
    const referenced = new Set([...remaining.values()].flatMap(item => item.dependsOnIds || []));
    const leaves = [...remaining.values()].filter(item => !referenced.has(item.id));
    // 循环依赖不擅自解除，交给原删除接口返回具体失败原因。
    if (!leaves.length) { ordered.push(...remaining.values()); break; }
    for (const item of leaves) { ordered.push(item); remaining.delete(item.id); }
  }
  return ordered;
}

export async function runBatchDeletion(
  items: readonly BatchDeleteItem[],
  remove: (id: string) => Promise<DeleteItemResult>,
  onProgress: (completed: number) => void,
): Promise<BatchDeleteResult> {
  const result: BatchDeleteResult = { deletedIds: [], failures: [] };
  const ordered = orderBatchDeletion(items);
  // 逐项等待真实回执，不并发改写账号/任务文件，不自动重试删除。
  for (const item of ordered) {
    try {
      const response = item.blockedReason ? { success: false, error: item.blockedReason } : await remove(item.id);
      if (response.success) result.deletedIds.push(item.id);
      else result.failures.push({ id: item.id, label: item.label, error: response.error || '删除失败，请重试' });
    } catch (error: unknown) {
      result.failures.push({ id: item.id, label: item.label, error: error instanceof Error ? error.message : '删除失败，请重试' });
    }
    onProgress(result.deletedIds.length + result.failures.length);
  }
  return result;
}
