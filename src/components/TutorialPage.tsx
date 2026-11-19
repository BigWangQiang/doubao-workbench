import React from 'react';
import { Button } from 'antd';
import { ExportOutlined } from '@ant-design/icons';

interface EmbeddedResourcePageProps {
  onClose: () => void;
}

export const EmbeddedResourcePage: React.FC<EmbeddedResourcePageProps> = ({ onClose }) => (
  <section className="workspace-full-page workspace-tutorial-page" aria-label="使用教程">
    <header className="workspace-page-header">
      <h1>使用教程</h1>
      <Button onClick={onClose}>返回工作台</Button>
    </header>
    <Button
      href="https://github.com/BigWangQiang/yuyan-workbench#快速开始"
      target="_blank"
      rel="noreferrer"
      icon={<ExportOutlined />}
    >
      打开 GitHub 使用教程
    </Button>
  </section>
);
