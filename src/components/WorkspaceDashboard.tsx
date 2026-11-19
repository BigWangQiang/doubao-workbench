import React, { useMemo, useState } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  DownloadOutlined,
  AudioOutlined,
  FileTextOutlined,
  GlobalOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Button, Empty, message, Progress, Tag } from 'antd';
import { useAccountStore } from '../store/useAccountStore';
import { useProjectStore } from '../store/useProjectStore';
import { useTaskStore } from '../store/useTaskStore';
import { useLalorAuthStore } from '../store/useLalorAuthStore';
import type { Account, Task, TaskStatus } from '../types';
import type { WorkspacePane } from './WorkspaceRail';

interface WorkspaceDashboardProps {
  onNavigate: (pane: WorkspacePane) => void;
}

const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  'executing',
  'generating',
  'waiting_verification',
  'waiting_generation_confirmation',
  'manual_submission_observing',
];

const ATTENTION_TASK_STATUSES: readonly TaskStatus[] = [
  'waiting_verification',
  'waiting_generation_confirmation',
  'manual_submission_observing',
];

function accountState(account: Account): { label: string; tone: 'good' | 'busy' | 'error' | 'muted' } {
  if (account.status === 'error' || account.health?.loginState === 'expired') return { label: '需要处理', tone: 'error' };
  if (account.status === 'busy') return { label: '执行中', tone: 'busy' };
  if (account.health?.availability?.state === 'action_required' || account.health?.verificationRequired) return { label: '需验证', tone: 'busy' };
  if (account.health?.loginState === 'ok' || account.status === 'idle') return { label: '可用', tone: 'good' };
  return { label: '待检测', tone: 'muted' };
}

function taskStatus(task: Task): { label: string; tone: 'good' | 'busy' | 'error' | 'muted' } {
  if (task.status === 'done') return { label: '已完成', tone: 'good' };
  if (task.status === 'fail') return { label: '失败', tone: 'error' };
  if (ATTENTION_TASK_STATUSES.includes(task.status)) return { label: '需处理', tone: 'busy' };
  if (ACTIVE_TASK_STATUSES.includes(task.status)) return { label: '执行中', tone: 'busy' };
  if (task.status === 'paused') return { label: '已暂停', tone: 'muted' };
  return { label: '排队中', tone: 'muted' };
}

function taskModeLabel(task: Task): string {
  if (task.mode === 'video') return '视频';
  if (task.mode === 'image') return '图片';
  if (task.mode === 'music') return '音乐';
  return '对话';
}

function taskModeIcon(task: Task): React.ReactNode {
  if (task.mode === 'video') return <VideoCameraOutlined />;
  if (task.mode === 'image') return <PictureOutlined />;
  if (task.mode === 'music') return <AudioOutlined />;
  return <MessageOutlined />;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const ToneDot: React.FC<{ tone: 'good' | 'busy' | 'error' | 'muted' }> = ({ tone }) => (
  <span className={`dashboard-dot ${tone}`} aria-hidden="true" />
);

export const WorkspaceDashboard: React.FC<WorkspaceDashboardProps> = ({ onNavigate }) => {
  const accounts = useAccountStore((state) => state.accounts);
  const loadAccounts = useAccountStore((state) => state.loadAccounts);
  const requestAvailabilityCheck = useAccountStore((state) => state.requestAvailabilityCheck);
  const tasks = useTaskStore((state) => state.tasks);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const schedulerPaused = useTaskStore((state) => state.schedulerPaused);
  const batchPause = useTaskStore((state) => state.batchPause);
  const resumeAll = useTaskStore((state) => state.resumeAll);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const [refreshing, setRefreshing] = useState(false);
  const profile = useLalorAuthStore((state) => state.snapshot.profile);
  const memberName = profile?.displayName?.trim() || profile?.username?.trim() || '屿砚';

  const projectTasks = useMemo(
    () => tasks.filter((task) => (task.projectId || 'default-project') === activeProjectId),
    [activeProjectId, tasks],
  );
  const runningTasks = projectTasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status));
  const attentionTasks = projectTasks.filter((task) => ATTENTION_TASK_STATUSES.includes(task.status));
  const queuedTasks = projectTasks.filter((task) => task.status === 'queued');
  const completedTasks = projectTasks.filter((task) => task.status === 'done');
  const terminalTasks = projectTasks.filter((task) => task.status === 'done' || task.status === 'fail');
  const successRate = terminalTasks.length ? Math.round((completedTasks.length / terminalTasks.length) * 100) : 0;
  const availableAccounts = accounts.filter((account) => account.status !== 'error' && account.health?.loginState !== 'expired');
  const artifactCount = projectTasks.reduce((total, task) => total + (task.artifacts?.length || task.outputs.length), 0);
  const recentTasks = [...projectTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const healthAccounts = [...accounts].sort((a, b) => {
    const rank = (account: Account): number => {
      const state = accountState(account);
      return state.tone === 'error' ? 0 : state.tone === 'busy' ? 1 : state.tone === 'muted' ? 2 : 3;
    };
    return rank(a) - rank(b);
  }).slice(0, 5);

  const handleNewTask = () => {
    onNavigate('tasks');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('workspace-open-new-task')), 0);
  };

  const handleTogglePause = async () => {
    if (schedulerPaused) await resumeAll();
    else await batchPause();
  };

  const handleRefresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // 普通刷新只同步持久化数据，不走启动恢复分支，避免暂停正在执行的任务。
      await Promise.all([loadAccounts(), loadTasks(false)]);
      const latestAccounts = useAccountStore.getState().accounts;
      const latestBusy = useTaskStore.getState().accountBusy;
      // BrowserPanel 会消费请求并只对已挂载的 WebView 执行探测；执行中账号不打断。
      latestAccounts.forEach((account) => {
        if (!latestBusy[account.id]) requestAvailabilityCheck(account.id);
      });
      message.success('账号与任务数据已刷新');
    } catch {
      message.error('刷新失败，请稍后重试');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="workspace-dashboard" aria-label="工作台">
      <header className="dashboard-command dashboard-glass">
        <div>
          <div className="dashboard-eyebrow">WORKSPACE / LIVE CONTROL</div>
          <h1>欢迎回来，{memberName}</h1>
          <p>{attentionTasks.length > 0 ? `你的生产矩阵运行中，有 ${attentionTasks.length} 个任务需要人工处理。` : '你的生产矩阵运行正常，可以继续创建内容任务。'}</p>
        </div>
        <div className="dashboard-actions">
          <Button className="dashboard-button" icon={<PauseCircleOutlined />} onClick={() => void handleTogglePause()}>
            {schedulerPaused ? '继续全部任务' : '全部暂停'}
          </Button>
          <Button className="dashboard-button" icon={<ApiOutlined />} onClick={() => onNavigate('local-manager')}>代理绑定</Button>
          <Button className="dashboard-button dashboard-button-primary" icon={<PlusOutlined />} onClick={handleNewTask}>新建任务</Button>
        </div>
      </header>

      {attentionTasks.length > 0 && (
        <div className="dashboard-notice dashboard-glass" role="status">
          <span className="dashboard-notice-icon"><SafetyCertificateOutlined /></span>
          <div>
            <strong>{attentionTasks.length} 个任务等待人工处理</strong>
            <span>请在对应会话中完成验证或确认，系统不会自动重复提交。</span>
          </div>
          <Button type="link" onClick={() => onNavigate('tasks')}>去处理</Button>
        </div>
      )}

      <div className="dashboard-kpis">
        <article className="dashboard-kpi dashboard-glass">
          <div className="dashboard-kpi-label"><span>在线账号</span><TeamOutlined /></div>
          <strong>{availableAccounts.length}<small> / {accounts.length}</small></strong>
          <span className="dashboard-kpi-foot"><ToneDot tone={availableAccounts.length ? 'good' : 'muted'} />当前可调度</span>
        </article>
        <article className="dashboard-kpi dashboard-glass">
          <div className="dashboard-kpi-label"><span>执行中</span><ThunderboltOutlined /></div>
          <strong>{runningTasks.length}</strong>
          <span className="dashboard-kpi-foot"><ToneDot tone={runningTasks.length ? 'busy' : 'muted'} />实时运行任务</span>
        </article>
        <article className="dashboard-kpi dashboard-glass">
          <div className="dashboard-kpi-label"><span>队列待处理</span><UnorderedListOutlined /></div>
          <strong>{queuedTasks.length}</strong>
          <span className="dashboard-kpi-foot"><ToneDot tone={queuedTasks.length ? 'busy' : 'muted'} />优先级队列</span>
        </article>
        <article className="dashboard-kpi dashboard-glass">
          <div className="dashboard-kpi-label"><span>项目产物</span><AppstoreOutlined /></div>
          <strong>{artifactCount}</strong>
          <span className="dashboard-kpi-foot"><ToneDot tone={completedTasks.length ? 'good' : 'muted'} />成功率 {terminalTasks.length ? `${successRate}%` : '暂无数据'}</span>
        </article>
      </div>

      <div className="dashboard-grid dashboard-grid-top">
        <article className="dashboard-panel dashboard-glass">
          <div className="dashboard-panel-head">
            <div><h2>账号健康度</h2><p>登录、额度与自动化可用性</p></div>
            <Button
              type="text"
              className="dashboard-icon-button"
              icon={<ReloadOutlined />}
              loading={refreshing}
              aria-label="刷新账号与任务数据"
              title="刷新账号与任务数据"
              onClick={() => void handleRefresh()}
            />
          </div>
          <div className="dashboard-health-summary">
            <div><strong>{availableAccounts.length} / {accounts.length}</strong><span>自动化可用</span><Progress percent={accounts.length ? Math.round((availableAccounts.length / accounts.length) * 100) : 0} showInfo={false} strokeColor="#45d695" /></div>
            <div><strong>{terminalTasks.length ? `${successRate}%` : '—'}</strong><span>项目成功率</span><Progress percent={successRate} showInfo={false} strokeColor="#8a7cff" /></div>
          </div>
          <div className="dashboard-health-list">
            {healthAccounts.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账号" /> : healthAccounts.map((account) => {
              const state = accountState(account);
              return <button
                className="dashboard-health-row"
                key={account.id}
                type="button"
                aria-label={`打开账号池：${account.name}`}
                onClick={() => onNavigate('accounts')}
              >
                <span className={`dashboard-account-avatar ${account.platform === 'dola' ? 'dola' : ''}`}>{account.name.slice(0, 1).toUpperCase()}</span>
                <span className="dashboard-health-copy"><strong>{account.name}</strong><span>{account.platform === 'dola' ? 'Dola' : '豆包'} · {account.health?.loginState === 'ok' ? '已登录' : '状态待确认'}</span></span>
                <span className={`dashboard-state ${state.tone}`}><ToneDot tone={state.tone} />{state.label}</span>
              </button>;
            })}
          </div>
        </article>

        <article className="dashboard-panel dashboard-glass">
          <div className="dashboard-panel-head">
            <div><h2>实时任务队列</h2><p>按健康度、额度和负载自动分配</p></div>
            <Button
              type="link"
              aria-label="打开完整任务队列"
              title="打开完整任务队列"
              onClick={() => onNavigate('tasks')}
            >
              完整队列 <UnorderedListOutlined />
            </Button>
          </div>
          <div className="dashboard-task-list">
            {recentTasks.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" /> : recentTasks.map((task) => {
              const state = taskStatus(task);
              const account = accounts.find((item) => item.id === task.assignedAccountId);
              return <button
                className="dashboard-task-row"
                key={task.id}
                type="button"
                aria-label={`打开任务队列：${task.prompt.slice(0, 42) || '未命名任务'}`}
                onClick={() => onNavigate('tasks')}
              >
                <span className={`dashboard-task-icon ${task.mode}`}>{taskModeIcon(task)}</span>
                <span className="dashboard-task-copy"><strong>{task.prompt.slice(0, 42) || '未命名任务'}{task.prompt.length > 42 ? '…' : ''}</strong><span>{taskModeLabel(task)} · {account?.name || '待分配'} · {formatTime(task.updatedAt)}</span></span>
                <span className={`dashboard-state ${state.tone}`}><ToneDot tone={state.tone} />{state.label}</span>
              </button>;
            })}
          </div>
        </article>
      </div>

      <div className="dashboard-grid dashboard-grid-bottom">
        <article className="dashboard-panel dashboard-glass dashboard-activity-panel">
          <div className="dashboard-panel-head"><div><h2>运行概览</h2><p>当前项目的任务与产物状态</p></div><Tag color={attentionTasks.length ? 'warning' : 'success'}>{attentionTasks.length ? `${attentionTasks.length} 项需关注` : '运行正常'}</Tag></div>
          <div className="dashboard-overview-columns">
            <div className="dashboard-overview-stat"><span>完成任务</span><strong>{completedTasks.length}</strong><small>共 {projectTasks.length} 项</small></div>
            <div className="dashboard-overview-stat"><span>失败任务</span><strong className={projectTasks.some((task) => task.status === 'fail') ? 'is-danger' : ''}>{projectTasks.filter((task) => task.status === 'fail').length}</strong><small>可在队列中重试</small></div>
            <div className="dashboard-overview-stat"><span>视频产物</span><strong>{projectTasks.reduce((sum, task) => sum + (task.artifacts || []).filter((artifact) => artifact.kind === 'video').length, 0)}</strong><small>已登记到本地</small></div>
          </div>
          <div className="dashboard-route-card"><GlobalOutlined /><div><strong>Dola 海外路由</strong><span>绑定的窗口按代理策略转发，豆包保持本地直连。</span></div><Button type="link" onClick={() => onNavigate('local-manager')}>查看窗口绑定</Button></div>
        </article>
        <article className="dashboard-panel dashboard-glass dashboard-shortcuts-panel">
          <div className="dashboard-panel-head"><div><h2>快捷入口</h2><p>常用工作区</p></div></div>
          <div className="dashboard-shortcuts">
            <button type="button" onClick={() => onNavigate('artifacts')}><DownloadOutlined /><span>产物中心</span><small>{artifactCount} 项</small></button>
            <button type="button" onClick={() => onNavigate('local-manager')}><ApiOutlined /><span>窗口绑定</span><small>窗口路由</small></button>
            <button type="button" onClick={() => onNavigate('logs')}><FileTextOutlined /><span>运行日志</span><small>诊断与恢复</small></button>
            <button type="button" onClick={() => onNavigate('accounts')}><TeamOutlined /><span>账号池</span><small>{accounts.length} 个账号</small></button>
          </div>
        </article>
      </div>
    </section>
  );
};
