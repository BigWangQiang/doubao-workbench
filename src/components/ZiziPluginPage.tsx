import React, { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Collapse, Tag } from 'antd';
import { ApiOutlined, CheckCircleOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ZiziPluginStatus } from '@doubao-studio/contracts';
import type { WorkspacePane } from './WorkspaceRail';
import { useLalorAuthStore } from '../store/useLalorAuthStore';
import { useAccountStore } from '../store/useAccountStore';
import '../styles/zizi-plugin.css';

interface ZiziPluginPageProps {
  onNavigate: (pane: WorkspacePane) => void;
}

const CONNECTION_LABELS = {
  ready: '本机连接服务就绪', starting: '工作台正在初始化',
  expired: '连接已过期', unavailable: '本机连接服务未就绪',
};

export const ZiziPluginPage: React.FC<ZiziPluginPageProps> = ({ onNavigate }) => {
  const { message } = App.useApp();
  const authenticated = useLalorAuthStore((state) => state.snapshot.authenticated);
  const accountCount = useAccountStore((state) => state.accounts.length);
  const [status, setStatus] = useState<ZiziPluginStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedPath, setSavedPath] = useState('');

  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    setError('');
    try { setStatus(await window.electronAPI.ziziPlugin.status()); }
    catch { setStatus(null); setError('连接状态读取失败，请稍后重试；若刚更新工作台，请重新打开软件。'); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);

  const savePackage = async (): Promise<void> => {
    setSaving(true);
    try {
      const result = await window.electronAPI.ziziPlugin.savePackage();
      if (result.error) { message.error(result.error); return; }
      if (result.saved) { setSavedPath(result.filePath || ''); message.success('插件包已保存，解压后按下面步骤安装。'); }
    } catch { message.error('插件包保存失败，请重试。'); }
    finally { setSaving(false); }
  };

  const ready = status?.connection === 'ready';
  return (
    <section className="workspace-full-page zizi-plugin-page" aria-label="字字动画">
      <div className="zizi-plugin-content">
        <header className="workspace-page-header">
          <div>
            <h1>字字动画</h1>
            <p>在字字动画中调用工作台账号池，生成图片和视频。</p>
          </div>
          <Button type="primary" aria-label="保存插件包" icon={<DownloadOutlined />} loading={saving}
            disabled={!status?.packageAvailable} onClick={() => void savePackage()}>保存插件包</Button>
        </header>

        <div className="zizi-package-meta">
          <Tag>图片 + 视频插件 {status ? `v${status.pluginVersion}` : ''}</Tag>
          <span>随软件内置 · 保存后解压安装</span>
          {status && <span>当前工作台 v{status.appVersion}</span>}
        </div>
        {savedPath && <Alert type="success" showIcon message="插件包已保存" description={<span className="zizi-saved-path">{savedPath}</span>} />}
        {error && <Alert type="error" showIcon message={error} />}
        {status && !status.packageAvailable && <Alert type="error" showIcon message="内置插件包缺失，请重新安装最新版工作台。" />}

        <section className="zizi-connection" aria-labelledby="zizi-connection-heading">
          <div className="zizi-connection-heading">
            <div>
              <h2 id="zizi-connection-heading"><ApiOutlined /> 连接检查</h2>
              <p>检测工作台端是否就绪；在字字动画中刷新出账号池，即表示两端连接成功。</p>
            </div>
            <Button aria-label="检查连接" icon={<ReloadOutlined />} loading={checking} onClick={() => void check()}>检查连接</Button>
          </div>
          <dl className="zizi-status-list" aria-live="polite">
            <div><dt>本机服务</dt><dd><Tag color={ready ? 'success' : 'warning'}>{status ? CONNECTION_LABELS[status.connection] : checking ? '正在检查' : '未能读取'}</Tag></dd></div>
            <div><dt>屿砚会员</dt><dd>{authenticated ? '已登录，提交时验证权益' : <Button type="link" onClick={() => onNavigate('personal-center')}>去登录会员</Button>}</dd></div>
            <div><dt>工作台账号</dt><dd>{accountCount > 0 ? `${accountCount} 个已添加` : '尚未添加'}<Button type="link" onClick={() => onNavigate('accounts')}>管理账号</Button></dd></div>
          </dl>
          {status?.connection === 'expired' && <Alert type="warning" showIcon message="本次连接已过期。请在当前任务结束后重启工作台，再到字字动画刷新账号池。" />}
          {status?.connection === 'unavailable' && <Alert type="warning" showIcon message="请稍后再检查；持续未就绪时，在当前任务结束后重启工作台。" />}
        </section>

        <section className="zizi-install" aria-labelledby="zizi-install-heading">
          <h2 id="zizi-install-heading">三步完成连接</h2>
          <ol className="zizi-steps">
            <li>
              <div className="zizi-step-number" aria-hidden="true">1</div>
              <div><h3>保存插件，退出字字动画</h3><p>点击上方「保存插件包」，解压 ZIP。安装或更新前，先完全退出字字动画。</p></div>
            </li>
            <li>
              <div className="zizi-step-number" aria-hidden="true">2</div>
              <div><h3>合并到字字动画安装目录</h3><p>把解压后的 <code>user_resources</code> 文件夹复制到字字动画安装目录，合并同名文件夹。图片和视频插件需要一起安装。</p>
                <pre className="zizi-install-path">{'字字动画安装目录 / user_resources / plugins /\n  image_plugins / image_plugin_lalor_workbench\n  video_plugins / video_plugin_lalor_workbench'}</pre>
                <p className="zizi-hint">每个插件目录包含 main.py、info.json 和 ui 文件夹。保留原有 config.json，不要放到 _internal 目录。</p>
              </div>
            </li>
            <li>
              <div className="zizi-step-number" aria-hidden="true">3</div>
              <div><h3>打开字字动画，刷新账号池</h3><p>保持本工作台运行并登录会员。在字字动画的图片 / 视频插件列表选择「Lalor 工作台图片插件」或「Lalor 工作台视频插件」，选择账号池，再点击「刷新账号 / 刷新模型」。</p>
                <div className="zizi-complete"><CheckCircleOutlined /> 看到工作台账号池和模型后，即可提交任务。</div>
              </div>
            </li>
          </ol>
        </section>

        <Collapse className="zizi-faq" items={[
          { key: 'missing', label: '字字动画中找不到插件', children: '确认复制的是整个 user_resources 文件夹，且它位于字字动画安装目录中。不要只复制 main.py；图片和视频两个插件都要保留，完成后重新启动字字动画。' },
          { key: 'connect', label: '插件提示无法连接或要求工作台 2.6.0', children: '2.6.0 是旧插件的提示文案。请安装本页提供的新版插件，并使用最新版工作台，无需降级。两款软件须在同一台电脑、同一个 Windows 用户下运行；不要手填端口、密钥或 Cookie。' },
          { key: 'accounts', label: '连接成功，但没有可用账号或生成被拒绝', children: '到工作台的豆包登录或 Dola 登录添加账号，并在账号池检查登录状态、可用额度和调度设置。会员授权未通过时，到个人中心确认会员有效并检查网络，然后重新提交。' },
        ]} />
      </div>
    </section>
  );
};
