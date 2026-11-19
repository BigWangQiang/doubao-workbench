import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, List, Modal, Select, Tag, message } from 'antd';
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Account, AccountPlatform, GenerationMode, Task } from '../types';
import { useAccountStore } from '../store/useAccountStore';
import { useTaskStore } from '../store/useTaskStore';

type LogEntry = Awaited<ReturnType<typeof window.electronAPI.logs.list>>[number];

const MODE_LABELS: Record<GenerationMode, string> = {
  chat: '文本',
  image: '图片',
  video: '视频',
  music: '音频',
};

const PLATFORM_LABELS: Record<AccountPlatform, string> = {
  doubao: '豆包',
  dola: 'Dola',
};

interface ResolvedLogEntry extends LogEntry {
  resolvedAccountId?: string;
  resolvedAccountName?: string;
  resolvedPlatform?: AccountPlatform;
  resolvedMode?: GenerationMode;
  resolvedPrompt?: string;
  accountLabel: string;
  modeLabel: string;
  searchText: string;
}

function accountLabel(platform: AccountPlatform | undefined, name: string | undefined, id: string | undefined): string {
  const platformPrefix = platform ? `${PLATFORM_LABELS[platform]} · ` : '';
  if (name) return `${platformPrefix}${name}`;
  if (id) return `${platformPrefix}${id}`;
  return '未关联账号';
}

function modeLabel(mode: GenerationMode | undefined, hasTaskId: boolean): string {
  if (mode) return MODE_LABELS[mode];
  return hasTaskId ? '类型未记录' : '系统事件';
}

function resolveLogEntry(
  log: LogEntry,
  tasksById: ReadonlyMap<string, Task>,
  accountsById: ReadonlyMap<string, Account>,
): ResolvedLogEntry {
  const task = log.taskId ? tasksById.get(log.taskId) : undefined;
  const resolvedAccountId = log.accountId ?? task?.assignedAccountId ?? undefined;
  const account = resolvedAccountId ? accountsById.get(resolvedAccountId) : undefined;
  const resolvedAccountName = log.accountName ?? account?.name;
  const resolvedPlatform = log.accountPlatform
    ?? account?.platform
    ?? task?.targetPlatform
    ?? (account || task ? 'doubao' : undefined);
  const resolvedMode = log.mode ?? task?.runtime?.input.mode ?? task?.mode;
  const resolvedPrompt = log.prompt ?? task?.runtime?.input.prompt ?? task?.prompt;
  const platformLabel = resolvedPlatform ? PLATFORM_LABELS[resolvedPlatform] : undefined;
  const resolvedAccountLabel = accountLabel(resolvedPlatform, resolvedAccountName, resolvedAccountId);
  const resolvedModeLabel = modeLabel(resolvedMode, Boolean(log.taskId));
  const searchText = [
    log.scope,
    log.message,
    log.taskId,
    resolvedAccountId,
    resolvedAccountName,
    resolvedPlatform,
    platformLabel,
    resolvedMode,
    resolvedModeLabel,
    resolvedPrompt,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLocaleLowerCase('zh-CN');

  return {
    ...log,
    resolvedAccountId,
    resolvedAccountName,
    resolvedPlatform,
    resolvedMode,
    resolvedPrompt,
    accountLabel: resolvedAccountLabel,
    modeLabel: resolvedModeLabel,
    searchText,
  };
}

interface LogCenterModalProps {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
}

export const LogCenterModal: React.FC<LogCenterModalProps> = ({ open, onClose, embedded = false }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<'all' | LogEntry['level']>('all');
  const [query, setQuery] = useState('');
  const tasks = useTaskStore((state) => state.tasks);
  const accounts = useAccountStore((state) => state.accounts);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('zh-CN'));
  const load = async () => setLogs(await window.electronAPI.logs.list());
  useEffect(() => { if (open) void load(); }, [open]);
  const resolvedLogs = useMemo(() => {
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    return logs.map((log) => resolveLogEntry(log, tasksById, accountsById));
  }, [accounts, logs, tasks]);
  const filtered = useMemo(() => resolvedLogs
    .filter((log) => level === 'all' || log.level === level)
    .filter((log) => !deferredQuery || log.searchText.includes(deferredQuery))
    .reverse(), [deferredQuery, level, resolvedLogs]);
  const emptyDescription = logs.length === 0
    ? '暂无日志'
    : '没有匹配的日志，请调整关键词或筛选条件';
  const body = (
    <>
      <div className="workspace-log-toolbar">
        <Input.Search className="workspace-log-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、平台、类型、提示词、任务或错误" allowClear />
        <Select className="workspace-log-level" value={level} onChange={setLevel} options={[{ value: 'all', label: '全部级别' }, { value: 'info', label: '信息' }, { value: 'warn', label: '警告' }, { value: 'error', label: '错误' }]} />
      </div>
      {filtered.length === 0 ? <Empty description={emptyDescription} /> : (
        <List
          className="workspace-log-list"
          size="small"
          dataSource={filtered.slice(0, 500)}
          renderItem={(log) => (
            <List.Item className="workspace-log-list-item">
              <article className="workspace-log-entry">
                <div className="workspace-log-meta">
                  <Tag className="workspace-log-level-tag" color={log.level === 'error' ? 'error' : log.level === 'warn' ? 'warning' : 'blue'}>{log.level.toUpperCase()}</Tag>
                  <time className="workspace-log-time" dateTime={log.createdAt}>{new Date(log.createdAt).toLocaleString('zh-CN')}</time>
                  <span
                    className="workspace-log-account"
                    data-platform={log.resolvedPlatform || 'unknown'}
                    title={log.resolvedAccountId ? `账号 ID：${log.resolvedAccountId}` : undefined}
                  >
                    {log.accountLabel}
                  </span>
                  <span className="workspace-log-kind" data-kind={log.resolvedMode || (log.taskId ? 'unknown' : 'system')}>{log.modeLabel}</span>
                  <strong className="workspace-log-scope">{log.scope}</strong>
                </div>
                <p className="workspace-log-message">{log.message}</p>
                {typeof log.resolvedPrompt === 'string' ? (
                  <div className="workspace-log-prompt">
                    <span className="workspace-log-prompt-label">完整提示词</span>
                    <div className="workspace-log-prompt-content">{log.resolvedPrompt}</div>
                  </div>
                ) : log.taskId ? (
                  <div className="workspace-log-prompt workspace-log-prompt--missing">
                    <span className="workspace-log-prompt-label">提示词</span>
                    <div className="workspace-log-prompt-content">历史日志未保存提示词</div>
                  </div>
                ) : null}
              </article>
            </List.Item>
          )}
        />
      )}
    </>
  );

  const actions = <div className="workspace-log-actions"><Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button><Button danger icon={<DeleteOutlined />} onClick={async () => { await window.electronAPI.logs.clear(); setLogs([]); message.success('日志已清空'); }}>清空</Button></div>;

  if (embedded) {
    return (
      <section className="workspace-full-page workspace-logs-page" aria-label="运行日志">
        <header className="workspace-page-header">
          <div>
            <div className="workspace-page-kicker">OBSERVABILITY / EVENTS</div>
            <h1>运行日志 <span>{filtered.length}</span></h1>
            <p>按账号、平台、生成类型、提示词、任务和错误检索本机自动化事件。</p>
          </div>
          <div className="workspace-log-header-actions">{actions}<Button onClick={onClose}>返回工作台</Button></div>
        </header>
        <div className="workspace-page-surface dashboard-glass">{body}</div>
      </section>
    );
  }

  return <Modal title={`运行日志 (${filtered.length})`} open={open} onCancel={onClose} width={1040} footer={actions}>{body}</Modal>;
};
