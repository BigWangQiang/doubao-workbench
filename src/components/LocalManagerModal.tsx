import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  DeleteOutlined,
  CloudDownloadOutlined,
  FileTextOutlined,
  LinkOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Account, AccountPlatform, DolaCkImportItem, DolaPoolEntry, DoubaoCkImportItem, DoubaoPoolEntry, ProxyPoolEntry, ProxySubscriptionEntry, LocalCheckState, LocalRoutingMode, AccountProxyProtocol, ProxyPoolProtocol, ProxySubscriptionState } from '@doubao-studio/contracts';
import { useAccountStore } from '../store/useAccountStore';
import { useLocalManagerStore, type DoubaoProvisionResult } from '../store/useLocalManagerStore';
import { splitDolaCkJsonEntries, splitDolaCkTxtEntries } from '../utils/dolaCredentialInput';
import { splitDoubaoCkJsonEntries, splitDoubaoCkTxtEntries } from '../utils/doubaoCredentialInput';

interface LocalManagerModalProps {
  open: boolean;
  onClose: () => void;
  /** 在工作区主区域展示；只改变外层容器，不改变本地管理器业务操作。 */
  embedded?: boolean;
  /** 主工作区可分别展示账号登录或代理路由；旧弹窗默认保留全部功能。 */
  view?: 'combined' | 'dola' | 'doubao' | 'routing';
}

const STATUS_LABEL: Record<LocalCheckState, string> = {
  unknown: '未检测',
  checking: '检测中',
  valid: '可用',
  invalid: '失效',
  manual_required: '需人工登录',
};

const STATUS_COLOR: Record<LocalCheckState, string> = {
  unknown: 'default',
  checking: 'processing',
  valid: 'success',
  invalid: 'error',
  manual_required: 'warning',
};

function StatusTag({ state }: { state: LocalCheckState }): React.ReactElement {
  return (
    <Tag color={STATUS_COLOR[state]} icon={state === 'checking' ? <LoadingOutlined spin /> : undefined}>
      {STATUS_LABEL[state]}
    </Tag>
  );
}

function nextDolaAccountName(accounts: readonly Account[]): string {
  const names = new Set(
    accounts
      .filter((account) => account.platform === 'dola')
      .map((account) => account.name),
  );
  let index = 1;
  while (names.has(`Dola ${index}`)) index += 1;
  return `Dola ${index}`;
}

export const LocalManagerModal: React.FC<LocalManagerModalProps> = ({ open, onClose, embedded = false, view = 'combined' }) => {
  const {
    snapshot,
    error,
    load,
    importDolaCk,
    importDoubaoCk,
    loadDolaCkToAccount,
    reloginDolaCk,
    deleteDola,
    clearDola,
    retestDola,
    loadDoubaoCkToAccount,
    reloginDoubaoCk,
    deleteDoubao,
    clearDoubao,
    retestDoubao,
    provisionAvailableDoubaoCk,
    setConcurrency,
    addProxy,
    setProxyEnabled,
    deleteProxy,
    retestProxy,
    addSubscription,
    refreshSubscription,
    deleteSubscription,
    bind,
    unbind,
    randomAssign,
    setRoutingMode,
    clearError,
  } = useLocalManagerStore();
  const accounts = useAccountStore((state) => state.accounts);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const txtFileInputRef = useRef<HTMLInputElement>(null);
  const doubaoFileInputRef = useRef<HTMLInputElement>(null);
  const doubaoTxtFileInputRef = useRef<HTMLInputElement>(null);
  const [proxyLabel, setProxyLabel] = useState('');
  const [proxyProtocol, setProxyProtocol] = useState<AccountProxyProtocol>('http');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [subscriptionLabel, setSubscriptionLabel] = useState('');
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [addingSubscription, setAddingSubscription] = useState(false);
  const [refreshingSubscriptions, setRefreshingSubscriptions] = useState<Record<string, boolean>>({});
  const [loadTargets, setLoadTargets] = useState<Record<string, string>>({});
  const [bindingAccount, setBindingAccount] = useState<string>();
  const [bindingPlatform, setBindingPlatform] = useState<AccountPlatform>('dola');
  const [bindingProxy, setBindingProxy] = useState<string | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [perProxyLimit, setPerProxyLimit] = useState(1);
  const [batchProgress, setBatchProgress] = useState<{
    label: string;
    completed: number;
    total: number;
    failed: number;
  } | null>(null);
  const [retestingDola, setRetestingDola] = useState(false);
  const [retestingDoubao, setRetestingDoubao] = useState(false);
  const [retestingProxy, setRetestingProxy] = useState(false);
  const [addingProxy, setAddingProxy] = useState(false);
  const [proxyToggling, setProxyToggling] = useState<Record<string, boolean>>({});
  const autoLinkingRef = useRef(false);

  useEffect(() => {
    if (error) message.error(error);
  }, [error]);

  const dolaAccounts = useMemo(
    () => accounts.filter((account) => account.platform === 'dola'),
    [accounts],
  );
  const doubaoAccounts = useMemo(
    () => accounts.filter((account) => (account.platform || 'doubao') === 'doubao'),
    [accounts],
  );
  const bindingAccounts = bindingPlatform === 'dola' ? dolaAccounts : doubaoAccounts;
  const bindingPlatformLabel = bindingPlatform === 'dola' ? 'Dola' : '豆包';

  const proxyOptions = snapshot.proxies.map((proxy) => ({
    value: proxy.id,
    label: `${proxy.label} (${proxy.protocol.toUpperCase()}${proxy.managedByCore ? ' · 内置核心' : ''} ${proxy.host}:${proxy.port})`,
    disabled: proxy.enabled === false || proxy.state === 'invalid',
  }));
  const batchRunning = Boolean(batchProgress && batchProgress.completed < batchProgress.total);

  const handleReloginAll = async (): Promise<void> => {
    const linkedEntries = snapshot.dola.filter((entry) => entry.source !== 'email' && Boolean(entry.accountId));
    if (linkedEntries.length === 0) {
      message.info('暂无已关联 Dola 账号的 CK');
      return;
    }
    await runBatch(linkedEntries, '批量重登 CK', async (entry) => reloginDolaCk(entry.id));
    await useAccountStore.getState().loadAccounts();
    await load();
  };

  const handleReloginAllDoubao = async (): Promise<void> => {
    const linkedEntries = snapshot.doubao.filter((entry) => Boolean(entry.accountId));
    if (linkedEntries.length === 0) {
      message.info('暂无已关联豆包账号的 CK');
      return;
    }
    await runBatch(linkedEntries, '批量重登豆包 CK', async (entry) => reloginDoubaoCk(entry.id));
    await useAccountStore.getState().loadAccounts();
    await load();
  };

  const provisionAvailableCkAccounts = useCallback(async (): Promise<void> => {
    if (autoLinkingRef.current) return;
    autoLinkingRef.current = true;
    try {
      const snapshotResult = await window.electronAPI.localManager.snapshot();
      if (!snapshotResult.success || !snapshotResult.data) return;
      const unlinked = snapshotResult.data.dola.filter(
        (entry) => entry.source !== 'email' && entry.state === 'valid' && !entry.accountId,
      );
      if (unlinked.length === 0) return;

      let accounts = await window.electronAPI.accounts.list();
      const linkedAccountIds = new Set(
        snapshotResult.data.dola
          .map((entry) => entry.accountId)
          .filter((accountId): accountId is string => Boolean(accountId)),
      );
      const available = accounts.filter(
        (account) => account.platform === 'dola' && !linkedAccountIds.has(account.id),
      );
      let linkedCount = 0;
      let createdCount = 0;

      for (const entry of unlinked) {
        let account = available.shift();
        if (!account) {
          const created = await window.electronAPI.accounts.add(nextDolaAccountName(accounts), 'dola');
          if (!created.success || !created.account) {
            message.error(created.error || `无法为 CK「${entry.label}」创建 Dola 账号`);
            continue;
          }
          account = created.account;
          accounts = [...accounts, account];
          createdCount += 1;
        }

        if (await loadDolaCkToAccount(entry.id, account.id)) {
          linkedAccountIds.add(account.id);
          linkedCount += 1;
        }
      }

      if (linkedCount > 0 || createdCount > 0) {
        await useAccountStore.getState().loadAccounts();
        await load();
        message.success(`已自动关联 ${linkedCount} 条 CK，创建 ${createdCount} 个 Dola 会话`);
      }
    } finally {
      autoLinkingRef.current = false;
    }
  }, [load, loadDolaCkToAccount]);

  const provisionAvailableDoubaoCkAccounts = useCallback(async (entryIds?: string[]): Promise<DoubaoProvisionResult> => {
    const result = await provisionAvailableDoubaoCk(entryIds);
    if (result.linkedCount > 0 || result.createdCount > 0) {
      await useAccountStore.getState().loadAccounts();
      await load();
    }
    return result;
  }, [load, provisionAvailableDoubaoCk]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      // CK 自动关联在主进程完成后，先刷新账号列表，确保新建的 Dola
      // 会话立即出现在关联下拉框中，而不是继续显示旧快照。
      await useAccountStore.getState().loadAccounts();
      await load();
      await provisionAvailableCkAccounts();
    })();
  }, [load, open, provisionAvailableCkAccounts]);

  const runBatch = async <T,>(
    items: readonly T[],
    label: string,
    worker: (item: T, index: number) => Promise<boolean>,
  ): Promise<void> => {
    if (items.length === 0) return;
    let cursor = 0;
    setBatchProgress({ label, completed: 0, total: items.length, failed: 0 });
    let completed = 0;
    let failed = 0;
    const workerCount = Math.min(Math.max(1, snapshot.concurrency), items.length);
    const runWorker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        let ok = false;
        try {
          ok = await worker(items[index], index);
        } catch {
          ok = false;
        }
        completed += 1;
        if (!ok) failed += 1;
        setBatchProgress({ label, completed, total: items.length, failed });
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    setBatchProgress({ label, completed: items.length, total: items.length, failed });
  };

  const handleRetestDola = useCallback(async (): Promise<void> => {
    if (retestingDola) return;
    setRetestingDola(true);
    try {
      await retestDola();
    } finally {
      setRetestingDola(false);
    }
  }, [retestDola, retestingDola]);

  const handleRetestDoubao = useCallback(async (): Promise<void> => {
    if (retestingDoubao) return;
    setRetestingDoubao(true);
    try {
      await retestDoubao();
    } finally {
      setRetestingDoubao(false);
    }
  }, [retestDoubao, retestingDoubao]);

  const handleRetestProxy = useCallback(async (): Promise<void> => {
    if (retestingProxy) return;
    setRetestingProxy(true);
    try {
      await retestProxy();
    } finally {
      setRetestingProxy(false);
    }
  }, [retestProxy, retestingProxy]);

  const dolaColumns: ColumnsType<DolaPoolEntry> = [
    { title: '名称', dataIndex: 'label', key: 'label', ellipsis: true },
    { title: '邮箱', dataIndex: 'emailMasked', key: 'emailMasked', render: (value: string | undefined) => value || '-' },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      render: (value: DolaPoolEntry['source']) => value === 'ck_json' ? 'CK JSON' : value === 'ck_txt' ? 'CK TXT' : '邮箱',
    },
    { title: '状态', dataIndex: 'state', key: 'state', render: (value: LocalCheckState) => <StatusTag state={value} /> },
    {
      title: '关联账号', dataIndex: 'accountId', key: 'accountId',
      render: (value: string | undefined) => {
        if (!value) return '未加载';
        const account = accounts.find((item) => item.id === value);
        return account ? `${account.name}（${account.id.slice(0, 8)}）` : value;
      },
    },
    {
      title: '操作', key: 'actions', width: 350,
      render: (_value, entry) => {
        const linkedAccount = entry.accountId ? accounts.find((account) => account.id === entry.accountId) : undefined;
        const targetAccountId = loadTargets[entry.id] ?? linkedAccount?.id;
        const needsLoad = Boolean(targetAccountId && targetAccountId !== entry.accountId);
        return (
        <Space wrap>
          {entry.source !== 'email' && (
            <Select
              size="small"
              placeholder="选择 Dola 账号"
              value={targetAccountId}
              options={dolaAccounts.map((account) => ({ value: account.id, label: account.name }))}
              onChange={(value) => setLoadTargets((current) => ({ ...current, [entry.id]: value }))}
              style={{ width: 125 }}
            />
          )}
          {entry.source !== 'email' && (
            <Button
              size="small"
              icon={<LinkOutlined />}
              disabled={!needsLoad}
              onClick={async () => {
                if (!targetAccountId) return;
                const ok = await loadDolaCkToAccount(entry.id, targetAccountId);
                if (ok) message.success('CK 已加载到 Dola Session');
              }}
            >
              {entry.accountId ? '已关联' : '加载'}
            </Button>
          )}
          {entry.source !== 'email' && entry.accountId && (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={batchRunning}
              onClick={async () => {
                if (await reloginDolaCk(entry.id)) {
                  await useAccountStore.getState().loadAccounts();
                  message.success(`已重新登录 ${entry.label}`);
                }
              }}
            >
              重登
            </Button>
          )}
          <Popconfirm title="删除本地 CK 条目？" onConfirm={() => void deleteDola(entry.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
        );
      },
    },
  ];

  const doubaoColumns: ColumnsType<DoubaoPoolEntry> = [
    { title: '名称', dataIndex: 'label', key: 'label', ellipsis: true },
    { title: '账号', dataIndex: 'emailMasked', key: 'emailMasked', render: (value: string | undefined) => value || '-' },
    {
      title: '来源', dataIndex: 'source', key: 'source',
      render: (value: DoubaoPoolEntry['source']) => value === 'ck_json' ? 'CK JSON' : 'CK TXT',
    },
    { title: '状态', dataIndex: 'state', key: 'state', render: (value: LocalCheckState) => <StatusTag state={value} /> },
    {
      title: '关联账号', dataIndex: 'accountId', key: 'accountId',
      render: (value: string | undefined) => {
        if (!value) return '未加载';
        const account = accounts.find((item) => item.id === value);
        return account ? `${account.name}（${account.id.slice(0, 8)}）` : value;
      },
    },
    {
      title: '操作', key: 'actions', width: 350,
      render: (_value, entry) => {
        const linkedAccount = entry.accountId ? accounts.find((account) => account.id === entry.accountId) : undefined;
        const targetAccountId = loadTargets[entry.id] ?? linkedAccount?.id;
        const needsLoad = Boolean(targetAccountId && targetAccountId !== entry.accountId);
        return (
          <Space wrap>
            <Select
              size="small"
              placeholder="选择豆包账号"
              value={targetAccountId}
              options={doubaoAccounts.map((account) => ({ value: account.id, label: account.name }))}
              onChange={(value) => setLoadTargets((current) => ({ ...current, [entry.id]: value }))}
              style={{ width: 125 }}
            />
            <Button
              size="small"
              icon={<LinkOutlined />}
              disabled={!needsLoad}
              onClick={async () => {
                if (!targetAccountId) return;
                if (await loadDoubaoCkToAccount(entry.id, targetAccountId)) message.success('豆包 CK 已加载到 Session');
              }}
            >
              {entry.accountId ? '已关联' : '加载'}
            </Button>
            {entry.accountId && (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                disabled={batchRunning}
                onClick={async () => {
                  if (await reloginDoubaoCk(entry.id)) {
                    await useAccountStore.getState().loadAccounts();
                    message.success(`已重新登录 ${entry.label}`);
                  }
                }}
              >
                重登
              </Button>
            )}
            <Popconfirm title="删除本地豆包 CK 条目？" onConfirm={() => void deleteDoubao(entry.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const handleProxyEnabledChange = useCallback(async (proxy: ProxyPoolEntry, enabled: boolean): Promise<void> => {
    setProxyToggling((current) => ({ ...current, [proxy.id]: true }));
    try {
      const success = await setProxyEnabled(proxy.id, enabled);
      if (success) message.success(`${proxy.label} 已${enabled ? '启用' : '禁用'}`);
    } finally {
      setProxyToggling((current) => ({ ...current, [proxy.id]: false }));
    }
  }, [setProxyEnabled]);

  const proxyColumns: ColumnsType<ProxyPoolEntry> = [
    {
      title: '名称', dataIndex: 'label', key: 'label', ellipsis: true,
      render: (value: string, proxy) => (
        <Space size={4}>
          <span>{value}</span>
          {proxy.isBuiltin && <Tag color="blue">平台预置</Tag>}
          {proxy.managedByCore && <Tag color="purple">内置核心</Tag>}
        </Space>
      ),
    },
    { title: '协议', dataIndex: 'protocol', key: 'protocol', render: (value: ProxyPoolProtocol) => value.toUpperCase() },
    { title: '地址', key: 'address', render: (_value, proxy) => `${proxy.host}:${proxy.port}` },
    { title: '账号', dataIndex: 'username', key: 'username', render: (value: string | undefined, proxy) => proxy.managedByCore ? '核心托管' : (value || '无认证') },
    {
      title: '启用', dataIndex: 'enabled', key: 'enabled', width: 72,
      render: (_value: boolean, proxy) => (
        <Switch
          size="small"
          checked={proxy.enabled !== false}
          loading={Boolean(proxyToggling[proxy.id])}
          onChange={(enabled) => void handleProxyEnabledChange(proxy, enabled)}
        />
      ),
    },
    { title: '状态', dataIndex: 'state', key: 'state', render: (value: LocalCheckState) => <StatusTag state={value} /> },
    { title: '延迟', dataIndex: 'latencyMs', key: 'latencyMs', render: (value: number | undefined) => value ? `${value} ms` : '-' },
    {
      title: '操作', key: 'actions', width: 70,
      render: (_value, proxy) => (
        proxy.isBuiltin ? (
          <Tooltip title="平台共享IP为系统预置，不能删除">
            <Button size="small" disabled icon={<SafetyCertificateOutlined />} />
          </Tooltip>
        ) : (
          <Popconfirm title="删除代理并解除绑定？" onConfirm={() => void deleteProxy(proxy.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        )
      ),
    },
  ];

  const subscriptionStateLabel: Record<ProxySubscriptionState, string> = {
    not_configured: '待平台配置',
    idle: '待刷新',
    refreshing: '刷新中',
    ready: '已就绪',
    error: '刷新异常',
  };
  const subscriptionStateColor: Record<ProxySubscriptionState, string> = {
    not_configured: 'default',
    idle: 'default',
    refreshing: 'processing',
    ready: 'success',
    error: 'error',
  };
  const subscriptionColumns: ColumnsType<ProxySubscriptionEntry> = [
    {
      title: '订阅',
      dataIndex: 'label',
      key: 'label',
      ellipsis: true,
      render: (value: string, entry) => (
        <Space size={4}>
          <span>{value}</span>
          {entry.isBuiltin && <Tag color="blue">平台共享</Tag>}
        </Space>
      ),
    },
    { title: '地址', dataIndex: 'urlHost', key: 'urlHost', render: (value: string | undefined) => value || '等待管理员配置' },
    {
      title: '状态', dataIndex: 'state', key: 'state',
      render: (value: ProxySubscriptionState, entry) => (
        <Space size={4}>
          <Tag color={subscriptionStateColor[value]}>{subscriptionStateLabel[value]}</Tag>
          {entry.error && <Tooltip title={entry.error}><Tag color="orange">详情</Tag></Tooltip>}
        </Space>
      ),
    },
    {
      title: '节点', key: 'nodes',
      render: (_value, entry) => `${entry.supportedNodeCount}/${entry.nodeCount}${entry.unsupportedNodeCount ? `，忽略 ${entry.unsupportedNodeCount}` : ''}`,
    },
    {
      title: '操作', key: 'actions', width: 180,
      render: (_value, entry) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={Boolean(refreshingSubscriptions[entry.id])}
            disabled={Boolean(refreshingSubscriptions[entry.id]) || entry.state === 'not_configured'}
            onClick={() => void handleSubscriptionRefresh(entry)}
          >
            刷新
          </Button>
          {entry.isBuiltin ? (
            <Tooltip title="平台共享订阅由管理员统一配置，不能删除">
              <Button size="small" disabled icon={<SafetyCertificateOutlined />} />
            </Tooltip>
          ) : (
            <Popconfirm title="删除订阅及其节点？" onConfirm={() => void deleteSubscription(entry.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const handleCkFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const items: DolaCkImportItem[] = [];
    let parseFailures = 0;
    for (const file of files) {
      try {
        const fileLabel = file.name.replace(/\.json$/i, '');
        const entries = splitDolaCkJsonEntries(JSON.parse(await file.text()) as unknown, fileLabel);
        items.push(...entries);
      } catch {
        parseFailures += 1;
      }
    }
    await runBatch(items, '导入并检测 CK', async (item) => importDolaCk(item));
    await provisionAvailableCkAccounts();
    if (parseFailures > 0) message.warning(`${parseFailures} 个 CK JSON 文件读取失败，已跳过`);
    if (items.length > 0) message.success(`已处理 ${items.length} 个 CK JSON 文件`);
  };

  const handleCkTxtFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const items: DolaCkImportItem[] = [];
    let parseFailures = 0;
    for (const file of files) {
      try {
        const fileLabel = file.name.replace(/\.txt$/i, '');
        items.push(...splitDolaCkTxtEntries(await file.text(), fileLabel));
      } catch {
        parseFailures += 1;
      }
    }
    await runBatch(items, '导入并检测 CK TXT', async (item) => importDolaCk(item));
    await provisionAvailableCkAccounts();
    if (parseFailures > 0) message.warning(`${parseFailures} 个 CK TXT 文件读取失败，已跳过`);
    if (items.length > 0) message.success(`已拆分并处理 ${items.length} 条 CK TXT`);
  };

  const handleDoubaoCkFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const items: DoubaoCkImportItem[] = [];
    let parseFailures = 0;
    for (const file of files) {
      try {
        const fileLabel = file.name.replace(/\.json$/i, '');
        items.push(...splitDoubaoCkJsonEntries(JSON.parse(await file.text()) as unknown, fileLabel));
      } catch {
        parseFailures += 1;
      }
    }
    const before = await window.electronAPI.localManager.snapshot();
    if (!before.success || !before.data) {
      message.error(before.error || '读取豆包 CK 列表失败，已停止导入');
      return;
    }
    const existingIds = new Set(before.data.doubao.map((entry) => entry.id));
    await runBatch(items, '导入并检测豆包 CK', async (item) => importDoubaoCk(item));
    const after = await window.electronAPI.localManager.snapshot();
    if (!after.success || !after.data) {
      message.error(after.error || '豆包 CK 已导入，但读取绑定状态失败，请重新打开豆包登录页');
      return;
    }
    const importedIds = after.data.doubao.filter((entry) => !existingIds.has(entry.id)).map((entry) => entry.id);
    const provision = await provisionAvailableDoubaoCkAccounts(importedIds);
    if (parseFailures > 0) message.warning(`${parseFailures} 个豆包 CK JSON 文件读取失败，已跳过`);
    if (importedIds.length > 0) {
      const readyCount = provision.linkedCount + provision.alreadyLinkedCount;
      if (provision.failedCount === 0 && readyCount === importedIds.length) {
        message.success(`成功导入 ${importedIds.length} 条豆包 CK，已自动创建并绑定 ${readyCount} 个豆包窗口`);
      } else {
        message.warning(`已导入 ${importedIds.length} 条豆包 CK，绑定 ${readyCount} 个窗口，失败 ${provision.failedCount} 条`);
      }
    } else if (items.length > 0) {
      message.warning('豆包 CK 未成功导入，请查看检测提示');
    }
  };

  const handleDoubaoCkTxtFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const items: DoubaoCkImportItem[] = [];
    let parseFailures = 0;
    for (const file of files) {
      try {
        const fileLabel = file.name.replace(/\.txt$/i, '');
        items.push(...splitDoubaoCkTxtEntries(await file.text(), fileLabel));
      } catch {
        parseFailures += 1;
      }
    }
    const before = await window.electronAPI.localManager.snapshot();
    if (!before.success || !before.data) {
      message.error(before.error || '读取豆包 CK 列表失败，已停止导入');
      return;
    }
    const existingIds = new Set(before.data.doubao.map((entry) => entry.id));
    await runBatch(items, '导入并检测豆包 CK TXT', async (item) => importDoubaoCk(item));
    const after = await window.electronAPI.localManager.snapshot();
    if (!after.success || !after.data) {
      message.error(after.error || '豆包 CK 已导入，但读取绑定状态失败，请重新打开豆包登录页');
      return;
    }
    const importedIds = after.data.doubao.filter((entry) => !existingIds.has(entry.id)).map((entry) => entry.id);
    const provision = await provisionAvailableDoubaoCkAccounts(importedIds);
    if (parseFailures > 0) message.warning(`${parseFailures} 个豆包 CK TXT 文件读取失败，已跳过`);
    if (importedIds.length > 0) {
      const readyCount = provision.linkedCount + provision.alreadyLinkedCount;
      if (provision.failedCount === 0 && readyCount === importedIds.length) {
        message.success(`成功导入 ${importedIds.length} 条豆包 CK TXT，已自动创建并绑定 ${readyCount} 个豆包窗口`);
      } else {
        message.warning(`已导入 ${importedIds.length} 条豆包 CK TXT，绑定 ${readyCount} 个窗口，失败 ${provision.failedCount} 条`);
      }
    } else if (items.length > 0) {
      message.warning('豆包 CK TXT 未成功导入，请查看检测提示');
    }
  };

  const handleProxyAdd = async (): Promise<void> => {
    if (!proxyHost.trim() || !proxyPort) {
      message.warning('请填写代理协议、地址和端口');
      return;
    }
    if (addingProxy) return;
    setAddingProxy(true);
    try {
      const ok = await addProxy({
        label: proxyLabel || undefined,
        protocol: proxyProtocol,
        host: proxyHost,
        port: proxyPort,
        username: proxyUsername || undefined,
        password: proxyPassword || undefined,
      });
      if (ok) {
        setProxyLabel('');
        setProxyProtocol('http');
        setProxyHost('');
        setProxyPort(null);
        setProxyUsername('');
        setProxyPassword('');
        message.success('代理已保存并通过连通性测试');
      }
    } finally {
      setAddingProxy(false);
    }
  };

  const handleSubscriptionAdd = async (): Promise<void> => {
    if (!subscriptionUrl.trim()) {
      message.warning('请填写机场订阅链接');
      return;
    }
    if (addingSubscription) return;
    setAddingSubscription(true);
    try {
      const ok = await addSubscription({ label: subscriptionLabel || undefined, url: subscriptionUrl });
      if (ok) {
        setSubscriptionLabel('');
        setSubscriptionUrl('');
        message.success('订阅已添加并完成节点刷新');
      }
    } finally {
      setAddingSubscription(false);
    }
  };

  const handleSubscriptionRefresh = async (entry: ProxySubscriptionEntry): Promise<void> => {
    if (refreshingSubscriptions[entry.id]) return;
    setRefreshingSubscriptions((current) => ({ ...current, [entry.id]: true }));
    try {
      const ok = await refreshSubscription(entry.id);
      if (ok) message.success(`${entry.label} 已刷新`);
    } finally {
      setRefreshingSubscriptions((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
    }
  };

  const handleBind = async (): Promise<void> => {
    if (bindingBusy) return;
    if (!bindingAccount) {
      message.warning('请选择要绑定的窗口');
      return;
    }
    setBindingBusy(true);
    try {
      if (await bind(bindingAccount, bindingProxy)) message.success(bindingProxy ? 'IP 已绑定，窗口已刷新' : '已切换为直连');
    } finally {
      setBindingBusy(false);
    }
  };

  const handleRandomAssign = async (): Promise<void> => {
    if (bindingBusy) return;
    const accountIds = bindingAccounts.map((account) => account.id);
    if (accountIds.length === 0) {
      message.warning(`当前没有${bindingPlatformLabel}窗口`);
      return;
    }
    setBindingBusy(true);
    try {
      if (await randomAssign(accountIds, perProxyLimit)) message.success(`已为${bindingPlatformLabel}窗口分配 IP`);
    } finally {
      setBindingBusy(false);
    }
  };

  const managerTabs = [
          {
            key: 'dola',
            label: 'Dola 账号池',
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  message="Dola CK 登录说明"
                  description="导入 CK JSON 或每行一套 Cookie 的 CK TXT 后，会自动校验并关联可用会话；掉线或需要刷新会话时，可点击单个「重登」，也可点击「批量重登已关联 CK」统一恢复登录。"
                />
                <Space wrap>
                  <Button icon={<UploadOutlined />} loading={batchRunning} disabled={batchRunning} onClick={() => fileInputRef.current?.click()}>批量导入 CK JSON</Button>
                  <input ref={fileInputRef} type="file" accept="application/json,.json" multiple hidden onChange={(event) => void handleCkFile(event)} />
                  <Button icon={<FileTextOutlined />} loading={batchRunning} disabled={batchRunning} onClick={() => txtFileInputRef.current?.click()}>批量导入 CK TXT</Button>
                  <input ref={txtFileInputRef} type="file" accept="text/plain,.txt" multiple hidden onChange={(event) => void handleCkTxtFile(event)} />
                  <Button icon={<ReloadOutlined />} loading={retestingDola} disabled={retestingDola || batchRunning} onClick={() => void handleRetestDola()}>一键重测全部 CK</Button>
                  <Button icon={<ReloadOutlined />} loading={batchRunning} disabled={batchRunning} onClick={() => void handleReloginAll()}>批量重登已关联 CK</Button>
                  <Popconfirm title="清空全部 Dola 池条目？" onConfirm={() => void clearDola()}>
                    <Button danger icon={<DeleteOutlined />}>批量清空</Button>
                  </Popconfirm>
                </Space>
                <Space>
                  <span>并发数</span>
                  <InputNumber min={1} max={20} value={snapshot.concurrency} onChange={(value) => value && void setConcurrency(value)} />
                  <span style={{ color: '#888' }}>并发数用于控制批量重登同时处理的 CK 数量；导入 CK JSON/TXT 后会自动检测并关联可用 Dola 会话</span>
                </Space>
                {batchProgress && (
                  <Progress
                    percent={batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : 0}
                    status={batchProgress.failed > 0 ? 'exception' : batchProgress.completed >= batchProgress.total ? 'success' : 'active'}
                    format={() => `${batchProgress.label} ${batchProgress.completed}/${batchProgress.total}${batchProgress.failed ? `，失败 ${batchProgress.failed}` : ''}`}
                  />
                )}
                <Table<DolaPoolEntry> rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={dolaColumns} dataSource={snapshot.dola} />
              </Space>
            ),
          },
          {
            key: 'doubao',
            label: '豆包账号池',
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  message="豆包 CK 登录说明"
                  description="导入豆包 CK JSON 或 TXT（TXT 内含 JSON 也支持）后会自动拆分、检测并关联豆包会话；掉线时可单条重登或批量重登。豆包请求始终本地直连。"
                />
                <Space wrap>
                  <Button icon={<UploadOutlined />} loading={batchRunning} disabled={batchRunning} onClick={() => doubaoFileInputRef.current?.click()}>批量导入豆包 CK JSON</Button>
                  <input ref={doubaoFileInputRef} type="file" accept="application/json,.json" multiple hidden onChange={(event) => void handleDoubaoCkFile(event)} />
                  <Button icon={<FileTextOutlined />} loading={batchRunning} disabled={batchRunning} onClick={() => doubaoTxtFileInputRef.current?.click()}>批量导入豆包 CK TXT</Button>
                  <input ref={doubaoTxtFileInputRef} type="file" accept="text/plain,.txt,application/json" multiple hidden onChange={(event) => void handleDoubaoCkTxtFile(event)} />
                  <Button icon={<ReloadOutlined />} loading={retestingDoubao} disabled={retestingDoubao || batchRunning} onClick={() => void handleRetestDoubao()}>一键重测全部豆包 CK</Button>
                  <Button icon={<ReloadOutlined />} loading={batchRunning} disabled={batchRunning} onClick={() => void handleReloginAllDoubao()}>批量重登豆包 CK</Button>
                  <Popconfirm title="清空全部豆包 CK 条目？" onConfirm={() => void clearDoubao()}>
                    <Button danger icon={<DeleteOutlined />}>批量清空</Button>
                  </Popconfirm>
                </Space>
                {batchProgress && (
                  <Progress
                    percent={batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : 0}
                    status={batchProgress.failed > 0 ? 'exception' : batchProgress.completed >= batchProgress.total ? 'success' : 'active'}
                    format={() => `${batchProgress.label} ${batchProgress.completed}/${batchProgress.total}${batchProgress.failed ? `，失败 ${batchProgress.failed}` : ''}`}
                  />
                )}
                <Table<DoubaoPoolEntry> rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={doubaoColumns} dataSource={snapshot.doubao} />
              </Space>
            ),
          },
          {
            key: 'airport',
            label: '机场代理',
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  message="机场订阅"
                  description="不需要另外安装 Clash。HTTP、HTTPS、SOCKS5 直接使用，SS、VMess、VLESS、Trojan、Hysteria2、AnyTLS 等节点由内置网络核心转换。平台共享订阅由管理员配置并始终保留一条。"
                />
                <Space wrap>
                  <Input placeholder="订阅备注（可选）" value={subscriptionLabel} onChange={(event) => setSubscriptionLabel(event.target.value)} style={{ width: 160 }} />
                  <Input placeholder="https://... 机场订阅链接" value={subscriptionUrl} onChange={(event) => setSubscriptionUrl(event.target.value)} style={{ width: 330 }} />
                  <Button type="primary" icon={<CloudDownloadOutlined />} loading={addingSubscription} disabled={addingSubscription} onClick={() => void handleSubscriptionAdd()}>添加并刷新订阅</Button>
                </Space>
                <Table<ProxySubscriptionEntry> rowKey="id" size="small" pagination={{ pageSize: 5 }} columns={subscriptionColumns} dataSource={snapshot.subscriptions || []} />
                {snapshot.proxies.some((proxy) => Boolean(proxy.subscriptionId)) && (
                  <>
                    <div style={{ fontWeight: 600 }}>订阅节点</div>
                    <Table<ProxyPoolEntry>
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 8 }}
                      columns={proxyColumns}
                      dataSource={snapshot.proxies.filter((proxy) => Boolean(proxy.subscriptionId))}
                    />
                  </>
                )}
              </Space>
            ),
          },
          {
            key: 'residential',
            label: '住宅代理',
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  message="手动住宅代理"
                  description="这里管理手动填写的 HTTP、HTTPS、SOCKS5 住宅代理；平台共享 IP 作为系统预置条目保留，不能删除。"
                />
                <Space wrap>
                  <Input placeholder="备注" value={proxyLabel} onChange={(event) => setProxyLabel(event.target.value)} style={{ width: 130 }} />
                  <Select<AccountProxyProtocol>
                    value={proxyProtocol}
                    onChange={setProxyProtocol}
                    options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }, { value: 'socks5', label: 'SOCKS5' }]}
                    style={{ width: 105 }}
                  />
                  <Input placeholder="主机/IP" value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} style={{ width: 170 }} />
                  <InputNumber placeholder="端口" value={proxyPort} onChange={setProxyPort} min={1} max={65535} />
                  <Input placeholder="用户名（可选）" value={proxyUsername} onChange={(event) => setProxyUsername(event.target.value)} style={{ width: 135 }} />
                  <Input.Password placeholder="密码（可选）" value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} style={{ width: 135 }} />
                  <Button type="primary" icon={<SafetyCertificateOutlined />} loading={addingProxy} disabled={addingProxy} onClick={() => void handleProxyAdd()}>测试并保存</Button>
                  <Button icon={<ReloadOutlined />} loading={retestingProxy} disabled={retestingProxy || addingProxy} onClick={() => void handleRetestProxy()}>一键重测全部代理</Button>
                </Space>
                <Table<ProxyPoolEntry> rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={proxyColumns} dataSource={snapshot.proxies.filter((proxy) => !proxy.subscriptionId)} />
              </Space>
            ),
          },
          {
            key: 'binding',
            label: '窗口绑定',
            children: (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <Alert type="info" showIcon message="豆包和 Dola 均可单独绑定 IP；未绑定时使用本机网络。每个 IP 最多绑定 10 个窗口，保存后会刷新对应窗口。" />
                <Space wrap>
                  <label htmlFor="binding-platform">平台</label>
                  <Select<AccountPlatform> id="binding-platform" value={bindingPlatform} disabled={bindingBusy} onChange={(value) => {
                    setBindingPlatform(value);
                    setBindingAccount(undefined);
                    setBindingProxy(null);
                  }} options={[{ value: 'doubao', label: '豆包' }, { value: 'dola', label: 'Dola' }]} />
                  <label htmlFor="binding-window">窗口</label>
                  <Select id="binding-window" placeholder="选择窗口" value={bindingAccount} disabled={bindingBusy} onChange={(value: string) => {
                    setBindingAccount(value);
                    setBindingProxy(snapshot.bindings.find((binding) => binding.accountId === value)?.proxyId || null);
                  }} options={bindingAccounts.map((account) => ({ value: account.id, label: account.name }))} style={{ width: 190 }} />
                  <label htmlFor="binding-proxy">代理 IP</label>
                  <Select id="binding-proxy" placeholder="留空为直连" allowClear value={bindingProxy || undefined} disabled={bindingBusy} onChange={(value) => setBindingProxy(value || null)} options={proxyOptions} style={{ width: 260 }} />
                  <Button type="primary" icon={<LinkOutlined />} loading={bindingBusy} disabled={!bindingAccount} onClick={() => void handleBind()}>保存绑定</Button>
                </Space>
                <Space wrap>
                  <label htmlFor="binding-limit">每个 IP 的窗口上限</label>
                  <InputNumber id="binding-limit" min={1} max={10} value={perProxyLimit} disabled={bindingBusy} onChange={(value) => setPerProxyLimit(value || 1)} />
                  <Button icon={<ThunderboltOutlined />} disabled={bindingBusy || bindingAccounts.length === 0} onClick={() => void handleRandomAssign()}>随机分配全部{bindingPlatformLabel}</Button>
                </Space>
                <Space>
                  <span>未绑定 Dola 路由</span>
                  <Select<LocalRoutingMode>
                    value={snapshot.routingMode}
                    onChange={(value) => void setRoutingMode(value)}
                    options={[{ value: 'legacy_global', label: '沿用旧全局代理' }, { value: 'bound_only', label: '未绑定时直连' }]}
                    style={{ width: 190 }}
                  />
                </Space>
                <Table
                  rowKey="accountId"
                  size="small"
                  pagination={false}
                  dataSource={snapshot.bindings}
                  columns={[
                    {
                      title: '窗口名称',
                      dataIndex: 'accountId',
                      key: 'accountId',
                      render: (value: string) => accounts.find((account) => account.id === value)?.name || '未命名窗口',
                    },
                    { title: '平台', dataIndex: 'platform', key: 'platform', render: (value: AccountPlatform) => value === 'dola' ? 'Dola' : '豆包' },
                    { title: '代理 IP', dataIndex: 'proxyId', key: 'proxyId', render: (value: string | null) => value ? snapshot.proxies.find((proxy) => proxy.id === value)?.label || '代理已移除' : '直连' },
                    { title: '操作', key: 'action', render: (_value: unknown, row: { accountId: string }) => <Button size="small" onClick={() => void unbind(row.accountId)}>解绑</Button> },
                  ]}
                />
              </Space>
            ),
          },
        ];
  const visibleTabs = view === 'routing' ? managerTabs.slice(2) : managerTabs;
  const body = (
    <>
      {error && <Alert type="error" showIcon closable onClose={clearError} message={error} style={{ marginBottom: 12 }} />}
      {view === 'dola'
        ? managerTabs[0].children
        : view === 'doubao'
          ? managerTabs[1].children
          : <Tabs items={visibleTabs} />}
    </>
  );

  if (embedded) {
    const isDolaView = view === 'dola';
    const isDoubaoView = view === 'doubao';
    const pageLabel = isDolaView ? 'Dola 登录' : isDoubaoView ? '豆包登录' : '代理与窗口绑定';
    const pageKicker = isDolaView ? 'DOLA ACCOUNT / SESSION' : isDoubaoView ? 'DOUBAO ACCOUNT / SESSION' : 'LOCAL CONTROL / ROUTING';
    const pageDescription = isDolaView
      ? '批量导入 CK、检测状态并管理 Dola 会话。'
      : isDoubaoView
        ? '批量导入豆包 CK、检测状态并管理豆包会话。'
        : '管理代理 IP，为豆包和 Dola 窗口分别绑定网络出口。';
    return (
      <section className={`workspace-full-page workspace-manager-page ${isDolaView ? 'workspace-dola-login-page' : ''}`} aria-label={pageLabel}>
        <header className="workspace-page-header">
          <div>
            <div className="workspace-page-kicker">{pageKicker}</div>
            <h1>{pageLabel}</h1>
            <p>{pageDescription}</p>
          </div>
          <Button onClick={() => { clearError(); onClose(); }}>返回工作台</Button>
        </header>
        <div className="workspace-page-surface dashboard-glass">{body}</div>
      </section>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={() => { clearError(); onClose(); }}
      title="本地管理器"
      width={1080}
      footer={null}
      destroyOnClose={false}
    >
      {body}
    </Modal>
  );
};
