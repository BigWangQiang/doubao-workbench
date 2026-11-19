import React from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  FileTextOutlined,
  LoginOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Tooltip } from 'antd';
import type { LalorProfile } from '@doubao-studio/contracts';
import { useLalorStore } from '../store/useLalorStore';
import { resolveLalorAvatarUrl } from '../utils/lalorAvatar';

export type WorkspacePane = 'workspace' | 'canvas' | 'storyboard-batch' | 'dola-login' | 'doubao-login' | 'accounts' | 'tasks' | 'local-manager' | 'artifacts' | 'logs' | 'tutorial' | 'personal-center' | 'account-purchase' | 'settings' | 'zizi-plugin';

interface WorkspaceRailProps {
  activePane: WorkspacePane;
  onSelectPane: (pane: WorkspacePane) => void;
  /** 完整 Lalor 会员闸门提供的资料；未传时保留旧版本地商城状态兼容。 */
  profile?: LalorProfile;
}

export const WorkspaceRail: React.FC<WorkspaceRailProps> = ({ activePane, onSelectPane, profile: authProfile }) => {
  const status = useLalorStore((state) => state.status);
  const profile = authProfile || status.profile;
  const connected = Boolean(authProfile) || status.connected;
  const avatarSrc = resolveLalorAvatarUrl(profile?.avatarUrl);
  const avatarInitial = (profile?.displayName || profile?.username || 'L').slice(0, 1).toUpperCase();
  const paneItems = [
    { key: 'workspace' as const, label: '工作台', icon: <DashboardOutlined /> },
    { key: 'canvas' as const, label: '独立画布', icon: <DeploymentUnitOutlined /> },
    { key: 'dola-login' as const, label: 'Dola 登录', icon: <LoginOutlined /> },
    { key: 'doubao-login' as const, label: '豆包登录', icon: <UserOutlined /> },
    { key: 'accounts' as const, label: '账号池', icon: <TeamOutlined /> },
    { key: 'tasks' as const, label: '任务队列', icon: <UnorderedListOutlined /> },
    { key: 'storyboard-batch' as const, label: '并发生成', icon: <ThunderboltOutlined /> },
  ];
  const commandItems = [
    { key: 'zizi-plugin' as const, label: '字字动画', icon: <ApiOutlined /> },
    { key: 'local-manager' as const, label: '代理绑定', icon: <ApiOutlined /> },
    { key: 'artifacts' as const, label: '产物中心', icon: <AppstoreOutlined /> },
    { key: 'logs' as const, label: '运行日志', icon: <FileTextOutlined /> },
    { key: 'settings' as const, label: '设置', icon: <SettingOutlined /> },
  ];

  const selectPane = (pane: WorkspacePane) => {
    onSelectPane(pane);
    if (pane !== 'accounts' && pane !== 'tasks') return;
    setTimeout(() => {
      const selector = pane === 'tasks' ? '.workspace-task-pane' : '.workspace-account-pane';
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    }, 0);
  };

  return (
    <nav className="workspace-rail" aria-label="工作区导航">
      <div className="workspace-rail-mark" aria-hidden="true">
        <ThunderboltOutlined />
      </div>

      <div className="workspace-rail-group">
        {paneItems.map((item) => (
          <Tooltip key={item.key} title={item.label} placement="right">
            <button
              type="button"
              className={`workspace-rail-item ${activePane === item.key ? 'is-active' : ''}`}
              aria-label={item.label}
              aria-current={activePane === item.key ? 'page' : undefined}
              onClick={() => selectPane(item.key)}
            >
              <span className="workspace-rail-icon" aria-hidden="true">{item.icon}</span>
              <span className="workspace-rail-label">{item.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>

      <div className="workspace-rail-divider" />

      <div className="workspace-rail-group workspace-rail-commands">
        {commandItems.map((item) => (
          <Tooltip key={item.key} title={item.label} placement="right">
            <button
              type="button"
              className={`workspace-rail-item ${activePane === item.key ? 'is-active' : ''}`}
              aria-label={item.label}
              aria-current={activePane === item.key ? 'page' : undefined}
              onClick={() => onSelectPane(item.key)}
            >
              <span className="workspace-rail-icon" aria-hidden="true">{item.icon}</span>
              <span className="workspace-rail-label">{item.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>

      <button
        type="button"
        className="workspace-rail-footer"
        title={profile ? `${profile.displayName || profile.username} · 个人中心` : '个人中心'}
        aria-label="打开屿砚个人中心"
        onClick={() => onSelectPane('account-purchase')}
      >
        <Avatar className="workspace-rail-avatar" size={32} src={avatarSrc} icon={<UserOutlined />}>
          {avatarInitial}
        </Avatar>
        {connected && <span className="workspace-rail-online" aria-hidden="true" />}
      </button>
    </nav>
  );
};
