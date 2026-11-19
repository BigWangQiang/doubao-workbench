import type { Account, LogAppendParams, Task } from '@doubao-studio/contracts';

function nonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * 在唯一日志写入口补齐任务快照，避免任务或账号以后删除时丢失审计上下文。
 * 仅从既有任务/账号结构读取，不解析消息文本，也不会把 CK 或代理凭据写入日志。
 */
export function enrichLogContext(
  entry: LogAppendParams,
  tasks: readonly Task[],
  accounts: readonly Account[],
): LogAppendParams {
  const taskId = nonEmptyString(entry.taskId);
  const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
  const accountId = nonEmptyString(entry.accountId) ?? nonEmptyString(task?.assignedAccountId);
  const account = accountId ? accounts.find((item) => item.id === accountId) : undefined;
  const accountName = nonEmptyString(entry.accountName) ?? nonEmptyString(account?.name);
  const accountPlatform = entry.accountPlatform
    ?? account?.platform
    ?? task?.targetPlatform
    ?? (account || task ? 'doubao' : undefined);
  const mode = entry.mode ?? task?.runtime?.input.mode ?? task?.mode;
  const prompt = entry.prompt ?? task?.runtime?.input.prompt ?? task?.prompt;

  return {
    ...entry,
    ...(accountId ? { accountId } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountPlatform ? { accountPlatform } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof prompt === 'string' ? { prompt } : {}),
  };
}
