import React, { useId, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Progress } from 'antd';
import { DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { runBatchDeletion, type BatchDeleteItem, type BatchDeleteResult, type DeleteItemResult } from '../utils/batchDeletion';

interface BatchDeleteDialogProps {
  noun: string;
  items: BatchDeleteItem[];
  description: string;
  onDelete: (id: string) => Promise<DeleteItemResult>;
  onClose: () => void;
}

/** 两类列表共用选择、确认和逐项结果反馈；实际删除与权限校验仍由各自业务层处理。 */
export const BatchDeleteDialog: React.FC<BatchDeleteDialogProps> = ({ noun, items, description, onDelete, onClose }) => {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<BatchDeleteItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [result, setResult] = useState<BatchDeleteResult | null>(null);
  const submitting = useRef(false);
  const checkboxPrefix = useId();
  const normalizedKeyword = keyword.trim().toLowerCase();
  const visible = items.filter(item => `${item.label} ${item.detail || ''}`.toLowerCase().includes(normalizedKeyword));
  const eligible = visible.filter(item => !item.blockedReason);
  const targets = eligible.filter(item => selected.includes(item.id));
  const allSelected = eligible.length > 0 && targets.length === eligible.length;

  const deleteConfirmed = async (): Promise<void> => {
    if (!confirmed?.length || submitting.current) return;
    submitting.current = true;
    setRunning(true);
    try { setResult(await runBatchDeletion(confirmed, onDelete, setCompleted)); }
    finally { submitting.current = false; setRunning(false); }
  };
  const close = (): void => { if (!submitting.current) onClose(); };
  const footer = result ? (
    <Button type="primary" onClick={close}>完成</Button>
  ) : confirmed ? (
    <div className="flex flex-wrap justify-end gap-2">
      <Button disabled={running} onClick={(): void => setConfirmed(null)}>返回选择</Button>
      <Button danger type="primary" icon={<DeleteOutlined aria-hidden="true" />} loading={running} onClick={(): void => { void deleteConfirmed(); }}>
        {running ? `正在删除 ${completed}/${confirmed.length}` : `确认删除 ${confirmed.length} 个${noun}`}
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-db-text-secondary" aria-live="polite">已选择 {targets.length} 个{noun}</span>
      <div className="flex gap-2">
        <Button onClick={close}>取消</Button>
        <Button danger type="primary" disabled={!targets.length} onClick={(): void => setConfirmed(targets.map(item => ({ ...item })))}>下一步</Button>
      </div>
    </div>
  );

  return <Modal open title={`批量删除${noun}`} centered onCancel={close} footer={footer} closable={!running} maskClosable={false} keyboard={!running}>
    <div className="flex flex-col gap-3">
      {result ? <>
        <Alert showIcon type={result.failures.length ? 'warning' : 'success'} message={`已删除 ${result.deletedIds.length} 个${noun}${result.failures.length ? `，${result.failures.length} 个未完成` : ''}`} />
        {result.failures.length > 0 && <div className="max-h-64 overflow-y-auto space-y-2" aria-label="未完成的删除项">
          {result.failures.map(item => <div key={item.id} className="rounded-db border border-db-border p-3">
            <div className="truncate text-sm text-db-text-primary" title={item.label}>{item.label}</div>
            <div className="mt-1 break-words text-xs text-db-status-error">{item.error}</div>
          </div>)}
        </div>}
      </> : confirmed ? <>
        <Alert showIcon type="warning" message={`即将删除 ${confirmed.length} 个${noun}`} description={description} />
        <div className="max-h-64 overflow-y-auto divide-y divide-db-border rounded-db border border-db-border" aria-label="确认删除范围">
          {confirmed.map(item => <div key={item.id} className="px-3 py-2">
            <div className="truncate text-sm text-db-text-primary" title={item.label}>{item.label}</div>
            {item.detail && <div className="truncate text-xs text-db-text-secondary">{item.detail}</div>}
          </div>)}
        </div>
        {running && <div role="status" aria-live="polite"><Progress percent={Math.round(completed / confirmed.length * 100)} /><span className="text-xs text-db-text-secondary">按实际删除结果更新进度，请勿关闭软件。</span></div>}
      </> : <>
        <p className="m-0 text-sm text-db-text-secondary">{description}</p>
        <Input autoFocus allowClear prefix={<SearchOutlined aria-hidden="true" />} placeholder={`搜索${noun}`} aria-label={`搜索待删除${noun}`} value={keyword}
          onChange={(event): void => { setKeyword(event.target.value); setSelected([]); }} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-db-text-secondary">
          <Checkbox checked={allSelected} indeterminate={targets.length > 0 && !allSelected} disabled={!eligible.length}
            onChange={(event): void => setSelected(event.target.checked ? eligible.map(item => item.id) : [])}>全选筛选结果</Checkbox>
          <span>可选 {eligible.length} / {visible.length}</span>
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-db-border rounded-db border border-db-border" aria-label={`${noun}批量选择列表`}>
          {visible.length ? visible.map(item => <div key={item.id} className={`flex items-start gap-3 px-3 py-3 ${item.blockedReason ? 'cursor-not-allowed' : 'hover:bg-db-surface-hover'}`}>
            <Checkbox id={`${checkboxPrefix}-${item.id}`} aria-label={`选择${noun}：${item.label}`} checked={!item.blockedReason && selected.includes(item.id)} disabled={Boolean(item.blockedReason)}
              onChange={(event): void => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
            <label htmlFor={`${checkboxPrefix}-${item.id}`} className={`min-w-0 flex-1 ${item.blockedReason ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
              <span className="block truncate text-sm text-db-text-primary" title={item.label}>{item.label}</span>
              {item.detail && <span className="mt-1 block truncate text-xs text-db-text-secondary">{item.detail}</span>}
              {item.blockedReason && <span className="mt-1 block text-xs text-db-status-busy">{item.blockedReason}</span>}
            </label>
          </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`没有匹配的${noun}`} />}
        </div>
      </>}
    </div>
  </Modal>;
};
