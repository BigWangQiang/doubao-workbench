import * as fs from 'fs';
import * as path from 'path';

interface ControlDiscoveryInfo {
  protocolVersion: 'v1';
  address: '127.0.0.1';
  port: number;
  pid: number;
  tokenFile: 'control-token';
  startedAt: string;
  expiresAt: string;
}

/** 自定义数据目录也发布标准发现入口，旧插件无需按应用版本寻找安装位置。 */
export function publishLocalControlDiscovery(userData: string, appData: string, token: string, info: ControlDiscoveryInfo): () => void {
  const directories = [...new Set([
    path.resolve(userData, 'DoubaoStudioControl'),
    path.resolve(appData, 'doubao-studio-desktop', 'DoubaoStudioControl'),
  ])];
  const published: string[] = [];
  const cleanup = (): void => {
    for (const directory of published) {
      const infoFile = path.join(directory, 'control-info.json');
      try {
        // 只删除本进程发布的记录，不能清掉另一个已启动实例的连接信息。
        const current = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as ControlDiscoveryInfo;
        if (current.pid !== info.pid || current.startedAt !== info.startedAt) continue;
        fs.unlinkSync(infoFile);
        fs.unlinkSync(path.join(directory, 'control-token'));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[Control] 清理插件发现记录失败');
      }
    }
  };
  try {
    for (const directory of directories) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      const tokenFile = path.join(directory, 'control-token');
      const infoFile = path.join(directory, 'control-info.json');
      const temporary = `${infoFile}.${info.pid}.tmp`;
      try {
        fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(tokenFile, 0o600);
        fs.writeFileSync(temporary, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, infoFile);
        fs.chmodSync(infoFile, 0o600);
        published.push(directory);
      } catch (error: unknown) {
        fs.rmSync(temporary, { force: true });
        fs.rmSync(tokenFile, { force: true });
        throw error;
      }
    }
  } catch (error: unknown) { cleanup(); throw error; }
  return cleanup;
}
