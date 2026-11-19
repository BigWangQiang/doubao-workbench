import React from 'react';
import logoSrc from '../assets/yuyan-workbench.png';

interface StartupSplashProps {
  visible: boolean;
  phase: string;
}

/**
 * 应用启动过渡页。
 *
 * 只负责渲染启动反馈，不承载任何账号、任务或 WebView 初始化逻辑。
 * 背景和动效参考用户提供的启动截图；logo 使用用户提供的图二素材。
 */
export const StartupSplash: React.FC<StartupSplashProps> = ({ visible, phase }) => {
  return (
    <div
      className={`startup-splash ${visible ? 'is-visible' : 'is-hidden'}`}
      aria-hidden={!visible}
      aria-live="polite"
    >
      <div className="startup-splash-noise" aria-hidden="true" />
      <div className="startup-splash-content">
        <div className="startup-logo-wrap">
          <span className="startup-logo-orbit" aria-hidden="true" />
          <img className="startup-logo" src={logoSrc} alt="" />
        </div>
        <div className="startup-wordmark">屿砚工作台</div>
        <div className="startup-phase">{phase}</div>
        <div className="startup-progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
};

