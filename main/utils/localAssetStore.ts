import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { LocalAssetMetadata } from '@doubao-studio/contracts';
import { getDataDir, readJSON, writeJSON } from './store';

const ASSET_FILE = 'local-assets.json';
const ASSET_DIR = 'local-assets';

export interface DownloadedAssetInput {
  assetId: string;
  taskId?: string;
  kind: LocalAssetMetadata['kind'];
  sourceFilePath: string;
  remoteUrl?: string;
  generatedAt?: string;
  accountId?: string;
  proxyId?: string;
  taskStatus?: LocalAssetMetadata['taskStatus'];
  tags?: string[];
}

function loadAssets(): LocalAssetMetadata[] {
  const raw = readJSON<unknown>(ASSET_FILE, []);
  return Array.isArray(raw) ? raw as LocalAssetMetadata[] : [];
}

function saveAssets(assets: LocalAssetMetadata[]): void {
  if (!writeJSON(ASSET_FILE, assets)) throw new Error('本地产物索引写入失败');
}

function ensureAssetDir(): string {
  const directory = path.join(getDataDir(), ASSET_DIR);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function registerLocalAsset(input: LocalAssetMetadata): LocalAssetMetadata {
  if (!input.assetId || !input.localFilePath) throw new Error('产物 ID 和本地路径不能为空');
  const assetDir = ensureAssetDir();
  const resolved = path.resolve(input.localFilePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('产物文件不存在');
  if (!isInsideDirectory(resolved, assetDir) && !isInsideDirectory(resolved, path.join(getDataDir(), 'artifacts'))) {
    throw new Error('产物路径不在受控目录内');
  }
  const assets = loadAssets();
  const next: LocalAssetMetadata = {
    ...input,
    assetId: input.assetId || `asset-${randomUUID()}`,
    tags: [...new Set(input.tags || [])],
  };
  const index = assets.findIndex((asset) => asset.assetId === next.assetId);
  if (index >= 0) assets[index] = next;
  else assets.push(next);
  saveAssets(assets);
  return { ...next };
}

export function listLocalAssets(): LocalAssetMetadata[] {
  return loadAssets().map((asset) => ({
    ...asset,
    tags: Array.isArray(asset.tags) ? [...asset.tags] : [],
  }));
}

export function updateLocalAssetStatus(assetId: string, status: LocalAssetMetadata['taskStatus']): boolean {
  const assets = loadAssets();
  const asset = assets.find((item) => item.assetId === assetId);
  if (!asset) return false;
  asset.taskStatus = status;
  saveAssets(assets);
  return true;
}

export function resolveAssetFile(assetId: string): string | null {
  const asset = loadAssets().find((item) => item.assetId === assetId);
  if (!asset || !asset.localFilePath) return null;
  const resolved = path.resolve(asset.localFilePath);
  const dataDir = getDataDir();
  if (!isInsideDirectory(resolved, path.join(dataDir, ASSET_DIR))
    && !isInsideDirectory(resolved, path.join(dataDir, 'artifacts'))) {
    return null;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function safeExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : '.bin';
}

function safeAssetStem(assetId: string): string {
  const stem = assetId.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return stem || `asset-${randomUUID()}`;
}

/**
 * Copy a completed download into the controlled local-assets directory and
 * write the standard metadata record. The user-selected download directory
 * remains untouched; this copy is the stable integration boundary for a
 * future Lalor reader.
 */
export function registerDownloadedAsset(input: DownloadedAssetInput): LocalAssetMetadata {
  if (!input.assetId.trim()) throw new Error('产物 ID 不能为空');
  const source = path.resolve(input.sourceFilePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('下载文件不存在');

  const directory = ensureAssetDir();
  const destination = path.join(directory, `${safeAssetStem(input.assetId)}${safeExtension(source)}`);
  if (source !== path.resolve(destination)) {
    const sourceSize = fs.statSync(source).size;
    let destinationSize: number | undefined;
    try { destinationSize = fs.statSync(destination).size; } catch { destinationSize = undefined; }
    if (destinationSize !== sourceSize) fs.copyFileSync(source, destination);
  }

  return registerLocalAsset({
    assetId: input.assetId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    kind: input.kind,
    localFilePath: destination,
    ...(input.remoteUrl ? { remoteUrl: input.remoteUrl } : {}),
    generatedAt: input.generatedAt || new Date().toISOString(),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.proxyId ? { proxyId: input.proxyId } : {}),
    taskStatus: input.taskStatus || 'success',
    tags: [...new Set(input.tags || [])],
  });
}
