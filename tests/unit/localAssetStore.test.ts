import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const testPaths = vi.hoisted(() => {
  const tempRoot = process.env.TEMP || process.env.TMP || '.';
  return { root: `${tempRoot}/doubao-local-assets-${Date.now()}-${Math.random().toString(16).slice(2)}` };
});

vi.mock('electron', () => ({
  app: { getPath: () => testPaths.root },
}));

import {
  listLocalAssets,
  registerDownloadedAsset,
  registerLocalAsset,
  resolveAssetFile,
} from '../../main/utils/localAssetStore';

afterAll(() => {
  fs.rmSync(testPaths.root, { recursive: true, force: true });
});

describe('local asset store', () => {
  it('copies a completed download into the controlled output directory with standard metadata', () => {
    const source = path.join(testPaths.root, 'Downloads', 'result.mp4');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, Buffer.from('video-bytes'));

    const asset = registerDownloadedAsset({
      assetId: 'job/one',
      taskId: 'task-video-1',
      kind: 'video',
      sourceFilePath: source,
      remoteUrl: 'https://cdn.example.com/result.mp4',
      accountId: 'dola-1',
      proxyId: 'proxy-1',
      tags: ['local-download', 'video'],
    });

    expect(asset.kind).toBe('video');
    expect(asset.taskId).toBe('task-video-1');
    expect(asset.accountId).toBe('dola-1');
    expect(asset.proxyId).toBe('proxy-1');
    expect(asset.localFilePath).toContain(path.join('DoubaoStudioData', 'local-assets'));
    expect(fs.readFileSync(asset.localFilePath, 'utf8')).toBe('video-bytes');
    expect(fs.readFileSync(source, 'utf8')).toBe('video-bytes');
    expect(resolveAssetFile(asset.assetId)).toBe(asset.localFilePath);
    expect(listLocalAssets()).toEqual([expect.objectContaining({ assetId: 'job/one', taskStatus: 'success' })]);
  });

  it('rejects paths outside the controlled asset directories', () => {
    const outside = path.join(testPaths.root, 'outside.bin');
    fs.writeFileSync(outside, 'x');
    expect(() => registerLocalAsset({
      assetId: 'outside',
      kind: 'file',
      localFilePath: outside,
      generatedAt: new Date().toISOString(),
      taskStatus: 'success',
      tags: [],
    })).toThrow('产物路径不在受控目录内');
  });
});
