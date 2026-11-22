/**
 * 发布产物硬性门禁。
 *
 * 目的：防止“源码/构建产物/桌面快捷方式”不是同一版本时仍然交付。
 * 该脚本只读检查（--write-manifest 仅在显式传入时写入发布目录），不读取
 * 用户数据、Cookie、CK、令牌或代理凭据。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ARTIFACT_FEATURES = Object.freeze([
  { id: 'lalor-pairing-entry', marker: '验证并连接' },
  { id: 'lalor-pairing-shell', marker: 'lalor-pairing-shell' },
  { id: 'yuyan-account', marker: '退出屿砚账号' },
  { id: 'lalor-software-update', marker: '重启并安装' },
  { id: 'zizi-plugin-page', marker: 'zizi-plugin-page' },
]);

export const SOURCE_FEATURES = Object.freeze([
  {
    id: 'account-canvas-parser-source',
    files: ['main/main.ts', 'main/services/accountCanvasParser.ts', 'main/services/canvasParserSnapshot.ts'],
    allOf: ['registerAccountCanvasParser(win.webContents', 'installStoryboardCanvasParser(guest)', 'canvasParserSnapshotScript'],
  },
  {
    id: 'lalor-software-update-source',
    files: ['main/services/softwareUpdater.ts', 'src/components/SoftwareUpdate.tsx'],
    allOf: ['https://yuyan-ai.site/desktop-updates/win-x64/', 'autoInstallOnAppQuit = false', '重启并安装'],
  },
  {
    id: 'yuyan-account-entry-source',
    files: ['src/App.tsx', 'src/components/PairingGatePage.tsx'],
    allOf: ["activeWorkspacePane === 'personal-center'", '<WorkspaceDashboard', '验证并连接'],
  },
  {
    id: 'lalor-pairing-source',
    files: ['src/components/PairingGatePage.tsx', 'main/ipc/yuyanAuth.ts'],
    allOf: ['一次性配对码', '/desktop/exchange', '/v1/desktop/license', 'verifyDesktopGrant'],
  },
  {
    id: 'yuyan-generation-source',
    files: ['main/config/yuyanPlatform.ts', 'main/services/yuyanCanvasApi.ts'],
    allOf: ['https://yuyan-ai.site', 'idempotencyKey', 'requireYuyanGenerationAccess'],
  },
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'RELEASE_GATE_FAILED';
  throw error;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`无法读取 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseAsarHeader(asarBytes) {
  if (asarBytes.length < 16) return null;
  // ASAR 的前 16 字节是 pickle 头；JSON 从偏移 16 开始，长度位于偏移 12。
  const jsonSize = asarBytes.readUInt32LE(12);
  const jsonStart = 16;
  const jsonEnd = jsonStart + jsonSize;
  if (jsonEnd > asarBytes.length) return null;
  try {
    return JSON.parse(asarBytes.subarray(jsonStart, jsonEnd).toString('utf8'));
  } catch {
    return null;
  }
}

function hasAsarEntry(header, entryPath) {
  const segments = entryPath.split('/').filter(Boolean);
  let node = header;
  for (const segment of segments) {
    if (!node || typeof node !== 'object' || !node.files || typeof node.files !== 'object') return false;
    node = node.files[segment];
  }
  return Boolean(node && typeof node === 'object');
}

function relativeToRoot(root, filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function sourceFeatureResult(root, feature) {
  const texts = feature.files
    .map((file) => ({ file, fullPath: path.resolve(root, file) }))
    .filter(({ fullPath }) => exists(fullPath))
    .map(({ file, fullPath }) => ({ file, text: readUtf8(fullPath) }));
  const missingFiles = feature.files.filter((file) => !exists(path.resolve(root, file)));
  const combined = texts.map(({ text }) => text).join('\n');
  const missingAll = (feature.allOf || []).filter((marker) => !combined.includes(marker));
  const hasAny = (feature.anyOf || []).length === 0 || feature.anyOf.some((marker) => combined.includes(marker));
  return {
    id: feature.id,
    ok: missingFiles.length === 0 && missingAll.length === 0 && hasAny,
    missingFiles,
    missingMarkers: missingAll,
    missingAnyOf: hasAny ? [] : feature.anyOf,
  };
}

export function verifySourceTree(root) {
  const absoluteRoot = path.resolve(root);
  const checks = SOURCE_FEATURES.map((feature) => sourceFeatureResult(absoluteRoot, feature));
  const iconFiles = ['build/yuyan-workbench.ico', 'src/assets/yuyan-workbench.png'];
  const missingIcons = iconFiles.filter((file) => !exists(path.join(absoluteRoot, file)));
  checks.push({
    id: 'desktop-icon-source',
    ok: missingIcons.length === 0,
    missingFiles: missingIcons,
    missingMarkers: [],
    missingAnyOf: [],
  });
  const buildIndex = path.join(absoluteRoot, 'dist', 'renderer', 'index.html');
  const rendererAssets = path.join(absoluteRoot, 'dist', 'renderer', 'assets');
  const bundleFiles = exists(rendererAssets)
    ? fs.readdirSync(rendererAssets).filter((name) => name.startsWith('index-') && name.endsWith('.js'))
    : [];
  if (!exists(buildIndex) || bundleFiles.length === 0) {
    checks.push({
      id: 'renderer-build-output',
      ok: false,
      missingFiles: [
        !exists(buildIndex) ? relativeToRoot(absoluteRoot, buildIndex) : null,
        bundleFiles.length === 0 ? relativeToRoot(absoluteRoot, path.join(rendererAssets, 'index-*.js')) : null,
      ].filter(Boolean),
      missingMarkers: [],
      missingAnyOf: ['dist/renderer/assets/index-*.js'],
    });
  } else {
    const rendererText = [readUtf8(buildIndex), ...bundleFiles.map((name) => readUtf8(path.join(rendererAssets, name)))].join('\n');
    const missingMarkers = ARTIFACT_FEATURES.map((feature) => feature.marker).filter((marker) => !rendererText.includes(marker));
    checks.push({
      id: 'renderer-build-features',
      ok: missingMarkers.length === 0,
      missingFiles: [],
      missingMarkers,
      missingAnyOf: [],
    });
  }
  const canvasIndex = path.join(absoluteRoot, 'dist', 'renderer', 'canvas', 'index.html');
  checks.push({ id: 'independent-canvas-build', ok: exists(canvasIndex),
    missingFiles: exists(canvasIndex) ? [] : ['dist/renderer/canvas/index.html'], missingMarkers: [], missingAnyOf: [] });
  return makeReport('source', absoluteRoot, checks);
}

function locateAsar(inputPath) {
  const absolute = path.resolve(inputPath);
  if (!exists(absolute)) fail(`发布路径不存在: ${absolute}`);
  if (fs.statSync(absolute).isFile()) {
    if (path.basename(absolute).toLowerCase() !== 'app.asar') fail(`指定文件不是 app.asar: ${absolute}`);
    return absolute;
  }
  const directCandidates = [
    path.join(absolute, 'resources', 'app.asar'),
    path.join(absolute, 'win-unpacked', 'resources', 'app.asar'),
  ];
  const direct = directCandidates.find((candidate) => exists(candidate));
  if (direct) return direct;
  const matches = [];
  const walk = (directory, depth) => {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'app.asar') {
        matches.push(entryPath);
      }
    }
  };
  walk(absolute, 0);
  if (matches.length === 0) fail(`未找到 app.asar: ${absolute}`);
  if (matches.length > 1) fail(`发布路径包含多个 app.asar，拒绝猜测版本: ${matches.join(', ')}`);
  return matches[0];
}

function locateExecutable(asarPath) {
  const unpackedRoot = path.resolve(path.dirname(asarPath), '..');
  const isMac = path.basename(path.dirname(asarPath)) === 'Resources';
  const executableRoot = isMac ? path.join(unpackedRoot, 'MacOS') : unpackedRoot;
  const candidates = fs.readdirSync(executableRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (isMac || entry.name.toLowerCase().endsWith('.exe') && !/^uninstall\s/i.test(entry.name)))
    .map((entry) => path.join(executableRoot, entry.name));
  if (candidates.length !== 1) fail(`无法唯一确定发布可执行文件（找到 ${candidates.length} 个）: ${executableRoot}`);
  return candidates[0];
}

function makeReport(kind, location, checks, extra = {}) {
  const failures = checks.filter((check) => !check.ok);
  return {
    kind,
    location,
    ok: failures.length === 0,
    checks,
    failures,
    ...extra,
  };
}

export function verifyArtifact(inputPath) {
  const asarPath = locateAsar(inputPath);
  const asarBytes = fs.readFileSync(asarPath);
  const asarHeader = parseAsarHeader(asarBytes);
  const checks = ARTIFACT_FEATURES.map((feature) => ({
    id: feature.id,
    ok: asarBytes.includes(Buffer.from(feature.marker, 'utf8')),
    missingFiles: [],
    missingMarkers: asarBytes.includes(Buffer.from(feature.marker, 'utf8')) ? [] : [feature.marker],
    missingAnyOf: [],
  }));
  const parserFiles = ['manifest.json', 'background.js', 'content.js', 'panel.css', '使用说明.txt'];
  const parserRoot = path.join(path.dirname(asarPath), 'extensions', 'doubao-canvas-parser');
  const integrationFiles = ['dist/main/services/storyboardCanvasParser.js', 'dist/main/services/storyboardParserPreload.js', 'dist/main/services/accountCanvasParser.js', 'dist/main/services/canvasParserSnapshot.js', 'dist/main/ipc/ziziPlugin.js', 'dist/renderer/canvas/index.html'];
  const missingIntegrationFiles = integrationFiles.filter((entry) => !hasAsarEntry(asarHeader, entry));
  const missingParserFiles = parserFiles.filter((file) => !exists(path.join(parserRoot, file)));
  const pluginBundle = path.join(path.dirname(asarPath), 'plugins', 'Lalor-Zizi-Plugins-2.1.1.zip');
  checks.push({
    id: 'canvas-parser-and-zizi-plugin-bundle',
    ok: missingIntegrationFiles.length === 0 && missingParserFiles.length === 0 && exists(pluginBundle),
    missingFiles: [...missingIntegrationFiles, ...missingParserFiles, ...(!exists(pluginBundle) ? [pluginBundle] : [])],
    missingMarkers: [], missingAnyOf: [],
  });
  checks.push({
    id: 'electron-entry-files',
    ok: asarHeader !== null && hasAsarEntry(asarHeader, 'dist/renderer/index.html') && hasAsarEntry(asarHeader, 'dist/main/main.js'),
    missingFiles: asarHeader === null ? ['ASAR header'] : ['dist/renderer/index.html', 'dist/main/main.js'].filter((entry) => !hasAsarEntry(asarHeader, entry)),
    missingMarkers: [],
    missingAnyOf: ['dist/renderer/index.html', 'dist/main/main.js'],
  });
  const executablePath = locateExecutable(asarPath);
  return makeReport('artifact', path.resolve(inputPath), checks, {
    asarPath,
    executablePath,
    asarSha256: sha256(asarPath),
    executableSha256: sha256(executablePath),
  });
}

export function writeManifest(report, destinationDirectory, sourceRoot = process.cwd()) {
  if (!report.ok) fail('门禁未通过，禁止写入发布清单');
  const destination = path.resolve(destinationDirectory);
  fs.mkdirSync(destination, { recursive: true });
  let sourceCommit = 'unknown';
  try {
    sourceCommit = execFileSync('git', ['-C', path.resolve(sourceRoot), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    // 非 Git 发布目录允许使用 unknown；不影响产物特征校验。
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit,
    artifact: {
      asarPath: path.relative(destination, report.asarPath).replaceAll(path.sep, '/'),
      executablePath: path.relative(destination, report.executablePath).replaceAll(path.sep, '/'),
      asarSha256: report.asarSha256,
      executableSha256: report.executableSha256,
    },
    features: report.checks.filter((check) => check.ok).map((check) => check.id),
  };
  const manifestPath = path.join(destination, 'lalor-release-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return manifestPath;
}

function printReport(report) {
  const output = {
    kind: report.kind,
    location: report.location,
    ok: report.ok,
    asarPath: report.asarPath,
    executablePath: report.executablePath,
    asarSha256: report.asarSha256,
    executableSha256: report.executableSha256,
    failures: report.failures.map((failure) => ({
      id: failure.id,
      missingFiles: failure.missingFiles,
      missingMarkers: failure.missingMarkers,
      missingAnyOf: failure.missingAnyOf,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
}

function usage() {
  console.error('用法: node scripts/release-gate.mjs --source [项目根目录]');
  console.error('      node scripts/release-gate.mjs --artifact <发布目录或 app.asar> [--write-manifest]');
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (mode === '--source') {
    const root = argv[1] && !argv[1].startsWith('--') ? argv[1] : process.cwd();
    const report = verifySourceTree(root);
    printReport(report);
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  if (mode === '--artifact') {
    const input = argv[1];
    if (!input || input.startsWith('--')) {
      usage();
      process.exitCode = 2;
      return null;
    }
    const report = verifyArtifact(input);
    if (argv.includes('--write-manifest')) {
      const manifestPath = writeManifest(report, path.resolve(input), process.cwd());
      report.manifestPath = manifestPath;
    }
    printReport(report);
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  usage();
  process.exitCode = 2;
  return null;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
