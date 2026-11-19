param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDir,
  [string]$ShortcutPath = "$env:USERPROFILE\Desktop\屿砚工作台.lnk",
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$UserDataDir = ''
)

$ErrorActionPreference = 'Stop'

$resolvedRelease = (Resolve-Path -LiteralPath $ReleaseDir).Path
$resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path
$gateScript = Join-Path $resolvedProject 'scripts\release-gate.mjs'
if (-not (Test-Path -LiteralPath $gateScript -PathType Leaf)) {
  throw "找不到发布门禁脚本：$gateScript"
}

$gateJson = & node $gateScript --artifact $resolvedRelease --write-manifest | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "发布门禁未通过，已拒绝更新快捷方式。"
}
$gate = $gateJson | ConvertFrom-Json
$target = [string]$gate.executablePath
if ([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "门禁没有返回可执行文件，已拒绝更新快捷方式。"
}

$shortcutFullPath = [IO.Path]::GetFullPath($ShortcutPath)
$shortcutDirectory = Split-Path -Parent $shortcutFullPath
New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutFullPath)
$previousArguments = $shortcut.Arguments
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = Split-Path -Parent $target
$shortcut.Arguments = if ($UserDataDir) { '--user-data-dir="' + [IO.Path]::GetFullPath($UserDataDir) + '"' } else { $previousArguments }
$shortcut.IconLocation = "$target,0"
$shortcut.Description = 'ai视频创作工作台（门禁校验通过）'
$shortcut.Save()

$verify = $shell.CreateShortcut($shortcutFullPath)
if ([IO.Path]::GetFullPath($verify.TargetPath) -ne [IO.Path]::GetFullPath($target)) {
  throw "快捷方式回读目标不一致，已拒绝交付。"
}
Write-Output "快捷方式已更新：$shortcutFullPath"
Write-Output "目标：$target"
