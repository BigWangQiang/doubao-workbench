import React, { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Modal, Progress, Space, Typography } from 'antd';
import { CloudDownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import type { SoftwareUpdateState } from '@doubao-studio/contracts';

export function openSoftwareUpdate(): void { window.dispatchEvent(new Event('software-update-open')); }

export const SoftwareUpdatePanel: React.FC = () => {
  const [state, setState] = useState<SoftwareUpdateState | null>(null);
  const { message, modal } = App.useApp();
  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.electronAPI.system.onSoftwareUpdate((next): void => { if (mounted) setState(next); });
    void window.electronAPI.system.updateStatus().then((next): void => { if (mounted) setState(next); }).catch((): void => { void message.error('无法读取更新状态，请重新打开软件。'); });
    return (): void => { mounted = false; unsubscribe(); };
  }, [message]);

  const check = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.system.checkSoftwareUpdate();
      setState(result.state);
    } catch { void message.error('更新检查失败，请稍后重试。'); }
  };
  const install = (): void => {
    modal.confirm({
      title: '重启并安装更新',
      content: '安装会关闭并重新打开工作台。账号、登录信息、任务记录和产物将保留；还有任务执行或回传时会暂缓安装。',
      okText: '重启并安装', cancelText: '稍后',
      onOk: async (): Promise<void> => {
        const result = await window.electronAPI.system.installSoftwareUpdate();
        if (!result.success) { void message.warning(result.error || '请稍后安装'); return; }
        setState(result.state);
      },
    });
  };
  const busy = state && ['checking', 'downloading', 'installing'].includes(state.phase);
  return (
    <section aria-label="软件更新" style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border-color, #343747)' }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text strong>软件更新 {state ? `· v${state.currentVersion}` : ''}</Typography.Text>
        <Typography.Text type="secondary">自动检查并在后台下载，安装前由你确认。</Typography.Text>
        <div role={state?.phase === 'error' ? 'alert' : 'status'} aria-live="polite">{state?.message || '正在读取更新状态…'}</div>
        {state?.latestVersion && <Typography.Text>最新版本：v{state.latestVersion}</Typography.Text>}
        {state?.releaseNotes && (
          <Alert
            type="info"
            showIcon
            message="本次更新内容"
            description={<Typography.Paragraph style={{ whiteSpace: 'pre-line', marginBottom: 0 }}>{state.releaseNotes}</Typography.Paragraph>}
          />
        )}
        {state?.latestVersion && (
          <Alert
            type="warning"
            showIcon
            message="用户操作说明"
            description={state.userInstructions || '下载完成后点击“重启并安装”，安装会保留账号、任务和产物。'}
          />
        )}
        {state?.phase === 'downloading' && <Progress percent={state.progress} aria-label="更新下载进度" />}
        <Space wrap>
          {state?.phase === 'ready'
            ? <Button type="primary" icon={<ReloadOutlined aria-hidden="true" />} onClick={install}>重启并安装</Button>
            : <Button icon={<CloudDownloadOutlined aria-hidden="true" />} loading={!!busy} disabled={!state || state.phase === 'unsupported'} onClick={(): void => { void check(); }}>{state?.phase === 'error' ? '重试更新' : '检查更新'}</Button>}
          <Button href="https://yuyan-ai.site/connections/desktop" target="_blank" rel="noreferrer">打开屿砚网站</Button>
        </Space>
      </Space>
    </section>
  );
};

// 登录前也能获得软件更新提示；不绕过会员验证或自动执行安装。
export const SoftwareUpdateNotifications: React.FC = () => {
  const [open, setOpen] = useState(false);
  const notifiedVersion = useRef('');
  const { notification } = App.useApp();
  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener('software-update-open', show);
    const handle = (state: SoftwareUpdateState): void => {
      if (state.phase !== 'ready' || !state.latestVersion || notifiedVersion.current === state.latestVersion) return;
      notifiedVersion.current = state.latestVersion;
      notification.info({ key: 'software-update-ready', message: `ai视频创作工作台 v${state.latestVersion} 已下载`,
        description: state.releaseNotes || '任务结束后可重启安装更新。', duration: 0,
        btn: <Button type="primary" onClick={(): void => { notification.destroy('software-update-ready'); show(); }}>查看更新</Button> });
    };
    const unsubscribe = window.electronAPI.system.onSoftwareUpdate(handle);
    void window.electronAPI.system.updateStatus().then(handle).catch((): void => undefined);
    return (): void => { window.removeEventListener('software-update-open', show); unsubscribe(); };
  }, [notification]);
  return <Modal title="ai视频创作工作台 · 在线更新" open={open} onCancel={(): void => setOpen(false)} footer={null} width={480} destroyOnClose><SoftwareUpdatePanel /></Modal>;
};
