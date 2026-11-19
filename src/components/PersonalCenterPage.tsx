import React, { useEffect, useMemo, useState } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Modal,
  QRCode,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DollarOutlined,
  DeleteOutlined,
  HistoryOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ShoppingOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import type { LalorCatalogProduct, LalorOrder, LalorOrderPage, LalorPaymentOrder, LalorPurchaseResult } from '@doubao-studio/contracts';
import { useLalorAuthStore } from '../store/useLalorAuthStore';
import { useAccountStore } from '../store/useAccountStore';
import { useLocalManagerStore } from '../store/useLocalManagerStore';

function formatMoney(amountFen: number): string {
  return `¥${(Math.max(0, amountFen) / 100).toFixed(2)}`;
}

function formatDate(value?: string): string {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
}

function orderStatusLabel(status?: string): string {
  if (status === 'paid') return '支付成功';
  if (status === 'closed' || status === 'failed') return '订单已关闭';
  return '等待支付';
}

function orderStatusColor(status?: string): string {
  if (status === 'paid') return 'success';
  if (status === 'failed' || status === 'closed') return 'error';
  return 'processing';
}

function orderMethodLabel(method?: string): string {
  return method === 'cash' ? '现金购买' : method === 'points' ? '积分兑换' : method || '购买';
}

interface DeliveryActionsProps {
  purchase: LalorPurchaseResult;
  onComplete?: () => void;
}

const DeliveryActions: React.FC<DeliveryActionsProps> = ({ purchase, onComplete }) => {
  const { message, modal } = App.useApp();
  const saveDelivery = useLalorAuthStore((state) => state.saveDelivery);
  const importDelivery = useLalorAuthStore((state) => state.importDelivery);
  const [working, setWorking] = useState<'save' | 'import' | null>(null);
  const delivery = purchase.delivery;
  if (!delivery) return null;
  const isResidentialProxy = delivery.productType === 'residential_proxy';
  const isDoubao = delivery.productType === 'doubao_account';
  const accountLabel = isDoubao ? '豆包' : 'Dola';

  const save = async (): Promise<void> => {
    setWorking('save');
    const result = await saveDelivery(delivery.deliveryRef);
    setWorking(null);
    if (result?.saved) {
      message.success(isResidentialProxy ? '代理 JSON 已保存' : `${accountLabel} CK 文件已保存`);
      onComplete?.();
    }
  };

  const importNow = async (): Promise<void> => {
    setWorking('import');
    let showCompletion: (() => void) | null = null;
    try {
      const result = await importDelivery(delivery.deliveryRef);
      if (!result?.imported) {
        message.error(useLalorAuthStore.getState().error || '交付内容导入未完成，请重试');
        return;
      }
      const localManager = useLocalManagerStore.getState();
      if (result.deliveryKind === 'residential_proxy') {
        void localManager.load();
        const available = result.proxyState === 'valid';
        showCompletion = () => {
          const config = {
            title: available ? '静态住宅 IP 导入成功' : '静态住宅 IP 已导入，检测未通过',
            content: (
              <div className="lalor-import-result">
                <p>已加入代理池：1 条</p>
                <p>连通状态：{available ? '可用' : '暂不可用'}</p>
                {!available && result.proxyError ? <p>检测说明：{result.proxyError}</p> : null}
              </div>
            ),
            centered: true,
            okText: '完成',
          };
          if (available) modal.success(config); else modal.warning(config);
        };
      } else {
        const provision = isDoubao
          ? await localManager.provisionAvailableDoubaoCk(result.importedEntryIds)
          : await localManager.provisionAvailableDolaCk(result.importedEntryIds);
        const importedCount = result.importedCount || 1;
        const readyCount = provision.linkedCount + provision.alreadyLinkedCount;
        showCompletion = () => modal.success({
          title: `${accountLabel} CK 导入完成`,
          content: (
            <div className="lalor-import-result">
              <p>导入数量：{importedCount}</p>
              <p>可用数量：{provision.validCount}</p>
              <p>绑定窗口：{readyCount}</p>
              <p>新建窗口：{provision.createdCount}</p>
              {provision.unavailableCount > 0 || provision.failedCount > 0 ? <p>其余条目请到 {accountLabel} 登录页查看检测状态。</p> : null}
            </div>
          ),
          centered: true,
          okText: '完成',
        });
        // 成功回执以持久化的检测与绑定结果为准；列表刷新放到后台，避免 UI 无限等待。
        void useAccountStore.getState().loadAccounts();
        void localManager.load();
      }
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '交付内容导入失败');
    } finally {
      setWorking(null);
    }
    if (showCompletion) {
      // 先挂载结果弹窗，再关闭交付选择层，避免父 Modal 卸载时吞掉成功回执。
      window.setTimeout(() => {
        showCompletion?.();
        onComplete?.();
      }, 0);
    }
  };

  return (
    <div className="lalor-delivery-actions" aria-live="polite">
      <div className="lalor-delivery-meta">
        <CheckCircleOutlined aria-hidden="true" />
        <span>{isResidentialProxy ? '已收到静态住宅 IP 配置' : `已收到有效 ${accountLabel} CK`}: {delivery.fileName || `${delivery.productName}.${delivery.contentType === 'txt' ? 'txt' : 'json'}`}</span>
      </div>
      <Space className="lalor-delivery-buttons" wrap>
        <Button icon={<CloudDownloadOutlined />} loading={working === 'save'} disabled={working !== null} onClick={() => void save()}>
          {isResidentialProxy ? '下载代理 JSON' : `下载${accountLabel} CK 文件`}
        </Button>
        <Button type="primary" icon={<CheckCircleOutlined />} loading={working === 'import'} disabled={working !== null} onClick={() => void importNow()}>
          {isResidentialProxy ? '一键导入代理池' : `一键导入${accountLabel} CK`}
        </Button>
      </Space>
    </div>
  );
};

interface CashOrderPanelProps {
  purchase: LalorPurchaseResult;
  onRefresh: () => void;
  refreshing: boolean;
}

const CashOrderPanel: React.FC<CashOrderPanelProps> = ({ purchase, onRefresh, refreshing }) => {
  const { message } = App.useApp();
  const order: LalorPaymentOrder | undefined = purchase.order;
  if (!order) return null;
  const qrCodeValue = order.qrCodeUrl?.trim() || '';
  const paymentPageUrl = order.paymentUrl?.trim() || '';
  const paymentTarget = qrCodeValue || paymentPageUrl;

  const copyPaymentTarget = async (): Promise<void> => {
    if (!paymentTarget) return;
    try {
      await navigator.clipboard.writeText(paymentTarget);
      message.success(order.provider === 'wechat' ? '微信支付码已复制' : '支付链接已复制');
    } catch {
      message.error('复制失败，请手动选择支付信息');
    }
  };

  return (
    <Card className="lalor-payment-card" size="small" title={<span><DollarOutlined aria-hidden="true" /> 现金订单</span>}>
      <div className="lalor-payment-status-row">
        <Tag color={order.status === 'paid' ? 'success' : order.status === 'pending' ? 'processing' : 'default'}>{orderStatusLabel(order.status)}</Tag>
        <Typography.Text type="secondary">订单 {order.id.slice(0, 12)}</Typography.Text>
        <Typography.Text type="secondary">金额 {formatMoney(order.amountFen)}</Typography.Text>
      </div>
      {order.status === 'pending' && (
        <div className="lalor-payment-instructions">
          <Typography.Text>请在有效期内完成支付；支付完成后可点击“刷新订单”，系统会自动展示 CK 交付。</Typography.Text>
          {qrCodeValue ? (
            <div className="lalor-payment-qr">
              <QRCode
                type="svg"
                value={qrCodeValue}
                size={216}
                bordered={false}
                bgColor="#ffffff"
                color="#111111"
                status="active"
                aria-label={order.provider === 'wechat' ? '微信支付二维码' : '支付宝支付二维码'}
              />
              <strong>{order.provider === 'wechat' ? '请使用微信扫码支付' : '请使用支付宝扫码支付'}</strong>
              <span>支付成功后，订单状态与 CK 交付会自动更新</span>
            </div>
          ) : paymentPageUrl ? (
            <div className="lalor-payment-page-entry">
              <DollarOutlined aria-hidden="true" />
              <strong>请前往支付宝收银台完成支付</strong>
              <Button type="primary" onClick={() => window.open(paymentPageUrl, '_blank')}>打开支付页</Button>
            </div>
          ) : (
            <div className="lalor-payment-qr-loading"><Spin /> 正在获取支付二维码</div>
          )}
          {paymentTarget && (
            <div className="lalor-payment-target">
              <Typography.Text className="lalor-payment-target-value" code ellipsis={{ tooltip: paymentTarget }}>{paymentTarget}</Typography.Text>
              <Space className="lalor-payment-target-actions" wrap>
                <Button icon={<CopyOutlined />} onClick={() => void copyPaymentTarget()}>复制支付信息</Button>
                {paymentPageUrl && <Button type="link" onClick={() => window.open(paymentPageUrl, '_blank')}>打开支付页</Button>}
              </Space>
            </div>
          )}
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>刷新订单状态</Button>
        </div>
      )}
      {order.status !== 'pending' && <Typography.Text type="secondary">支付时间：{formatDate(order.paidAt)}</Typography.Text>}
      <DeliveryActions purchase={purchase} />
    </Card>
  );
};

interface OrderHistoryCardProps {
  orders: LalorOrderPage | null;
  loading: boolean;
  onRefresh: () => void;
}

const OrderHistoryCard: React.FC<OrderHistoryCardProps> = ({ orders, loading, onRefresh }) => {
  const { message, modal } = App.useApp();
  const rows: LalorOrder[] = orders?.orders || [];
  const [selectedOrder, setSelectedOrder] = useState<LalorOrder | null>(null);
  const [downloadingOrderId, setDownloadingOrderId] = useState<string | null>(null);
  const clearOrders = useLalorAuthStore((state) => state.clearOrders);
  const redownloadOrder = useLalorAuthStore((state) => state.redownloadOrder);

  const confirmClear = (): void => {
    modal.confirm({
      title: '一键清空购买记录？',
      content: '清空后，当前会员的购买记录将从购物中心隐藏。支付审计、库存发放记录、已下载文件以及已导入的 CK/IP 均不会删除。',
      okText: '确认清空',
      cancelText: '取消',
      okButtonProps: { danger: true },
      centered: true,
      onOk: async () => {
        const hidden = await clearOrders();
        if (hidden === null) throw new Error(useLalorAuthStore.getState().error || '购买记录清空失败');
        setSelectedOrder(null);
        message.success(hidden > 0 ? `已清空 ${hidden} 条购买记录` : '当前没有可清空的购买记录');
      },
    });
  };

  const redownload = async (order: LalorOrder): Promise<void> => {
    setDownloadingOrderId(order.id);
    const result = await redownloadOrder(order.id);
    setDownloadingOrderId(null);
    if (result?.saved) message.success('原始交付文件已重新下载');
  };
  return (
    <>
      <Card
        className="lalor-history-card dashboard-glass"
        bordered={false}
        title={<span><HistoryOutlined aria-hidden="true" /> 购买记录</span>}
        extra={<Space size={4}><Button danger type="text" icon={<DeleteOutlined />} disabled={loading || rows.length === 0} onClick={confirmClear}>一键清空</Button><Button type="text" icon={<ReloadOutlined />} loading={loading} aria-label="刷新购买记录" onClick={onRefresh} /></Space>}
      >
        {loading && !orders ? <div className="lalor-history-loading"><Spin /> 正在读取购买记录</div> : rows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有购买记录" />
        ) : (
          <div className="lalor-history-list">
            {rows.map((order) => (
              <article
                className="lalor-history-row"
                key={order.id}
                role="button"
                tabIndex={0}
                aria-label={`查看 ${order.productName || 'Dola 账号商品'} 的购买详情`}
                onClick={() => setSelectedOrder(order)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedOrder(order);
                  }
                }}
              >
                <span className="lalor-history-icon" aria-hidden="true"><ShoppingOutlined /></span>
                <div className="lalor-history-copy">
                  <strong>{order.productName || 'Dola 账号商品'}</strong>
                  <span><ClockCircleOutlined aria-hidden="true" /> {formatDate(order.createdAt)} · {orderMethodLabel(order.paymentMethod)} · 点击查看详情</span>
                </div>
                <div className="lalor-history-meta">
                  <Tag color={orderStatusColor(order.status)}>{orderStatusLabel(order.status)}</Tag>
                  <span>{order.paymentMethod === 'points' ? `${order.points} 积分` : formatMoney(order.amountFen)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
        {orders && orders.total > rows.length && <Typography.Text type="secondary" className="lalor-history-foot">显示最近 {rows.length} 条，共 {orders.total} 条记录</Typography.Text>}
      </Card>
      <Modal
        className="lalor-order-detail-modal"
        open={Boolean(selectedOrder)}
        title="购买详情"
        footer={selectedOrder ? <Space>
          {selectedOrder.status === 'paid' && selectedOrder.deliveredAt ? <Button icon={<CloudDownloadOutlined />} loading={downloadingOrderId === selectedOrder.id} onClick={() => void redownload(selectedOrder)}>重新下载原始文件</Button> : null}
          <Button type="primary" onClick={() => setSelectedOrder(null)}>知道了</Button>
        </Space> : null}
        width={560}
        centered
        destroyOnClose
        onCancel={() => setSelectedOrder(null)}
      >
        {selectedOrder && (
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="购买商品">{selectedOrder.productName || 'Dola 账号商品'}</Descriptions.Item>
            <Descriptions.Item label="订单编号"><Typography.Text copyable>{selectedOrder.id}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="购买方式">{orderMethodLabel(selectedOrder.paymentMethod)}</Descriptions.Item>
            <Descriptions.Item label="订单状态"><Tag color={orderStatusColor(selectedOrder.status)}>{orderStatusLabel(selectedOrder.status)}</Tag></Descriptions.Item>
            <Descriptions.Item label="实际消耗">{selectedOrder.paymentMethod === 'points' ? `${selectedOrder.points} 积分` : formatMoney(selectedOrder.amountFen)}</Descriptions.Item>
            <Descriptions.Item label="下单时间">{formatDate(selectedOrder.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="交付时间">{formatDate(selectedOrder.deliveredAt)}</Descriptions.Item>
            {selectedOrder.paymentOrderId && <Descriptions.Item label="支付单号"><Typography.Text copyable>{selectedOrder.paymentOrderId}</Typography.Text></Descriptions.Item>}
          </Descriptions>
        )}
      </Modal>
    </>
  );
};

export const PersonalCenterPage: React.FC = () => {
  const { message } = App.useApp();
  const snapshot = useLalorAuthStore((state) => state.snapshot);
  const catalog = useLalorAuthStore((state) => state.catalog);
  const orders = useLalorAuthStore((state) => state.orders);
  const ordersLoading = useLalorAuthStore((state) => state.ordersLoading);
  const authError = useLalorAuthStore((state) => state.error);
  const loading = useLalorAuthStore((state) => state.loading);
  const loadCatalog = useLalorAuthStore((state) => state.loadCatalog);
  const loadOrders = useLalorAuthStore((state) => state.loadOrders);
  const purchaseByPoints = useLalorAuthStore((state) => state.purchaseByPoints);
  const createCashPurchase = useLalorAuthStore((state) => state.createCashPurchase);
  const getCashOrder = useLalorAuthStore((state) => state.getCashOrder);
  const logout = useLalorAuthStore((state) => state.logout);
  const [selectedProduct, setSelectedProduct] = useState<string>();
  const [purchaseMode, setPurchaseMode] = useState<'points' | 'cash'>('points');
  const [provider, setProvider] = useState<'wechat' | 'alipay'>('wechat');
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pointsPurchase, setPointsPurchase] = useState<LalorPurchaseResult | null>(null);
  const [cashPurchase, setCashPurchase] = useState<LalorPurchaseResult | null>(null);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);

  const profile = snapshot.profile;
  const avatarUrl = profile?.avatarUrl?.trim() || undefined;
  const products = catalog?.products || [];
  const agreementVersion = catalog?.agreementVersion?.trim() || '2026-09-06';
  const selected = useMemo<LalorCatalogProduct | undefined>(() => products.find((product) => product.id === selectedProduct), [products, selectedProduct]);

  useEffect(() => {
    void loadCatalog();
    void loadOrders();
  }, [loadCatalog, loadOrders]);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    const orderId = cashPurchase?.order?.id;
    if (!orderId || cashPurchase.order?.status !== 'pending') return undefined;
    const timer = window.setInterval(async () => {
      const next = await getCashOrder(orderId);
      if (next) setCashPurchase(next);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [cashPurchase?.order?.id, cashPurchase?.order?.status, getCashOrder]);

  const refreshCatalog = async (): Promise<void> => {
    await loadCatalog();
    message.success('商品库存已刷新');
  };

  const submitPurchase = async (): Promise<void> => {
    if (!selected) {
      message.warning('请先选择一个商品');
      return;
    }
    if (!agreementAccepted) {
      message.warning('请先确认已阅读并同意用户协议');
      return;
    }
    setPurchaseLoading(true);
    const idempotencyKey = `desktop-${selected.id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const result = purchaseMode === 'points'
      ? await purchaseByPoints({ productId: selected.id, idempotencyKey })
      : await createCashPurchase({ productId: selected.id, provider, idempotencyKey, agreementAccepted: true, agreementVersion });
    setPurchaseLoading(false);
    if (!result) return;
    if (purchaseMode === 'points') {
      setPointsPurchase(result);
      message.success('积分购买成功，交付内容已准备好');
    } else {
      setCashPurchase(result);
      message.info(result.order?.status === 'pending' ? '现金订单已创建，请完成支付' : '现金订单已完成');
    }
  };

  const refreshCashOrder = async (): Promise<void> => {
    const orderId = cashPurchase?.order?.id;
    if (!orderId) return;
    setRefreshing(true);
    const result = await getCashOrder(orderId);
    setRefreshing(false);
    if (result) setCashPurchase(result);
  };

  const refreshOrders = async (): Promise<void> => {
    const result = await loadOrders();
    if (result) message.success('购买记录已刷新');
  };

  const leave = async (): Promise<void> => {
    if (await logout()) message.success('已退出 Lalor，本地管理器已锁定');
  };

  return (
    <section className="workspace-full-page lalor-personal-page" aria-label="购物中心">
      <header className="workspace-page-header lalor-personal-header">
        <div>
          <div className="workspace-page-kicker">LALOR MEMBER CENTER</div>
          <Typography.Title level={1}>购物中心</Typography.Title>
          <Typography.Paragraph>查看会员资料与购买记录，在本地购买 Dola、豆包账号或静态住宅 IP。</Typography.Paragraph>
        </div>
        <Button icon={<LogoutOutlined />} onClick={() => void leave()}>退出 Lalor</Button>
      </header>

      {authError && <div className="lalor-inline-error" role="alert">{authError}</div>}

      <div className="lalor-personal-grid">
        <Card className="lalor-profile-card dashboard-glass" bordered={false}>
          <div className="lalor-profile-main">
            <Avatar
              size={72}
              src={avatarLoadFailed ? undefined : avatarUrl}
              onError={() => {
                setAvatarLoadFailed(true);
                return false;
              }}
            >{(profile?.displayName || profile?.username || 'L').slice(0, 1).toUpperCase()}</Avatar>
            <div>
              <Typography.Title level={3}>{profile?.displayName || profile?.username || 'Lalor 会员'}</Typography.Title>
              <Typography.Text type="secondary">@{profile?.username || '--'}</Typography.Text>
            </div>
          </div>
          <div className="lalor-profile-stats">
            <div><WalletOutlined aria-hidden="true" /><span>可用积分</span><strong>{profile?.availablePoints ?? 0}</strong></div>
            <div><SafetyCertificateOutlined aria-hidden="true" /><span>会员状态</span><strong>{profile?.membership?.active ? '有效' : '待验证'}</strong></div>
            <div><ShoppingOutlined aria-hidden="true" /><span>会员到期</span><strong>{formatDate(profile?.membership?.expiresAt)}</strong></div>
          </div>
        </Card>

        <Card className="lalor-shop-card dashboard-glass" bordered={false} title={<span><ShoppingOutlined aria-hidden="true" /> 购买商品</span>} extra={<Button type="text" icon={<ReloadOutlined />} aria-label="刷新商品" onClick={() => void refreshCatalog()} />}>
          <div className="lalor-shop-controls">
            <Radio.Group value={purchaseMode} onChange={(event) => setPurchaseMode(event.target.value)} optionType="button" buttonStyle="solid">
              <Radio.Button value="points">积分兑换</Radio.Button>
              <Radio.Button value="cash">现金购买</Radio.Button>
            </Radio.Group>
            {purchaseMode === 'cash' && (
              <Select aria-label="支付方式" value={provider} onChange={setProvider} options={[{ value: 'wechat', label: '微信支付' }, { value: 'alipay', label: '支付宝' }]} />
            )}
          </div>

          {loading && !catalog ? <div className="lalor-shop-loading"><Spin /> 正在读取商品库存</div> : products.length === 0 ? <Empty description="暂无可购买的桌面商城商品" /> : (
            <div className="lalor-product-grid">
              {products.map((product) => (
                <button type="button" key={product.id} className={`lalor-product-card ${selectedProduct === product.id ? 'is-selected' : ''}`} onClick={() => setSelectedProduct(product.id)} aria-pressed={selectedProduct === product.id}>
                  <span className="lalor-product-icon" aria-hidden="true"><ShoppingOutlined /></span>
                  <span className="lalor-product-copy"><strong>{product.name}</strong><small>{product.description || (product.productType === 'residential_proxy' ? '静态住宅 IP 配置' : product.productType === 'doubao_account' ? '豆包账号 CK JSON/TXT' : 'Dola 账号 CK JSON')}</small></span>
                  <span className="lalor-product-prices">
                    {product.points > 0 && <em>{product.points} 积分</em>}
                    {product.cashAmountFen > 0 && <em>{formatMoney(product.cashAmountFen)}</em>}
                  </span>
                  <span className="lalor-product-stock">库存 {product.stock}</span>
                </button>
              ))}
            </div>
          )}

          <div className="lalor-purchase-footer">
            <Checkbox checked={agreementAccepted} onChange={(event) => setAgreementAccepted(event.target.checked)}>
              我已阅读并同意 Lalor 用户协议与商品交付规则
            </Checkbox>
            <Button type="primary" size="large" loading={purchaseLoading} disabled={!selected || !agreementAccepted} onClick={() => void submitPurchase()}>
              {purchaseMode === 'points' ? '立即积分兑换' : '创建现金订单'}
            </Button>
          </div>
        </Card>
      </div>

      <OrderHistoryCard orders={orders} loading={ordersLoading} onRefresh={() => void refreshOrders()} />

      <Typography.Paragraph type="secondary" className="lalor-shop-note">
        商品名称、库存、现金价格和积分价格均由 Lalor 管理员后台发卡中心统一配置；支付开关关闭时，现金购买会明确提示，不会扣款。
      </Typography.Paragraph>

      <Modal
        className="lalor-delivery-choice-modal"
        open={Boolean(pointsPurchase?.delivery)}
        title={<span><CheckCircleOutlined aria-hidden="true" /> 积分兑换成功</span>}
        footer={null}
        width={520}
        centered
        destroyOnClose
        onCancel={() => setPointsPurchase(null)}
      >
        {pointsPurchase && (
          <div className="lalor-delivery-choice">
            <Typography.Paragraph>
              {pointsPurchase.delivery?.productType === 'residential_proxy'
                ? '住宅代理配置已准备好，请选择保存 JSON 文件，或直接导入代理池并完成连通检测。'
                : pointsPurchase.delivery?.productType === 'doubao_account'
                  ? '豆包 CK 已准备好，请选择保存 JSON/TXT 文件，或直接导入并自动检测、创建和关联豆包窗口。'
                  : 'Dola CK 已准备好，请选择保存 JSON 文件，或直接导入并自动检测、创建和关联 Dola 窗口。'}
            </Typography.Paragraph>
            <DeliveryActions purchase={pointsPurchase} onComplete={() => setPointsPurchase(null)} />
          </div>
        )}
      </Modal>

      <Modal
        className="lalor-cash-payment-modal"
        open={Boolean(cashPurchase?.order)}
        title={cashPurchase?.order?.provider === 'wechat' ? '微信扫码支付' : '现金订单支付'}
        footer={null}
        width={560}
        centered
        destroyOnClose={false}
        onCancel={() => setCashPurchase(null)}
      >
        {cashPurchase && <CashOrderPanel purchase={cashPurchase} onRefresh={() => void refreshCashOrder()} refreshing={refreshing} />}
      </Modal>
    </section>
  );
};

