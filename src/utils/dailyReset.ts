/** 返回运行机器本地时区的自然日键（YYYY-MM-DD）。 */
export function localDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 判断当前本地自然日是否已经变化；供休眠/页面恢复后的补偿检查使用。 */
export function hasLocalDateChanged(previousDateKey: string, now: Date = new Date()): boolean {
  return previousDateKey !== localDateKey(now);
}

/** 距离本机下一个自然日 00:00 的毫秒数。 */
export function millisecondsUntilNextLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}
