import React, { useState } from 'react';
import { Button, Card, Input, Alert, Space, Typography } from 'antd';
import { LinkOutlined, LockOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useLalorAuthStore } from '../store/useLalorAuthStore';

interface PairingGatePageProps {
  initialError?: string | null;
}

export const PairingGatePage: React.FC<PairingGatePageProps> = ({ initialError }) => {
  const [code, setCode] = useState('');
  const loading = useLalorAuthStore((state) => state.loading);
  const error = useLalorAuthStore((state) => state.error);
  const pair = useLalorAuthStore((state) => state.pair);
  const loadStatus = useLalorAuthStore((state) => state.loadStatus);
  const message = error || initialError;

  const submit = async (): Promise<void> => {
    if (!code.trim() || loading) return;
    await pair(code.trim());
  };

  return (
    <main className="lalor-pairing-shell">
      <Card className="lalor-pairing-card" bordered={false}>
        <div className="lalor-pairing-brand" aria-hidden="true">
          <span className="lalor-pairing-brand-mark">屿</span>
          <span>ai视频创作工作台</span>
        </div>
        <div className="lalor-pairing-icon" aria-hidden="true"><LockOutlined /></div>
        <Typography.Title level={1}>连接屿砚账号</Typography.Title>
        <Typography.Paragraph className="lalor-pairing-lead">
          连接屿砚账号后，可使用账号已获授权的生成服务。
        </Typography.Paragraph>
        {message && (
          <Alert
            className="lalor-pairing-alert"
            type="warning"
            showIcon
            role="alert"
            message={message}
            description="请检查配对码有效期和屿砚会员状态。"
          />
        )}
        <label className="lalor-pairing-label" htmlFor="lalor-pairing-code">一次性配对码</label>
        <Input.Password
          id="lalor-pairing-code"
          size="large"
          value={code}
          autoComplete="off"
          placeholder="粘贴在屿砚网站生成的配对码"
          onChange={(event) => setCode(event.target.value)}
          onPressEnter={() => void submit()}
          aria-describedby="lalor-pairing-help"
          prefix={<SafetyCertificateOutlined />}
        />
        <Typography.Text id="lalor-pairing-help" type="secondary" className="lalor-pairing-help">
          登录屿砚网站，在「AI工具 → 屿砚工作台」生成配对码。配对码 10 分钟内有效，仅可使用一次。
        </Typography.Text>
        <Space className="lalor-pairing-actions" wrap>
          <Button type="primary" size="large" loading={loading} disabled={!code.trim()} onClick={() => void submit()}>
            验证并连接
          </Button>
          <Button size="large" icon={<LinkOutlined />} onClick={() => window.open('https://yuyan-ai.site/connections/desktop', '_blank')}>
            打开屿砚网站
          </Button>
          <Button size="large" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadStatus()}>
            重新检测
          </Button>
        </Space>
        <Typography.Text type="secondary" className="lalor-pairing-security">
          <SafetyCertificateOutlined aria-hidden="true" /> 令牌由主进程加密保存，渲染页面不会读取或显示令牌内容。
        </Typography.Text>
      </Card>
    </main>
  );
};




