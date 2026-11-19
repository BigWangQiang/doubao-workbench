import { restorePreviewResources } from './resources';

// 先恢复本地媒体 URL，再加载会在模块初始化时恢复项目的 Zustand store。
await restorePreviewResources();
localStorage.setItem('infinite-canvas:active-user-scope', 'desktop');
await import('./app');
