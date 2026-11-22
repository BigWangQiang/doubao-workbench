import { describe, expect, it } from 'vitest';

// 发布门禁是 Node ESM 脚本；这里用动态导入避免把脚本纳入渲染进程类型图。
// @ts-expect-error JavaScript 门禁脚本提供运行时导出，测试只验证其公开函数。
const gatePromise = import('../../scripts/release-gate.mjs');

describe('release gate', () => {
  it('accepts an artifact buffer containing every required feature', async () => {
    const { ARTIFACT_FEATURES } = await gatePromise;
    const payload = Buffer.from(ARTIFACT_FEATURES.map((feature: { marker: string }) => feature.marker).join('\n'), 'utf8');
    expect(ARTIFACT_FEATURES.length).toBeGreaterThan(0);
    expect(ARTIFACT_FEATURES.every((feature: { marker: string }) => payload.includes(Buffer.from(feature.marker, 'utf8')))).toBe(true);
  });

  it('does not treat the incomplete 21:20 feature set as complete', async () => {
    const { ARTIFACT_FEATURES } = await gatePromise;
    const incomplete = Buffer.from('Lalor 账号中心 Lalor 会员已连接', 'utf8');
    const missing = ARTIFACT_FEATURES.filter((feature: { marker: string }) => !incomplete.includes(Buffer.from(feature.marker, 'utf8')));
    expect(missing.map((feature: { id: string }) => feature.id)).toEqual([
      'lalor-pairing-entry',
      'lalor-pairing-shell',
      'yuyan-account',
      'lalor-software-update',
      'zizi-plugin-page',
    ]);
  });

  it('requires the packaged desktop icon in the source tree', async () => {
    const { verifySourceTree } = await gatePromise;
    const report = verifySourceTree(process.cwd());
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'desktop-icon-source',
      ok: true,
    }));
  });
});
