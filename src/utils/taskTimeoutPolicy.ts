import type { GenerationMode } from '@doubao-studio/contracts';

/**
 * 任务自动化的统一有界等待策略。
 *
 * 这些值只限制等待/轮询，不会触发额外提交；到达上限后调用方必须把
 * 任务落为失败或人工处理，避免 UI 无限转圈。
 */
export const TASK_TIMEOUT_POLICY = Object.freeze({
  submissionReadbackMs: 15_000,
  generationVideoMs: 60 * 60 * 1000,
  generationOtherMs: 10 * 60 * 1000,
  generationProbeIntervalMs: 3_000,
  artifactPollIntervalMs: 10_000,
  imageCaptureAttempts: 30,
  imageCaptureIntervalMs: 2_000,
  materialAuthorizationMs: 30 * 60 * 1000,
});

export function generationWaitBudgetMs(mode: GenerationMode): number {
  return mode === 'video'
    ? TASK_TIMEOUT_POLICY.generationVideoMs
    : TASK_TIMEOUT_POLICY.generationOtherMs;
}

export function generationPollLimit(mode: GenerationMode): number {
  return Math.ceil(generationWaitBudgetMs(mode) / TASK_TIMEOUT_POLICY.generationProbeIntervalMs);
}

export function artifactPollLimit(): number {
  return Math.ceil(TASK_TIMEOUT_POLICY.generationVideoMs / TASK_TIMEOUT_POLICY.artifactPollIntervalMs);
}
