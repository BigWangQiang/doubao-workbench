/**
 * src/index.tsx
 * React 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { SoftwareUpdateNotifications } from './components/SoftwareUpdate';
import './styles/global.css';
import './styles/lalor-auth.css';

// ==================== Ant Design 深色主题配置 ====================

const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    // 品牌色 - 紫色系
    colorPrimary: '#8a7cff',
    colorInfo: '#54c6e5',
    colorSuccess: '#45d695',
    colorWarning: '#f3bb56',
    colorError: '#ff7180',
    // 基础色
    colorBgBase: '#0b0d12',
    colorBgContainer: '#171922',
    colorBgElevated: '#222435',
    colorBorder: '#343747',
    colorTextBase: '#f3f3fa',
    colorTextSecondary: '#b8bbca',
    // 圆角
    borderRadius: 7,
    controlHeight: 36,
    fontSize: 13,
    // 字体
    fontFamily: "'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  components: {
    Button: {
      colorPrimary: '#8a7cff',
      algorithm: true,
    },
    Modal: {
      colorBgElevated: '#222435',
    },
    Dropdown: {
      colorBgElevated: '#222435',
    },
    Input: {
      colorBgContainer: '#14161f',
    },
    Tag: {
      borderRadiusSM: 9999,
    },
  },
};

// ==================== 渲染 ====================

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={darkTheme} locale={zhCN}>
      <AntdApp>
        <App />
        <SoftwareUpdateNotifications />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
);
