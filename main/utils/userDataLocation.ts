import * as fs from 'fs';
import * as path from 'path';

// 保留历史包名的数据身份；productName 的品牌改名不能产生空白账号库。
export function resolveUserDataLocation(appData: string, explicit: string | undefined, legacyPath?: string): string {
  const defaultPath = path.join(appData, 'doubao-studio-desktop');
  const locatorPath = path.join(defaultPath, 'data-location.json');
  let selected = defaultPath;
  if (explicit && path.isAbsolute(explicit)) selected = explicit;
  else {
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(locatorPath, 'utf8'));
      if (saved && typeof saved === 'object' && 'directory' in saved && typeof saved.directory === 'string'
        && path.isAbsolute(saved.directory) && fs.existsSync(saved.directory)) selected = saved.directory;
    } catch { /* 首次安装没有定位文件。 */ }
    if (selected === defaultPath && legacyPath && fs.existsSync(path.join(legacyPath, 'DoubaoStudioData', 'accounts.json'))) selected = legacyPath;
  }
  fs.mkdirSync(selected, { recursive: true });
  fs.mkdirSync(defaultPath, { recursive: true });
  const temporary = `${locatorPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ directory: selected }), { mode: 0o600 });
  fs.renameSync(temporary, locatorPath);
  return selected;
}
