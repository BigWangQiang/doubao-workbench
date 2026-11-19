/**
 * electron-builder afterPack hook。
 * 只要打包产物缺少已验收入口，就让 electron-builder 失败，避免生成可误用的安装包。
 */

const fs = require('node:fs');
const path = require('node:path');


module.exports = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin';
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resourcesPath = isMac
    ? path.join(appPath, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const iconPath = path.join(context.packager.projectDir, 'lalor-workspace.ico');
  if (!fs.existsSync(iconPath)) {
    throw new Error(`发布门禁失败：缺少桌面图标 ${iconPath}`);
  }
  const trust = JSON.parse(fs.readFileSync(path.join(context.packager.projectDir, 'security', 'desktop-trust.json'), 'utf8'));
  if (!trust.publicKeys?.length || !trust.updatePublicKeys?.length) throw new Error('发布门禁失败：缺少授权/更新公钥');
  if (fs.existsSync(path.join(resourcesPath, 'relay-defaults.json'))) {
    throw new Error('发布门禁失败：安装资源中存在旧共享中转凭据');
  }
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const executable = isMac ? appPath : path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (context.electronPlatformName === 'win32') {
    const { normalizeWindowsAsarIntegrity } = await import('./windows-asar-integrity.mjs');
    normalizeWindowsAsarIntegrity(executable, path.join(resourcesPath, 'app.asar'));
  }
  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: isMac,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  const { verifyArtifact } = await import('./release-gate.mjs');
  const report = verifyArtifact(context.appOutDir);
  if (!report.ok) {
    const details = report.failures
      .map((failure) => `${failure.id}: ${[...failure.missingFiles, ...failure.missingMarkers].join(', ')}`)
      .join('; ');
    throw new Error(`发布门禁失败，已阻止交付：${details}`);
  }
  console.log(`[ReleaseGate] afterPack 通过: ${report.asarSha256}`);
};
