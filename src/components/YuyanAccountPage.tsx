import React from 'react';
import { Alert, Button, Card, Descriptions, Space, Typography } from 'antd';
import { useLalorAuthStore } from '../store/useLalorAuthStore';

export const YuyanAccountPage: React.FC = () => {
  const profile = useLalorAuthStore((state) => state.snapshot.profile);
  const logout = useLalorAuthStore((state) => state.logout);
  const error = useLalorAuthStore((state) => state.error);
  return <main style={{ padding: 24 }}>
    <Card title="屿砚账号">
      {error && <Alert type="error" message={error} showIcon />}
      <Descriptions column={1}>
        <Descriptions.Item label="账号">{profile?.displayName || profile?.username}</Descriptions.Item>
        <Descriptions.Item label="会员">{profile?.membership?.tierLabel}</Descriptions.Item>
        <Descriptions.Item label="可用积分">{profile?.availablePoints}</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary">可在屿砚网站管理会员，或在「AI工具 → 屿砚工作台」解除绑定。</Typography.Paragraph>
      <Space><Button href="https://yuyan-ai.site/connections/desktop" target="_blank" rel="noreferrer">打开屿砚网站</Button><Button onClick={() => void logout()}>退出屿砚账号</Button></Space>
    </Card>
  </main>;
};
