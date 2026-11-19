/**
 * src/components/AccountList.tsx
 * 账号列表组件 — V2 实时状态 + 自动排序 + 手动置顶
 *
 * 功能：
 * - 实时显示每个账号的执行状态（空闲/注入中/生成中等）
 * - 自动排序：置顶账号 → 空闲账号 → 忙碌账号
 * - 手动置顶/取消置顶，优先级最高
 * - 添加/编辑/删除/刷新账号
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  PlusOutlined,
  UserOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  MoreOutlined,
  PushpinOutlined,
  PushpinFilled,
  SafetyCertificateOutlined,
  SettingOutlined,
  UnlockOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Input, Modal, Dropdown, message, Empty, Tooltip, Segmented, Select, InputNumber, Switch, Button } from 'antd';
import type { MenuProps } from 'antd';
import { useAccountStore } from '../store/useAccountStore';
import { useTaskStore } from '../store/useTaskStore';
import { AUTO_STATE_DISPLAY } from '../types';
import type { Account, AccountPlatform } from '../types';
import type { AutomationState } from '../store/useTaskStore';
import { getAccountWarmupSortRank } from '../utils/accountAvailability';
import { VIDEO_DAILY_UNITS } from '../utils/videoQuota';
import doubaoAvatar from '../assets/doubao-avatar.png';
import dolaAvatar from '../assets/dola-avatar.png';
import { BatchDeleteDialog } from './BatchDeleteDialog';
import { accountDeletionBlocker, type DeleteItemResult } from '../utils/batchDeletion';


export const AccountList: React.FC = () => {
  const {
    accounts,
    selectedAccountId,
    loading,
    error,
    addAccount,
    updateAccount,
    deleteAccount,
    refreshAccount,
    selectAccount,
    togglePinned,
    updateScheduling,
    setVideoQuotaConfig,
    releaseSeedanceQuota,
    availabilityChecking,
    availabilityBatchCheck,
    requestAvailabilityCheck,
    requestAvailabilityCheckAll,
    clearError,
  } = useAccountStore();

  // 订阅任务 store，获取实时执行状态
  const accountBusy = useTaskStore(s => s.accountBusy);
  const tasks = useTaskStore(s => s.tasks);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const accountAutomationState = useTaskStore(s => s.accountAutomationState);
  const accountAutoMessage = useTaskStore(s => s.accountAutoMessage);
  const handleSelectAccount = useCallback((accountId: string): boolean => {
    selectAccount(accountId);
    return true;
  }, [selectAccount]);

  // 搜索
  const [searchText, setSearchText] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<AccountPlatform, boolean>>({
    doubao: true,
    dola: true,
  });

  const toggleAccountGroup = useCallback((platform: AccountPlatform): void => {
    setExpandedGroups((current) => ({
      ...current,
      [platform]: !current[platform],
    }));
  }, []);

  // 添加账号弹窗
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountPlatform, setNewAccountPlatform] = useState<AccountPlatform>('doubao');
  const [adding, setAdding] = useState(false);

  // 编辑账号弹窗
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editName, setEditName] = useState('');
  const [editing, setEditing] = useState(false);

  // 账号视频额度配置弹窗（豆包与 Dola 共用）。
  const [quotaModalOpen, setQuotaModalOpen] = useState(false);
  const [quotaAccount, setQuotaAccount] = useState<Account | null>(null);
  const [quotaTotalUnits, setQuotaTotalUnits] = useState<number>(VIDEO_DAILY_UNITS);
  const [quotaCostPerVideo, setQuotaCostPerVideo] = useState<number>(1);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [batchQuotaModalOpen, setBatchQuotaModalOpen] = useState(false);
  const [batchQuotaAccountIds, setBatchQuotaAccountIds] = useState<string[]>([]);
  const [batchQuotaTotalUnits, setBatchQuotaTotalUnits] = useState<number>(VIDEO_DAILY_UNITS);
  const [batchQuotaCostPerVideo, setBatchQuotaCostPerVideo] = useState<number>(1);
  const [batchQuotaSaving, setBatchQuotaSaving] = useState(false);
  const [batchQuotaFailures, setBatchQuotaFailures] = useState<string[]>([]);


  // ---- 实时状态计算 ----
  /** 获取账号的实时展示状态 */
  const getAccountDisplay = useCallback(
    (accountId: string): { label: string; color: string; animated: boolean; detail: string } => {
      const autoState = accountAutomationState[accountId] as AutomationState | undefined;
      const account = accounts.find((item) => item.id === accountId);
      if (autoState && autoState !== 'idle') {
        const display = AUTO_STATE_DISPLAY[autoState] || AUTO_STATE_DISPLAY.idle;
        return {
          ...display,
          detail: accountAutoMessage[accountId] || '',
        };
      }
      const isBusy = accountBusy[accountId];
      if (isBusy) {
        return { label: '忙碌', color: '#fbbf24', animated: true, detail: '' };
      }
      if (availabilityChecking[accountId]) {
        return { label: '检测中', color: '#60a5fa', animated: true, detail: '正在读取当前页面' };
      }
      const availability = account?.health?.availability;
      if (availability?.state === 'action_required') {
        return { label: '需要人工验证', color: '#fb923c', animated: true, detail: availability.message };
      }
      if (availability?.state === 'login_required') {
        return { label: '需要登录', color: '#fb7185', animated: false, detail: availability.message };
      }
      if (availability?.state === 'unavailable') {
        return { label: '自动化不可用', color: '#fb7185', animated: false, detail: availability.message };
      }
      if (availability?.state === 'unknown') {
        return { label: '待确认', color: '#fbbf24', animated: false, detail: availability.message };
      }
      if (account?.health?.loginState === 'expired') {
        return { label: '登录已失效', color: '#fb7185', animated: false, detail: '请重新登录' };
      }
      if (account?.scheduling?.enabled === false) {
        return { label: '已停用', color: '#94a3b8', animated: false, detail: '不参与自动调度' };
      }
      if (account?.scheduling?.manualCooldownUntil && new Date(account.scheduling.manualCooldownUntil).getTime() > Date.now()) {
        return { label: '手动冷却', color: '#94a3b8', animated: false, detail: `至 ${new Date(account.scheduling.manualCooldownUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` };
      }
      if (account?.health?.verificationRequired) {
        return { label: '需要验证', color: '#fb923c', animated: false, detail: '完成验证后恢复' };
      }
      if (account?.health?.cooldownUntil && new Date(account.health.cooldownUntil).getTime() > Date.now()) {
        return {
          label: '冷却中', color: '#94a3b8', animated: false,
          detail: `至 ${new Date(account.health.cooldownUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        };
      }
      if (availability?.state === 'ready') {
        const checked = new Date(availability.checkedAt);
        const checkedLabel = Number.isFinite(checked.getTime())
          ? `${checked.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 检测`
          : '';
        return { label: '自动化可用', color: '#4ade80', animated: false, detail: checkedLabel };
      }
      return { label: '尚未检测', color: '#94a3b8', animated: false, detail: '启动后将自动检测' };
    },
    [accounts, accountAutomationState, accountBusy, accountAutoMessage, availabilityChecking]
  );

  // ---- 排序逻辑 ----
  /** 搜索过滤 + 本次预热结果优先 → 既有业务优先级；同级保持用户原顺序。 */
  const sortedAccounts = useMemo(() => {
    let filtered = accounts;
    if (searchText.trim()) {
      const kw = searchText.trim().toLowerCase();
      filtered = accounts.filter(a => a.name.toLowerCase().includes(kw));
    }
    const originalOrder = new Map(filtered.map((account, index) => [account.id, index]));
    return [...filtered].sort((a, b) => {
      // 1. 当前启动已确认可用的账号最靠前；待确认/仍预热的账号最后。
      const warmupRank = getAccountWarmupSortRank(a.health?.availability) -
        getAccountWarmupSortRank(b.health?.availability);
      if (warmupRank !== 0) return warmupRank;
      // 2. 同一预热等级内，不健康或冷却中的账号沉底
      const now = Date.now();
      const aUnavailable = ['action_required', 'login_required', 'unavailable'].includes(a.health?.availability?.state || '') ||
        a.health?.loginState === 'expired' || !!a.health?.verificationRequired ||
        (!!a.health?.cooldownUntil && new Date(a.health.cooldownUntil).getTime() > now);
      const bUnavailable = ['action_required', 'login_required', 'unavailable'].includes(b.health?.availability?.state || '') ||
        b.health?.loginState === 'expired' || !!b.health?.verificationRequired ||
        (!!b.health?.cooldownUntil && new Date(b.health.cooldownUntil).getTime() > now);
      if (aUnavailable !== bUnavailable) return aUnavailable ? 1 : -1;
      // 3. Seedance 今日额度用尽的账号统一沉底
      const aExhausted = !!a.seedanceQuota?.exhausted;
      const bExhausted = !!b.seedanceQuota?.exhausted;
      if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;
      // 4. 置顶优先
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      // 5. 空闲 vs 忙碌
      const aBusy = accountBusy[a.id] || false;
      const bBusy = accountBusy[b.id] || false;
      if (aBusy !== bBusy) {
        return aBusy ? 1 : -1;
      }
      // 6. 连续失败少的账号优先；完全同级时显式维持用户原顺序。
      const failureRank = (a.health?.consecutiveFailures || 0) - (b.health?.consecutiveFailures || 0);
      if (failureRank !== 0) return failureRank;
      return (originalOrder.get(a.id) || 0) - (originalOrder.get(b.id) || 0);
    });
  }, [accounts, accountBusy, searchText]);


  // ---- 添加账号 ----
  const handleAddAccount = useCallback(async () => {
    if (!newAccountName.trim()) return;
    setAdding(true);
    const success = await addAccount(newAccountName.trim(), newAccountPlatform);
    setAdding(false);
    if (success) {
      setNewAccountName('');
      setNewAccountPlatform('doubao');
      setAddModalOpen(false);
      message.success('账号添加成功');
    } else {
      message.error(error || '添加失败');
      clearError();
    }
  }, [newAccountName, newAccountPlatform, addAccount, error, clearError]);

  // ---- 编辑账号 ----
  const handleEditAccount = useCallback(async () => {
    if (!editingAccount || !editName.trim()) return;
    setEditing(true);
    const success = await updateAccount(editingAccount.id, editName.trim());
    setEditing(false);
    if (success) {
      setEditModalOpen(false);
      setEditingAccount(null);
      message.success('账号已更新');
    }
  }, [editingAccount, editName, updateAccount]);

  const openQuotaSettings = useCallback((account: Account): void => {
    if (accountBusy[account.id] || account.status === 'busy') {
      message.warning('账号正在运行任务，请等待任务完成后再修改额度');
      return;
    }
    setQuotaAccount(account);
    setQuotaTotalUnits(account.seedanceQuota?.estimatedTotalUnits || VIDEO_DAILY_UNITS);
    setQuotaCostPerVideo(account.seedanceQuota?.costPerVideoUnits || 1);
    setQuotaModalOpen(true);
  }, [accountBusy]);

  const handleSaveQuota = useCallback(async (): Promise<void> => {
    if (!quotaAccount) return;
    if (!Number.isSafeInteger(quotaTotalUnits) || quotaTotalUnits <= 0) {
      message.error('每日总额度必须是正整数');
      return;
    }
    if (!Number.isSafeInteger(quotaCostPerVideo) || quotaCostPerVideo <= 0) {
      message.error('单次视频消耗必须是正整数');
      return;
    }
    setQuotaSaving(true);
    try {
      const success = await setVideoQuotaConfig(quotaAccount.id, quotaTotalUnits, quotaCostPerVideo);
      if (success) {
        message.success('视频额度设置已保存');
        setQuotaModalOpen(false);
        setQuotaAccount(null);
      } else {
        message.error(useAccountStore.getState().error || '视频额度配置保存失败');
      }
    } finally {
      setQuotaSaving(false);
    }
  }, [quotaAccount, quotaCostPerVideo, quotaTotalUnits, setVideoQuotaConfig]);

  const handleReleaseQuota = useCallback((account: Account): void => {
    if (accountBusy[account.id] || account.status === 'busy') {
      message.warning('账号正在运行任务，请等待任务完成后再释放本地额度');
      return;
    }
    Modal.confirm({
      title: '释放本地额度',
      content: `确定释放「${account.name}」的本地额度吗？这只会清除软件本地的额度预测，不会修改平台真实额度。`,
      okText: '确认释放',
      cancelText: '取消',
      centered: true,
      onOk: async () => {
        const success = await releaseSeedanceQuota(account.id);
        if (success) {
          message.success('本地额度已释放，可重新参与视频任务调度');
        } else {
          message.error(useAccountStore.getState().error || '释放本地额度失败');
        }
      },
    });
  }, [accountBusy, releaseSeedanceQuota]);

  const openBatchQuotaSettings = useCallback((): void => {
    setBatchQuotaAccountIds([]);
    setBatchQuotaFailures([]);
    setBatchQuotaModalOpen(true);
  }, []);

  const handleSaveBatchQuota = useCallback(async (): Promise<void> => {
    if (batchQuotaAccountIds.length === 0) {
      message.error('请至少选择一个账号');
      return;
    }
    if (!Number.isSafeInteger(batchQuotaTotalUnits) || batchQuotaTotalUnits <= 0) {
      message.error('每日总额度必须是正整数');
      return;
    }
    if (!Number.isSafeInteger(batchQuotaCostPerVideo) || batchQuotaCostPerVideo <= 0) {
      message.error('单次视频消耗必须是正整数');
      return;
    }

    setBatchQuotaSaving(true);
    setBatchQuotaFailures([]);
    const failures: Array<{ id: string; message: string }> = [];
    let successCount = 0;
    try {
      for (const accountId of batchQuotaAccountIds) {
        const latestAccount = useAccountStore.getState().accounts.find((account) => account.id === accountId);
        const isRunning = useTaskStore.getState().accountBusy[accountId] || latestAccount?.status === 'busy';
        if (!latestAccount) {
          failures.push({ id: accountId, message: `${accountId}：账号不存在` });
          continue;
        }
        if (isRunning) {
          failures.push({ id: accountId, message: `${latestAccount.name}：正在运行任务` });
          continue;
        }
        const success = await setVideoQuotaConfig(accountId, batchQuotaTotalUnits, batchQuotaCostPerVideo);
        if (success) {
          successCount += 1;
        } else {
          failures.push({
            id: accountId,
            message: `${latestAccount.name}：${useAccountStore.getState().error || '保存失败'}`,
          });
        }
      }

      if (failures.length === 0) {
        message.success(`已为 ${successCount} 个账号更新视频额度`);
        setBatchQuotaModalOpen(false);
        setBatchQuotaAccountIds([]);
      } else {
        setBatchQuotaFailures(failures.map((item) => item.message));
        setBatchQuotaAccountIds(failures.map((item) => item.id));
        message.warning(`批量设置完成：成功 ${successCount} 个，失败 ${failures.length} 个`);
      }
    } finally {
      setBatchQuotaSaving(false);
    }
  }, [batchQuotaAccountIds, batchQuotaCostPerVideo, batchQuotaTotalUnits, setVideoQuotaConfig]);

  // ---- 删除账号 ----
  const deleteBatchAccount = async (id: string): Promise<DeleteItemResult> => {
    // 确认弹窗打开后账号可能又被调度，发送删除前再次读取最新状态。
    const latestTasks = useTaskStore.getState();
    const blocker = accountDeletionBlocker(useAccountStore.getState().accounts.find(account => account.id === id), latestTasks.tasks, Boolean(latestTasks.accountBusy[id]));
    if (blocker) return { success: false, error: blocker };
    const success = await deleteAccount(id);
    return { success, error: success ? undefined : useAccountStore.getState().error || '账号删除失败' };
  };

  const handleDeleteAccount = useCallback(
    async (account: Account) => {
      Modal.confirm({
        title: '确认删除',
        content: `确定要删除账号「${account.name}」吗？该账号的会话数据将被清除。`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        centered: true,
        onOk: async () => {
          const success = await deleteAccount(account.id);
          if (success) {
            message.success('账号已删除');
          } else {
            message.error(useAccountStore.getState().error || '删除失败，请稍后重试');
          }
        },
      });
    },
    [deleteAccount]
  );

  // ---- 刷新账号 ----
  const handleRefreshAccount = useCallback(
    async (account: Account) => {
      const success = await refreshAccount(account.id);
      if (success) {
        message.success('已清除登录并刷新账号页面');
      } else {
        message.error(useAccountStore.getState().error || '清除登录失败，请稍后重试');
      }
    },
    [refreshAccount]
  );

  // ---- 置顶/取消置顶 ----
  const handleTogglePinned = useCallback(
    async (account: Account, e?: React.MouseEvent) => {
      e?.stopPropagation();
      await togglePinned(account.id);
    },
    [togglePinned]
  );

  const accountGroups = useMemo(() => ([
    {
      platform: 'doubao' as const,
      label: '豆包账号',
      accounts: sortedAccounts.filter((account) => account.platform !== 'dola'),
    },
    {
      platform: 'dola' as const,
      label: 'Dola 账号',
      accounts: sortedAccounts.filter((account) => account.platform === 'dola'),
    },
  ].filter((group) => group.accounts.length > 0)), [sortedAccounts]);

  // ---- 右键菜单 ----
  const getContextMenuItems = useCallback(
    (account: Account): MenuProps['items'] => [
      {
        key: 'pin',
        label: account.pinned ? '取消置顶' : '置顶',
        icon: account.pinned ? <PushpinFilled /> : <PushpinOutlined />,
        onClick: () => handleTogglePinned(account),
      },
      {
        key: 'scheduling-toggle',
        label: account.scheduling?.enabled === false ? '恢复自动调度' : '暂停自动调度',
        onClick: () => updateScheduling(account.id, { enabled: account.scheduling?.enabled === false }),
      },
      {
        key: 'cooldown',
        label: '冷却 30 分钟',
        onClick: () => updateScheduling(account.id, { manualCooldownUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
      },
      {
        key: 'edit',
        label: '编辑',
        icon: <EditOutlined />,
        onClick: () => {
          setEditingAccount(account);
          setEditName(account.name);
          setEditModalOpen(true);
        },
      },
      {
        key: 'video-quota',
        label: '视频额度设置',
        icon: <SettingOutlined />,
        disabled: !!accountBusy[account.id] || account.status === 'busy',
        onClick: () => openQuotaSettings(account),
      },
      {
        key: 'release-video-quota',
        label: '释放本地额度',
        icon: <UnlockOutlined />,
        disabled: !!accountBusy[account.id] || account.status === 'busy',
        onClick: () => handleReleaseQuota(account),
      },
      {
        key: 'availability-check',
        label: availabilityChecking[account.id] ? '正在检测可用性…' : '立即检测可用性',
        icon: <SafetyCertificateOutlined />,
        disabled: !!availabilityChecking[account.id],
        onClick: () => {
          requestAvailabilityCheck(account.id);
        },
      },
      {
        key: 'refresh',
        label: '清除登录并刷新',
        icon: <ReloadOutlined />,
        onClick: () => handleRefreshAccount(account),
      },
      { type: 'divider' },
      {
        key: 'delete',
        label: '删除',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => handleDeleteAccount(account),
      },
    ],
    [accountBusy, availabilityChecking, handleDeleteAccount, handleRefreshAccount, handleReleaseQuota, handleTogglePinned, openQuotaSettings, requestAvailabilityCheck, updateScheduling]
  );

  const availabilityBatchTotal = Object.keys(availabilityBatchCheck.requestIds).length;
  const availabilityBatchCompleted = availabilityBatchCheck.completedAccountIds.length;
  const availabilityBatchAttention = availabilityBatchCheck.attentionAccountIds.length;

  return (
    <div className="account-list-panel flex flex-col h-full">
      {/* 面板标题栏 */}
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="panel-title">账号列表</span>
          <span className="text-xs text-db-text-muted bg-db-surface px-1.5 py-0.5 rounded-full">
            {accounts.length}
          </span>
          <span className="text-2xs text-db-text-muted">
            可用 {accounts.filter((account) => account.health?.availability?.state === 'ready').length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip title="一键检测全部账号">
            <button
              type="button"
              className="btn-ghost text-db-text-muted hover:!text-db-accent-light disabled:opacity-40"
              aria-label="一键检测全部账号"
              disabled={availabilityBatchCheck.running || accounts.length === 0}
              onClick={requestAvailabilityCheckAll}
            >
              <SafetyCertificateOutlined className={availabilityBatchCheck.running ? 'animate-pulse' : ''} />
            </button>
          </Tooltip>
          <Tooltip title="批量设置视频额度">
            <button
              type="button"
              className="btn-ghost text-db-text-muted hover:!text-db-accent-light"
              aria-label="批量设置视频额度"
              onClick={openBatchQuotaSettings}
            >
              <SettingOutlined />
            </button>
          </Tooltip>
          <Tooltip title="添加账号">
            <button
              type="button"
              className="btn-ghost text-db-accent hover:!text-db-accent-light"
              aria-label="添加账号"
              onClick={() => setAddModalOpen(true)}
            >
              <PlusOutlined />
            </button>
          </Tooltip>
        </div>
      </div>

      {availabilityBatchCheck.runId > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 py-1 text-2xs text-db-text-muted border-b border-db-border/60">
          <span>
            {availabilityBatchCheck.running ? '批量检测中' : '批量检测完成'} {availabilityBatchCompleted}/{availabilityBatchTotal}
          </span>
          <span className={availabilityBatchAttention > 0 ? 'text-amber-300' : 'text-emerald-300'}>
            需处理 {availabilityBatchAttention}
          </span>
        </div>
      )}

      {/* 搜索框 */}
      {accounts.length > 0 && (
        <div className="account-search-wrap flex items-center gap-2 px-2 pb-1">
          <input
            type="text"
            placeholder="搜索账号..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="min-w-0 flex-1 px-2.5 py-1.5 text-xs rounded-md border border-db-border bg-db-surface text-db-text-primary placeholder-db-text-muted focus:outline-none focus:border-db-accent/50"
          />
          <Button icon={<DeleteOutlined aria-hidden="true" />} onClick={(): void => setBatchDeleteOpen(true)} disabled={!sortedAccounts.length}>批量删除</Button>
        </div>
      )}

      {batchDeleteOpen && <BatchDeleteDialog noun="账号" items={sortedAccounts.map(account => ({
        id: account.id, label: account.name, detail: account.platform === 'dola' ? 'Dola 账号' : '豆包账号',
        blockedReason: accountDeletionBlocker(account, tasks, Boolean(accountBusy[account.id])),
      }))} description="删除所选账号并清除其登录会话；不会注销平台账号。排队或运行中的任务所用账号需要先暂停或改派。"
        onDelete={deleteBatchAccount} onClose={(): void => setBatchDeleteOpen(false)} />}

      {/* 账号列表 */}
      <div className="account-scroll-region flex-1 overflow-y-auto p-2 space-y-1">
        {sortedAccounts.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-db-text-muted text-xs">
                  暂无账号，点击 + 添加
                </span>
              }
            />
          </div>
        ) : (
          accountGroups.map((group) => (
            <section key={group.platform} className="space-y-1">
              <div className="account-group-header flex items-center justify-between px-1 pt-1 pb-0.5">
                <button
                  type="button"
                  className="account-group-toggle flex items-center gap-1.5 min-w-0"
                  aria-expanded={expandedGroups[group.platform]}
                  aria-controls={`account-group-${group.platform}`}
                  onClick={() => toggleAccountGroup(group.platform)}
                >
                  <span className="account-group-chevron" aria-hidden="true">
                    {expandedGroups[group.platform] ? <DownOutlined /> : <RightOutlined />}
                  </span>
                  <span className="text-2xs font-semibold tracking-wide text-db-text-muted">{group.label}</span>
                  <span className="text-2xs text-db-text-muted bg-db-surface px-1.5 py-0.5 rounded-full">{group.accounts.length}</span>
                </button>
              </div>
              <div id={`account-group-${group.platform}`} className="space-y-1" hidden={!expandedGroups[group.platform]}>
                {group.accounts.map((account) => {
                const isSelected = selectedAccountId === account.id;
                const display = getAccountDisplay(account.id);
                const platformLabel = account.platform === 'dola' ? 'Dola' : '豆包';
                const platformAvatar = account.platform === 'dola' ? dolaAvatar : doubaoAvatar;

                return (
              <Dropdown
                key={account.id}
                menu={{ items: getContextMenuItems(account) }}
                trigger={['contextMenu']}
              >
                <div
                  className={`account-card ${isSelected ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 rounded-db cursor-pointer transition-all duration-200 border ${
                    isSelected
                      ? 'bg-db-accent/15 border-db-accent/40 shadow-sm'
                      : 'bg-db-surface hover:bg-db-surface-hover border-transparent'
                  }`}
                  onClick={() => handleSelectAccount(account.id)}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleSelectAccount(account.id);
                    }
                  }}
                >
                  {/* 头像 */}
                  <div
                    className={`account-avatar flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0 text-white text-sm font-semibold ${
                      isSelected ? 'bg-db-accent' : 'bg-db-border'
                    }`}
                  >
                    <img
                      src={platformAvatar}
                      alt={`${platformLabel}账号头像`}
                      className="w-full h-full rounded-full object-cover"
                    />
                  </div>

                  {/* 名称 + 实时状态 */}
                  <div className="account-card-body flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {/* 置顶标记 */}
                      {account.pinned && (
                        <PushpinFilled
                          className="text-[10px] text-db-accent flex-shrink-0"
                          title="已置顶"
                        />
                      )}
                      <span className="text-sm font-medium text-db-text-primary truncate">
                        {account.name}
                      </span>
                      <span className="text-2xs text-db-text-muted uppercase">
                        {platformLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {/* 状态指示点 */}
                      <span
                        className={`status-dot ${display.animated ? 'animate-pulse' : ''}`}
                        style={{ backgroundColor: display.color }}
                      />
                      <span className="text-2xs text-db-text-muted">
                        {display.label}
                      </span>
                      {/* 详细状态信息 */}
                      {display.detail && (
                        <span className="text-2xs text-db-text-muted truncate ml-1 opacity-70">
                          {display.detail}
                        </span>
                      )}
                    </div>
                    {account.seedanceQuota && (
                      <div
                        className="text-2xs mt-0.5 truncate"
                        style={{ color: account.seedanceQuota.exhausted ? '#fb7185' : '#818cf8' }}
                        title={`每日总额度 ${account.seedanceQuota.estimatedTotalUnits}；${account.seedanceQuota.costPerVideoUnits ? `每次视频消耗 ${account.seedanceQuota.costPerVideoUnits}` : '当前按视频时长估算消耗'}`}
                      >
                        {account.seedanceQuota.exhausted
                          ? '视频额度今日已用尽'
                          : `视频额度 ${Math.max(0, account.seedanceQuota.estimatedTotalUnits - account.seedanceQuota.usedUnits)}/${account.seedanceQuota.estimatedTotalUnits} · ${account.seedanceQuota.costPerVideoUnits ? `每次 ${account.seedanceQuota.costPerVideoUnits}` : '按时长估算'}`}
                      </div>
                    )}
                    {!!account.health && (account.health.successCount > 0 || account.health.failureCount > 0) && (
                      <div className="text-2xs mt-0.5 text-db-text-muted truncate">
                        成功 {account.health.successCount} · 失败 {account.health.failureCount}
                        {account.health.consecutiveFailures > 0 ? ` · 连续失败 ${account.health.consecutiveFailures}` : ''}
                      </div>
                    )}
                  </div>

                  {/* 置顶快捷按钮 */}
                  <Tooltip title={account.pinned ? '取消置顶' : '置顶'}>
                    <button
                      className={`btn-ghost w-6 h-6 flex-shrink-0 ${
                        account.pinned ? 'text-db-accent' : 'text-db-text-muted opacity-40 hover:opacity-100'
                      }`}
                      onClick={(e) => handleTogglePinned(account, e)}
                    >
                      {account.pinned ? (
                        <PushpinFilled style={{ fontSize: 12 }} />
                      ) : (
                        <PushpinOutlined style={{ fontSize: 12 }} />
                      )}
                    </button>
                  </Tooltip>

                  {/* 操作按钮 */}
                  <Dropdown
                    menu={{ items: getContextMenuItems(account) }}
                    trigger={['click']}
                  >
                    <button
                      className="btn-ghost w-7 h-7"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreOutlined style={{ fontSize: 13 }} />
                    </button>
                  </Dropdown>
                </div>
              </Dropdown>
                );
                })}
              </div>
            </section>
          ))
        )}
      </div>

      {/* 添加账号弹窗 */}
      <Modal
        title="添加账号"
        open={addModalOpen}
        onOk={handleAddAccount}
        onCancel={() => {
          setAddModalOpen(false);
          setNewAccountName('');
          setNewAccountPlatform('doubao');
        }}
        confirmLoading={adding}
        okText="添加"
        cancelText="取消"
        centered
        width={400}
      >
        <div className="py-4">
          <div className="text-xs text-db-text-muted mb-2">账号平台</div>
          <Segmented
            value={newAccountPlatform}
            onChange={(value) => setNewAccountPlatform(value as AccountPlatform)}
            options={[{ label: '豆包', value: 'doubao' }, { label: 'Dola', value: 'dola' }]}
            block
            style={{ marginBottom: 12 }}
          />
          <Input
            placeholder="输入账号名称（如：工作号-01）"
            value={newAccountName}
            onChange={(e) => setNewAccountName(e.target.value)}
            onPressEnter={handleAddAccount}
            autoFocus
            size="large"
            prefix={<UserOutlined className="text-db-text-muted" />}
          />
        </div>
      </Modal>

      {/* 编辑账号弹窗 */}
      <Modal
        title="编辑账号"
        open={editModalOpen}
        onOk={handleEditAccount}
        onCancel={() => {
          setEditModalOpen(false);
          setEditingAccount(null);
        }}
        confirmLoading={editing}
        okText="保存"
        cancelText="取消"
        centered
        width={400}
      >
        <div className="py-4">
          <Input
            placeholder="输入新名称"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onPressEnter={handleEditAccount}
            autoFocus
            size="large"
          />
        </div>
      </Modal>

      {/* 批量视频额度设置弹窗 */}
      <Modal
        title="批量设置视频额度"
        open={batchQuotaModalOpen}
        onOk={() => void handleSaveBatchQuota()}
        onCancel={() => {
          setBatchQuotaModalOpen(false);
          setBatchQuotaFailures([]);
        }}
        confirmLoading={batchQuotaSaving}
        cancelButtonProps={{ disabled: batchQuotaSaving }}
        closable={!batchQuotaSaving}
        maskClosable={!batchQuotaSaving}
        okText="批量保存"
        cancelText="取消"
        centered
        width={500}
      >
        <div className="py-3 space-y-4" aria-busy={batchQuotaSaving}>
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-xs text-db-text-muted">选择账号（豆包 + Dola）</div>
              <div className="flex items-center gap-1">
                <Button
                  type="link"
                  size="small"
                  disabled={batchQuotaSaving}
                  onClick={() => setBatchQuotaAccountIds(accounts
                    .filter((account) => !accountBusy[account.id] && account.status !== 'busy')
                    .map((account) => account.id))}
                >
                  全选可用账号
                </Button>
                <Button type="link" size="small" disabled={batchQuotaSaving} onClick={() => setBatchQuotaAccountIds([])}>
                  清空
                </Button>
              </div>
            </div>
            <Select
              mode="multiple"
              value={batchQuotaAccountIds}
              onChange={setBatchQuotaAccountIds}
              options={accounts.map((account) => {
                const running = !!accountBusy[account.id] || account.status === 'busy';
                return {
                  value: account.id,
                  label: `${account.platform === 'dola' ? 'Dola' : '豆包'} · ${account.name}${running ? '（运行中）' : ''}`,
                  disabled: running,
                };
              })}
              placeholder="至少选择一个账号"
              maxTagCount="responsive"
              disabled={batchQuotaSaving}
              style={{ width: '100%' }}
              aria-label="选择需要批量设置视频额度的账号"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-db-text-muted mb-2">每日视频总额度</div>
              <InputNumber
                value={batchQuotaTotalUnits}
                onChange={(value) => setBatchQuotaTotalUnits(typeof value === 'number' ? value : VIDEO_DAILY_UNITS)}
                min={1}
                precision={0}
                disabled={batchQuotaSaving}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className="text-xs text-db-text-muted mb-2">每次视频生成消耗</div>
              <InputNumber
                value={batchQuotaCostPerVideo}
                onChange={(value) => setBatchQuotaCostPerVideo(typeof value === 'number' ? value : 1)}
                min={1}
                precision={0}
                disabled={batchQuotaSaving}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div className="text-2xs text-db-text-muted leading-5">
            运行中的账号不可修改。批量保存会逐个写入，失败账号会保留在选择框中供再次处理。
          </div>
          {batchQuotaFailures.length > 0 && (
            <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300" aria-live="polite">
              {batchQuotaFailures.map((failure, index) => <div key={`${failure}-${index}`}>{failure}</div>)}
            </div>
          )}
        </div>
      </Modal>

      {/* 账号视频额度设置弹窗 */}
      <Modal
        title={`${quotaAccount?.platform === 'dola' ? 'Dola' : '豆包'}视频额度设置`}
        open={quotaModalOpen}
        onOk={() => void handleSaveQuota()}
        onCancel={() => {
          setQuotaModalOpen(false);
          setQuotaAccount(null);
        }}
        confirmLoading={quotaSaving}
        okText="保存"
        cancelText="取消"
        centered
        width={420}
      >
        <div className="py-3 space-y-4">
          <div>
            <div className="text-xs text-db-text-muted mb-2">每日视频总额度</div>
            <InputNumber
              value={quotaTotalUnits}
              onChange={(value) => setQuotaTotalUnits(typeof value === 'number' ? value : VIDEO_DAILY_UNITS)}
              min={1}
              precision={0}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <div className="text-xs text-db-text-muted mb-2">每次视频生成消耗</div>
            <InputNumber
              value={quotaCostPerVideo}
              onChange={(value) => setQuotaCostPerVideo(typeof value === 'number' ? value : 1)}
              min={1}
              precision={0}
              style={{ width: '100%' }}
            />
          </div>
          {!quotaAccount?.seedanceQuota?.costPerVideoUnits && (
            <div className="text-2xs text-db-text-muted leading-5">
              当前账号仍按旧版视频时长估算消耗；保存后将按上方单次消耗固定扣减。
            </div>
          )}
          <div className="text-2xs text-db-text-muted">
            已使用 {quotaAccount?.seedanceQuota?.usedUnits || 0} 单位；保存后会按新总额重新判断是否可继续生成。
          </div>
        </div>
      </Modal>

    </div>
  );
};
