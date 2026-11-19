import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { App, Button, ConfigProvider, Input, Spin, Alert } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getAntThemeConfig } from '@/lib/app-theme';
import { appQueryClient } from '@/lib/query-client';
import { useUserStore } from '@/stores/use-user-store';
import { useCanvasStore } from '@/stores/canvas/use-canvas-store';
import { useAssetStore } from '@/stores/use-asset-store';
import { installRemoteUserDataAutoSync, syncRemoteUserData } from '@/services/user-data-sync';
import { desktopCall, isDesktop } from './bridge';
import { refreshModels } from './models';
import { CanvasDeleteProjectsDialog } from '@/components/canvas/canvas-delete-projects-dialog';
import '@/styles/globals.css';
import './desktop.css';

const Canvas = lazy(() => import('@/pages/canvas/project'));
const Projects = lazy(() => import('@/pages/canvas'));
useUserStore.setState({ hydrated: true, user: { id: 'desktop', username: 'desktop', displayName: '本地工作台', role: 'user', status: 'active' }, features: { shortDramaEnabled: true, agentBetaEnabled: false, taskCenterEnabled: true, creditsEnabled: false }, runtimeLimits: { activeTaskLimit: 20, resourceUploadMB: 512, sessionUploadMB: 512 } });
document.documentElement.classList.add('dark');
document.documentElement.style.colorScheme = 'dark';

function ApiSettings(): React.JSX.Element {
    const navigate = useNavigate();
    const location = useLocation();
    const { message } = App.useApp();
    const [settings, setSettings] = useState<{ baseUrl: string; apiKeyConfigured: boolean }>();
    useEffect(() => { if (isDesktop) void desktopCall<{ config: NonNullable<typeof settings> }>('api.settings').then((value) => setSettings(value.config)).catch((error) => message.error(error.message)); }, [message]);
    const refresh = (): void => { void refreshModels().then(() => message.success('已刷新屿砚模型')).catch((error) => message.error(error.message)); };
    const returnTo = typeof location.state?.returnTo === 'string' && /^\/canvas(?:[/?]|$)/.test(location.state.returnTo) ? location.state.returnTo : '/canvas';
    return <main className="desktop-canvas-settings"><Button onClick={() => navigate(returnTo, { replace: true })}>返回画布</Button><h1>屿砚 API</h1><p>在工作台个人中心连接屿砚账号。生成按屿砚平台价格计费。</p><label htmlFor="api-address">API 地址</label><Input id="api-address" value={settings?.baseUrl || ''} readOnly /><Button type="primary" disabled={!settings?.apiKeyConfigured} onClick={refresh}>刷新模型列表</Button></main>;
}
function CanvasRoutes(): React.JSX.Element {
    const navigate = useNavigate();
    const location = useLocation();
    const { message } = App.useApp();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const assetsReady = useAssetStore((state) => state.hydrated);
    const [error, setError] = useState('');
    useEffect(() => {
        const onSaveError = (event: Event): void => { message.error({ key: 'save-error', content: String((event as CustomEvent).detail), duration: 0 }); };
        const onNavigate = (event: Event): void => { event.preventDefault(); navigate((event as CustomEvent<{ to: string }>).detail.to, { state: { returnTo: location.pathname + location.search } }); };
        window.addEventListener('desktop:save-error', onSaveError);
        window.addEventListener('workspace:navigate', onNavigate);
        return () => { window.removeEventListener('desktop:save-error', onSaveError); window.removeEventListener('workspace:navigate', onNavigate); };
    }, [message, navigate, location.pathname, location.search]);
    useEffect(() => { void refreshModels().catch((error) => setError(error.message)); }, []);
    useEffect(() => {
        if (!hydrated || !assetsReady) return;
        void syncRemoteUserData('desktop').then(() => installRemoteUserDataAutoSync()).catch((error) => setError(error.message));
        if (isDesktop) window.parent.postMessage({ channel: 'lalor-canvas:ready' }, '*');
    }, [hydrated, assetsReady]);
    if (!hydrated || !assetsReady) return <div className="desktop-canvas-loading"><Spin /><span>正在打开本地画布</span></div>;
    return <div className="desktop-canvas-shell">
        {error ? <Alert closable type="warning" message={error} onClose={() => setError('')} /> : null}
        <div className="desktop-canvas-route">
            <Suspense fallback={<div className="desktop-canvas-loading"><Spin /><span>正在加载原版画布</span></div>}>
                <Routes>
                    <Route path="/canvas" element={<Projects />} />
                    <Route path="/canvas/:id" element={<Canvas />} />
                    <Route path="/settings" element={<ApiSettings />} />
                    <Route path="*" element={<Navigate to="/canvas" replace />} />
                </Routes>
            </Suspense>
        </div>
        <CanvasDeleteProjectsDialog />
    </div>;
}
createRoot(document.getElementById('root')!).render(<ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}><App><QueryClientProvider client={appQueryClient}><HashRouter><CanvasRoutes /></HashRouter></QueryClientProvider></App></ConfigProvider>);
