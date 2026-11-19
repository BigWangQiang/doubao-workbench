import { describe, expect, it } from 'vitest';
import {
  artifactPollLimit,
  generationPollLimit,
  generationWaitBudgetMs,
  TASK_TIMEOUT_POLICY,
} from '../../src/utils/taskTimeoutPolicy';

describe('task timeout policy', () => {
  it('为视频和非视频任务提供明确且有限的等待上限', () => {
    expect(generationWaitBudgetMs('video')).toBe(60 * 60 * 1000);
    expect(generationWaitBudgetMs('image')).toBe(10 * 60 * 1000);
    expect(generationWaitBudgetMs('chat')).toBe(10 * 60 * 1000);
  });

  it('轮询次数由上限和间隔计算，不允许无限轮询', () => {
    expect(generationPollLimit('video')).toBeGreaterThan(0);
    expect(generationPollLimit('video') * TASK_TIMEOUT_POLICY.generationProbeIntervalMs)
      .toBeGreaterThanOrEqual(TASK_TIMEOUT_POLICY.generationVideoMs);
    expect(artifactPollLimit()).toBeGreaterThan(0);
  });
});
