// 一次性按依赖闭包迁入原版画布；不会覆盖已迁入或已适配的文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(source, 'src/pages/canvas/project.tsx'))) throw new Error('需要明确指定 Lalor web 源码目录');
const target = path.join(root, 'canvas-web');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const entries = ['pages/canvas/project.tsx', 'pages/canvas/index.tsx', 'styles/globals.css', 'lib/app-theme.ts', 'lib/query-client.ts', 'stores/use-theme-store.ts', 'stores/use-config-store.ts', 'stores/use-user-store.ts', 'stores/use-asset-store.ts', 'lib/user-scope.ts'];
const queue = entries.map((file) => path.join(source, 'src', file));
const visited = new Set();
const external = new Set();
const manifest = [];
function resolveImport(file, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
    external.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
    return;
  }
  const base = specifier.startsWith('@/') ? path.join(source, 'src', specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
  const found = [base, ...['.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx'].map((ext) => base + ext)].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new Error(`未找到依赖 ${specifier} (${path.relative(source, file)})`);
  queue.push(found);
}
while (queue.length) {
  const file = queue.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const contents = fs.readFileSync(file);
  const relative = path.relative(source, file);
  if (relative.startsWith('..')) throw new Error('源码依赖超出 web 目录');
  const destination = path.join(target, relative);
  if (fs.existsSync(destination)) throw new Error(`目标已存在，拒绝覆盖 ${relative}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
  manifest.push({ file: relative.replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(contents).digest('hex') });
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    for (const entry of ts.preProcessFile(contents.toString('utf8'), true, true).importedFiles) resolveImport(file, entry.fileName);
    // Worker 通过 URL 引用，不在 TypeScript 的 import 列表里，必须一同迁入。
    for (const match of contents.toString('utf8').matchAll(/new URL\(["']([^"']+\.worker\.[jt]s)["'],\s*import\.meta\.url\)/g)) resolveImport(file, match[1]);
  } else if (file.endsWith('.css')) {
    for (const match of contents.toString('utf8').matchAll(/@import\s+["']([^"']+)["']/g)) resolveImport(file, match[1]);
  }
}
const original = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const dependencies = Object.fromEntries(Object.entries(original.dependencies).filter(([name]) => external.has(name)));
Object.assign(dependencies, { 'react-dom': original.dependencies['react-dom'], '@tanstack/react-query': original.dependencies['@tanstack/react-query'] });
const devDependencies = Object.fromEntries(Object.entries(original.devDependencies).filter(([name]) => ['typescript', 'vite', '@vitejs/plugin-react', '@tailwindcss/postcss', '@types/react', '@types/react-dom', '@types/node', '@types/file-saver', '@types/three'].includes(name)));
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'lalor-workbench-canvas', private: true, version: '1.0.0', type: 'module', scripts: { dev: 'vite --host 127.0.0.1 --port 5174 --strictPort', build: 'vite build', typecheck: 'tsc --noEmit' }, dependencies, devDependencies }, null, 2) + '\n');
for (const dir of ['canvas', 'icons', 'images', 'avatars', 'blender', 'three', 'mediapipe', 'short-drama-styles', 'voice-avatars', 'voice-samples']) {
  const from = path.join(source, 'public', dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(target, 'public', dir), { recursive: true, errorOnExist: true, force: false });
}
for (const entry of fs.readdirSync(path.join(source, 'public'), { withFileTypes: true })) {
  if (entry.isFile()) fs.copyFileSync(path.join(source, 'public', entry.name), path.join(target, 'public', entry.name));
}
fs.copyFileSync(path.join(source, 'postcss.config.mjs'), path.join(target, 'postcss.config.mjs'));
fs.copyFileSync(path.join(source, '..', 'LICENSE'), path.join(target, 'LICENSE.upstream'));
fs.writeFileSync(path.join(target, 'source-manifest.json'), JSON.stringify({ source: 'Lalor web canvas', files: manifest.sort((a, b) => a.file.localeCompare(b.file)) }, null, 2) + '\n');
console.log(`已迁入 ${manifest.length} 个画布源码文件，${Object.keys(dependencies).length} 个直接依赖；源仓库保持只读。`);
