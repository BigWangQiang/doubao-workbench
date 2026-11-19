import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { verifyArtifact } from './release-gate.mjs';
import { verifyWindowsAsarIntegrity } from './windows-asar-integrity.mjs';

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve('electron-updater'));
const yaml = updaterRequire('js-yaml');
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = libRequire('@electron/asar');
const root = path.resolve(process.argv[2] || 'release');
const fail = (message) => { throw new Error(message); };
const artifact = verifyArtifact(root);
if (!artifact.ok) fail('ASAR 发布门禁失败');
verifyWindowsAsarIntegrity(artifact.executablePath, artifact.asarPath);
const fuses = await getCurrentFuseWire(artifact.executablePath);
if (fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== '1'.charCodeAt(0)
    || fuses[FuseV1Options.OnlyLoadAppFromAsar] !== '1'.charCodeAt(0)) fail('Windows EXE 未强制校验 ASAR');
const read = (entry) => asar.extractFile(artifact.asarPath, path.normalize(entry)).toString('utf8');
const pkg = JSON.parse(read('package.json'));
if (pkg.name !== 'doubao-studio-desktop') fail('旧数据身份发生变化');
if (path.basename(artifact.executablePath) !== 'ai视频创作工作台.exe') fail('正式名称不正确');
const config = yaml.load(fs.readFileSync(path.join(path.dirname(artifact.asarPath), 'app-update.yml'), 'utf8'));
if (config.provider !== 'generic' || config.url !== 'https://yuyan-ai.site/desktop-updates/win-x64/') fail('更新源不是屿砚地址');
const metadata = yaml.load(fs.readFileSync(path.join(root, 'latest.yml'), 'utf8'));
if (metadata.version !== pkg.version) fail('安装包与更新清单版本不一致');
for (const file of metadata.files) {
  if (file.url !== path.basename(file.url)) fail('安装包路径异常');
  const bytes = fs.readFileSync(path.join(root, file.url));
  if (bytes.length !== file.size) fail('安装包长度错误');
  if (crypto.createHash('sha512').update(bytes).digest('base64') !== file.sha512) fail('安装包 SHA512 不一致');
  if (bytes.subarray(0, 2).toString() !== 'MZ') fail('不是 Windows 安装程序');
}
const entries = asar.listPackage(artifact.asarPath).map((entry) => entry.replaceAll('\\', '/'));
const forbidden = entries.filter((entry) => /(?:^|\/)(?:accounts\.json|tasks\.json|settings\.json|\.relay\.env|\.env|\.git|DoubaoStudioData|Partitions)(?:\/|$)/.test(entry));
if (forbidden.length) fail('安装包包含用户数据或开发凭据文件');
for (const entry of ['dist/main/services/softwareUpdater.js', 'dist/main/utils/userDataLocation.js', 'node_modules/electron-updater/package.json']) read(entry);
if (read('dist/main/ipc/system.js').includes('api.github.com/repos/dorakoo/')) fail('仍然使用原项目更新地址');
console.log(JSON.stringify({ ok: true, version: pkg.version, feed: config.url, installer: metadata.path,
  sha512: metadata.sha512, appId: 'com.doubao.studio.desktop', hasPersonalData: false }, null, 2));
