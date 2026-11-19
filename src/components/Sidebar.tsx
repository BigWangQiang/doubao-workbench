/**
 * src/components/Sidebar.tsx
 * 左侧面板容器
 *
 * 上半部分：账号列表 (AccountList)
 * 下半部分：任务控制台 (TaskConsole)
 * 中间有拖拽调整大小的分隔线
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { AccountList } from './AccountList';
import TaskConsole from './TaskConsole';
import { calculateSidebarSplitRatio } from '../utils/resizeMath';

export type SidebarView = 'split' | 'accounts' | 'tasks';

interface SidebarProps {
  /** 工作区导航选择账号池或任务队列时，只渲染对应的单一内容。 */
  view?: SidebarView;
}

export const Sidebar: React.FC<SidebarProps> = ({ view = 'split' }) => {
  // 上下两部分的分隔比例（0.4 = 账号区占 40%，任务区占 60%）
  const [splitRatio, setSplitRatio] = useState(0.45);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const accountPaneRef = useRef<HTMLDivElement>(null);
  const splitResizerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startRatio: number;
    pendingRatio: number;
    containerTop: number;
    containerHeight: number;
    frameId: number | null;
  } | null>(null);

  useEffect(() => {
    const handleWorkspaceFocus = (event: Event) => {
      const pane = (event as CustomEvent<{ pane?: 'workspace' | 'accounts' | 'tasks' }>).detail?.pane;
      const nextRatio = pane === 'accounts' ? 0.68 : pane === 'tasks' ? 0.28 : 0.45;
      setSplitRatio(nextRatio);
      if (accountPaneRef.current) accountPaneRef.current.style.height = `${nextRatio * 100}%`;
    };
    window.addEventListener('workspace-focus-pane', handleWorkspaceFocus);
    return () => window.removeEventListener('workspace-focus-pane', handleWorkspaceFocus);
  }, []);

  // 拖拽分隔线
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setIsDragging(true);
    dragRef.current = {
      startRatio: splitRatio,
      pendingRatio: splitRatio,
      containerTop: rect.top,
      containerHeight: rect.height,
      frameId: null,
    };

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.pendingRatio = calculateSidebarSplitRatio(e.clientY, drag.containerTop, drag.containerHeight);
      if (drag.frameId !== null) return;
      drag.frameId = requestAnimationFrame(() => {
        const current = dragRef.current;
        if (!current) return;
        current.frameId = null;
        // 只移动预览线；账号/任务大列表在松手前完全不参与布局。
        if (splitResizerRef.current) {
          const deltaY = (current.pendingRatio - current.startRatio) * current.containerHeight;
          splitResizerRef.current.style.transform = `translate3d(0, ${deltaY}px, 0)`;
        }
      });
    };

    const handleMouseUp = () => {
      const drag = dragRef.current;
      if (drag?.frameId !== null && drag?.frameId !== undefined) cancelAnimationFrame(drag.frameId);
      if (drag) {
        if (accountPaneRef.current) accountPaneRef.current.style.height = `${drag.pendingRatio * 100}%`;
        if (splitResizerRef.current) splitResizerRef.current.style.transform = '';
        setSplitRatio(drag.pendingRatio);
      }
      dragRef.current = null;
      setIsDragging(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [splitRatio]);

  if (view === 'accounts') {
    return (
      <div className="workspace-sidebar workspace-single-pane workspace-pane workspace-account-pane h-full bg-db-bg-secondary" tabIndex={-1}>
        <AccountList />
      </div>
    );
  }

  if (view === 'tasks') {
    return (
      <div className="workspace-sidebar workspace-single-pane workspace-pane workspace-task-pane h-full bg-db-bg-secondary" tabIndex={-1}>
        <TaskConsole />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="workspace-sidebar flex flex-col h-full bg-db-bg-secondary">
      {isDragging && <div className="resize-capture-overlay resize-capture-overlay-row" />}
      {/* 账号列表区域 */}
      <div ref={accountPaneRef} className="workspace-pane workspace-account-pane overflow-hidden" style={{ height: `${splitRatio * 100}%` }} tabIndex={-1}>
        <AccountList />
      </div>

      {/* 可拖拽分隔线 */}
      <div
        ref={splitResizerRef}
        className={`sidebar-split-resizer h-1 flex-shrink-0 cursor-row-resize transition-colors duration-150 ${
          isDragging ? 'bg-db-accent' : 'bg-db-border hover:bg-db-accent/30'
        }`}
        onMouseDown={handleMouseDown}
      />

      {/* 任务控制台区域 */}
      <div className="workspace-pane workspace-task-pane flex-1 overflow-hidden" tabIndex={-1}>
        <TaskConsole />
      </div>
    </div>
  );
};
