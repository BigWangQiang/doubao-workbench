import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  Empty,
  Input,
  Popconfirm,
  Space,
  Spin,
  Statistic,
  Tag,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  LinkOutlined,
  LockOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ShoppingCartOutlined,
  UserOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import type { LalorCatalogProduct } from '@doubao-studio/contracts';
import { useLalorStore } from '../store/useLalorStore';
import { resolveLalorAvatarUrl } from '../utils/lalorAvatar';

interface LalorAccountPanelProps {
  onClose: () => void;
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false });
}

function createIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `desktop-${uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function productIcon(product: LalorCatalogProduct): React.ReactNode {
  if (product.icon.toLowerCase().includes('video')) return <ShoppingCartOutlined />;
  return <SafetyCertificateOutlined />;
}

function productPlatformLabel(productType: string): string {
  return productType === 'doubao_account' ? '豆包' : 'Dola';
}

export const LalorAccountPanel: React.FC<LalorAccountPanelProps> = ({ onClose }) => {
  const status = useLalorStore((state) => state.status);
  const catalog = useLalorStore((state) => state.catalog);
  const loading = useLalorStore((state) => state.loading);
  const pairing = useLalorStore((state) => state.pairing);
  const purchasing = useLalorStore((state) => state.purchasing);
  const error = useLalorStore((state) => state.error);
  const load = useLalorStore((state) => state.load);
  const pair = useLalorStore((state) => state.pair);
  const refresh = useLalorStore((state) => state.refresh);
  const purchase = useLalorStore((state) => state.purchase);
  const logout = useLalorStore((state) => state.logout);
  const clearError = useLalorStore((state) => state.clearError);
  const [pairingCode, setPairingCode] = useState('');
  const [purchasingProductId, setPurchasingProductId] = useState<string | null>(null);
  // 网络超时后重试必须复用同一个幂等键，避免服务端已扣积分但客户端未收到响应时重复购买。
  const purchaseKeysRef = useRef<Record<string, string>>({});

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error]);

  const products = useMemo(
    () => (catalog?.products || []).filter((product) => (product.productType === 'dola_account' || product.productType === 'doubao_account') && product.enabled),
    [catalog],
  );
  const membershipActive = status.profile?.membership?.active === true;
  const avatarSrc = resolveLalorAvatarUrl(status.profile?.avatarUrl);

  const handlePair = async (): Promise<void> => {
    if (await pair(pairingCode)) {
      setPairingCode('');
      message.success('Lalor 会员已连接');
    }
  };

  const handlePurchase = async (product: LalorCatalogProduct): Promise<void> => {
    setPurchasingProductId(product.id);
    try {
      const idempotencyKey = purchaseKeysRef.current[product.id] || createIdempotencyKey();
      purchaseKeysRef.current[product.id] = idempotencyKey;
      const result = await purchase(product.id, idempotencyKey);
      if (!result) return;
      delete purchaseKeysRef.current[product.id];
      if (result.alreadyImported) {
        message.info(`${result.productName} 已经导入本地 Dola 账号池`);
      } else {
        message.success(`购买成功，已导入 ${result.importedCount} 个 Dola CK`);
      }
    } finally {
      setPurchasingProductId(null);
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (await logout()) message.success('已退出 Lalor 会员连接');
  };

  return (
    <section className="workspace-full-page workspace-lalor-page" aria-label="Lalor 会员与账号购买">
      <header className="workspace-page-header">
        <div>
          <div className="workspace-page-kicker">LALOR MEMBER / ACCOUNT STORE</div>
          <h1>Lalor 账号中心</h1>
          <p>同步会员资料与积分，并使用积分购买 Dola 账号。会员资格由 Lalor 服务端统一校验。</p>
        </div>
        <Space wrap>
          {status.connected && <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新资料</Button>}
          {status.connected && <Button icon={<LogoutOutlined />} loading={loading} onClick={() => void handleLogout()}>退出连接</Button>}
          <Button onClick={onClose}>返回工作台</Button>
        </Space>
      </header>

      <div className="workspace-page-surface dashboard-glass">
        {error && <div className="dashboard-notice" role="alert"><span><LockOutlined /> {error}</span><Button type="link" onClick={clearError}>关闭</Button></div>}

        {!status.connected ? (
          <div className="dashboard-grid dashboard-grid-top">
            <article className="dashboard-panel dashboard-glass">
              <div className="dashboard-panel-head">
                <div><h2>连接 Lalor 会员账号</h2><p>配对码只在 Lalor 网站显示一次，10 分钟内有效。</p></div>
                <LinkOutlined className="dashboard-panel-icon" />
              </div>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Input
                  size="large"
                  maxLength={32}
                  value={pairingCode}
                  placeholder="输入 Lalor 网站生成的配对码，例如 ABCD-2345"
                  onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
                  onPressEnter={() => void handlePair()}
                />
                <Button type="primary" size="large" icon={<LinkOutlined />} loading={pairing} disabled={!pairingCode.trim()} onClick={() => void handlePair()}>
                  连接 Lalor
                </Button>
              </Space>
            </article>
            <article className="dashboard-panel dashboard-glass">
              <div className="dashboard-panel-head"><div><h2>如何获取配对码</h2><p>配对成功后，本地管理器不会保存网页 Cookie。</p></div><SafetyCertificateOutlined className="dashboard-panel-icon" /></div>
              <ol className="lalor-pairing-steps">
                <li><b>01</b><span>登录 Lalor 网站并打开“连接 Lalor 工作台”</span></li>
                <li><b>02</b><span>生成一次性配对码并复制</span></li>
                <li><b>03</b><span>粘贴到这里，完成会员资料同步</span></li>
              </ol>
            </article>
          </div>
        ) : (
          <>
            <section className="dashboard-command dashboard-glass" aria-label="Lalor 会员资料">
              <Space size={16} align="center" wrap>
                <Avatar size={58} src={avatarSrc} icon={<UserOutlined />}>
                  {status.profile?.displayName?.slice(0, 1)}
                </Avatar>
                <div>
                  <div className="dashboard-eyebrow">CONNECTED MEMBER</div>
                  <h2>{status.profile?.displayName || status.profile?.username || 'Lalor 会员'}</h2>
                  <p>{status.profile?.username || '—'} · 连接有效期至 {formatDate(status.refreshExpiresAt)}</p>
                </div>
                {status.profile?.membership?.active ? <Tag color="success" icon={<CheckCircleOutlined />}>有效会员 · {status.profile.membership.tierLabel || status.profile.membership.tier}</Tag> : <Tag color="error">会员资格需确认</Tag>}
              </Space>
              <div className="dashboard-actions">
                <Statistic title="可用积分" value={status.profile?.availablePoints ?? catalog?.availablePoints ?? 0} prefix={<WalletOutlined />} />
              </div>
            </section>

            <div className="dashboard-panel-head" style={{ marginTop: 18 }}>
              <div><h2>Dola / 豆包账号商品</h2><p>购买成功后，CK 会在主进程安全解析并自动写入对应账号池。</p></div>
              <Tag color="processing">仅限有效会员</Tag>
            </div>

            {loading && !catalog ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spin tip="正在读取商品目录" /></div>
            ) : products.length === 0 ? (
              <Empty description="暂无可购买的 Dola 账号商品" />
            ) : (
              <div className="dashboard-grid dashboard-grid-top">
                {products.map((product) => {
                  const points = status.profile?.availablePoints ?? catalog?.availablePoints ?? 0;
                  const canBuy = membershipActive && product.stock > 0 && points >= product.points;
                  return (
                    <article className="dashboard-panel dashboard-glass" key={product.id}>
                      <div className="dashboard-panel-head">
                        <div><h2>{product.name}</h2><p>{product.description || `${productPlatformLabel(product.productType)} 账号，购买后自动导入本地账号池。`}</p></div>
                        <span className="dashboard-task-icon image">{productIcon(product)}</span>
                      </div>
                      <div className="dashboard-overview-columns">
                        <div className="dashboard-overview-stat"><span>积分</span><strong>{product.points}</strong><small>每个账号</small></div>
                        <div className="dashboard-overview-stat"><span>库存</span><strong>{product.stock}</strong><small>{product.stock > 0 ? '可购买' : '暂时缺货'}</small></div>
                        <div className="dashboard-overview-stat"><span>你的余额</span><strong>{points}</strong><small>当前可用积分</small></div>
                      </div>
                      <Popconfirm
                        title={`确认购买${productPlatformLabel(product.productType)}账号？`}
                        description={`将消耗 ${product.points} 积分，购买后自动导入${productPlatformLabel(product.productType)}本地账号池。`}
                        okText="确认购买"
                        cancelText="取消"
                        disabled={!canBuy || purchasing}
                        onConfirm={() => void handlePurchase(product)}
                      >
                        <Button
                          block
                          type="primary"
                          icon={<ShoppingCartOutlined />}
                          loading={purchasing && purchasingProductId === product.id}
                          disabled={!canBuy || purchasing}
                          style={{ marginTop: 18 }}
                        >
                          {!membershipActive ? '仅限有效会员' : product.stock <= 0 ? '暂时缺货' : points < product.points ? '积分不足' : `积分购买并导入${productPlatformLabel(product.productType)} CK`}
                        </Button>
                      </Popconfirm>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
