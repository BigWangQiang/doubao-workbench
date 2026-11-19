import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, InputNumber, Modal, Select, Tag, Tooltip, message } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CheckCircleOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, PauseOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, SendOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { StoryboardBatch, StoryboardInput, StoryboardRow, StoryboardRowState, VideoAspectRatio, VideoModel } from '@doubao-studio/contracts';
import { useAccountStore } from '../store/useAccountStore';
import { useProjectStore } from '../store/useProjectStore';
import { imageName, matchStoryboardImages, referenceName, renameReferenceMentions, smartMentionReferences, splitStoryboards, storyboardImageLabel, storyboardPromptWithReferences, validReferenceName } from '../utils/storyboardImport';
import type { WorkspacePane } from './WorkspaceRail';
import { StoryboardPromptInput } from './StoryboardPromptInput';
import '../styles/storyboard-batch.css';

interface Props { active: boolean; onNavigate: (pane: WorkspacePane) => void }
interface BatchDraft {
  id: string; projectId: string; batchId?: string; title: string; accountId: string;
  model: VideoModel; ratio: VideoAspectRatio; duration: number; resolution?: '720P' | '1080P';
  rows: StoryboardInput[]; images: string[]; referenceNames: Record<string, string>; script: string;
}
const createDraft = (projectId: string, number: number): BatchDraft => ({
  id: crypto.randomUUID(), projectId, title: `分镜视频 ${number}`, accountId: '',
  model: 'seedance-2.5', ratio: '16:9', duration: 5, resolution: '1080P', rows: [], images: [], referenceNames: {}, script: '',
});
const models: { value: VideoModel; label: string }[] = [
  { value: 'seedance-2.5', label: 'Seedance 2.5' }, { value: 'seedance-2.0', label: 'Seedance 2.0' },
  { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast' }, { value: 'seedance-2.0-mini', label: 'Seedance 2.0 Mini' },
];
const ratios: VideoAspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const states: Record<StoryboardRowState, string> = { pending: '待准备', creating: '创建节点', filling: '填写 / 上传', ready: '已就绪', submitting: '正在发送', generating: '生成中', saving: '保存中', done: '已保存', failed: '失败', review: '待核对' };
const phases: Record<StoryboardBatch['phase'], string> = { draft: '草稿', preparing: '准备中', ready: '等待发送', running: '执行中', paused: '已暂停', done: '已结束' };
const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const ReferenceThumbnail: React.FC<{ path: string }> = ({ path }) => {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    void window.electronAPI.tasks.readFileAsBase64(path).then((result) => {
      if (!mounted) return;
      if (result.success && result.data) setSource(result.data); else setFailed(true);
    }).catch(() => { if (mounted) setFailed(true); });
    return (): void => { mounted = false; };
  }, [path]);
  return <span className="storyboard-thumbnail" title={failed ? '无法读取图片，请重新选择' : imageName(path)}>
    {source ? <img src={source} alt={imageName(path)} onError={(): void => setFailed(true)} /> : <PictureOutlined />}
    {failed ? <span>读取失败</span> : null}
  </span>;
};

export const StoryboardBatchPage: React.FC<Props> = ({ active, onNavigate }) => {
  const accounts = useAccountStore((state) => state.accounts);
  const projectId = useProjectStore((state) => state.activeProjectId);
  const [batches, setBatches] = useState<StoryboardBatch[]>([]);
  const [workspace, setWorkspace] = useState<{ drafts: BatchDraft[]; selectedId: string }>(() => {
    const first = createDraft(projectId, 1);
    return { drafts: [first], selectedId: first.id };
  });
  const { drafts, selectedId } = workspace;
  const draft = drafts.find((item) => item.id === selectedId && item.projectId === projectId);
  const { title = '', accountId = '', model = 'seedance-2.5', ratio = '16:9', duration = 5, resolution = '1080P',
    rows = [], images = [], referenceNames = {}, script = '' } = draft || {};
  const [renaming, setRenaming] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<Record<string, string>>({});
  const [pausing, setPausing] = useState<Record<string, boolean>>({});
  const actionLocks = useRef(new Set<string>());
  const mounted = useRef(true);
  const batch = batches.find((item) => item.id === (draft?.batchId || selectedId) && item.projectId === projectId);
  const error = errors[selectedId] || errors.list || '';
  const operation = operations[selectedId] || '';
  const pausePending = Boolean(pausing[selectedId]);
  const setError = (value: string): void => setErrors((current) => ({ ...current, [selectedId]: value }));
  // 每个草稿有独立身份；异步选图和准备完成后仍只回写原批次。
  const updateDraft = (update: (current: BatchDraft) => BatchDraft): void => {
    if (!draft) return;
    setWorkspace((current) => ({ ...current, drafts: current.drafts.map((item) => item.id === draft.id ? update(item) : item) }));
  };
  const setRows = (value: React.SetStateAction<StoryboardInput[]>): void => updateDraft((current) => ({ ...current, rows: typeof value === 'function' ? value(current.rows) : value }));
  const setImages = (value: React.SetStateAction<string[]>): void => updateDraft((current) => ({ ...current, images: typeof value === 'function' ? value(current.images) : value }));
  const apiAvailable = Boolean(window.electronAPI?.storyboardBatch);
  const recoveryAvailable = Boolean(window.electronAPI?.storyboardBatch?.restoreUnsent);
  const busy = Boolean(operation || batch?.busy || batch?.phase === 'preparing' || batch?.phase === 'running');
  const ready = batch?.rows.filter((row) => row.state === 'ready').length || 0;
  const finished = batch?.rows.filter((row) => row.state === 'done').length || 0;
  const refresh = useCallback(async (): Promise<void> => {
    if (!window.electronAPI?.storyboardBatch) return;
    const next = await window.electronAPI.storyboardBatch.list();
    if (mounted.current) setBatches(next);
  }, []);
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || !apiAvailable) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try { await refresh(); if (!stopped) setErrors((current) => ({ ...current, list: '' })); }
      catch (reason: unknown) { if (!stopped) setErrors((current) => ({ ...current, list: formatError(reason) })); }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1500);
    };
    void poll();
    return (): void => { stopped = true; clearTimeout(timer); };
  }, [active, apiAvailable, refresh]);
  useEffect(() => {
    setWorkspace((current) => {
      if (current.drafts.some((item) => item.id === current.selectedId && item.projectId === projectId)) return current;
      const existing = current.drafts.find((item) => item.projectId === projectId);
      const next = existing || createDraft(projectId, 1);
      return { drafts: existing ? current.drafts : [...current.drafts, next], selectedId: next.id };
    });
  }, [projectId]);
  useEffect(() => {
    setRenaming(''); setRenameValue(''); setRenameError(''); setImportOpen(false); setImportError('');
    document.querySelector('.storyboard-content')?.scrollTo({ top: 0, behavior: 'auto' });
  }, [selectedId]);

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    if (actionLocks.current.has(selectedId)) return;
    actionLocks.current.add(selectedId);
    setOperations((current) => ({ ...current, [selectedId]: name })); setError('');
    try { await action(); }
    catch (reason: unknown) { setError(formatError(reason)); }
    finally {
      try { await refresh(); } catch (reason: unknown) { setError(formatError(reason)); }
      actionLocks.current.delete(selectedId);
      setOperations((current) => { const next = { ...current }; delete next[selectedId]; return next; });
    }
  };
  const changeRow = (id: string, update: Partial<StoryboardInput>): void => setRows((current) => current.map((row) => row.id === id ? { ...row, ...update } : row));
  const bindMentions = (id?: string): void => setRows((current) => current.map((row) => {
    if (id && id !== row.id) return row;
    const linked = smartMentionReferences(row.prompt, images, referenceNames);
    return { ...row, prompt: linked.prompt, images: [...new Set([...row.images, ...linked.images])] };
  }));
  const renameImage = (): void => {
    const name = renameValue.trim();
    if (!validReferenceName(name)) { setRenameError('使用1–60个中文、字母、数字、_或-，不要以“图+数字”开头'); return; }
    if (images.some((file) => file !== renaming && referenceName(file, referenceNames) === name)) { setRenameError('已有同名图片，请换一个名字'); return; }
    const previous = referenceName(renaming, referenceNames);
    const nextNames = { ...referenceNames, [renaming]: name };
    updateDraft((current) => ({ ...current, referenceNames: nextNames }));
    setRows((current) => current.map((row) => {
      const linked = smartMentionReferences(renameReferenceMentions(row.prompt, previous, name), images, nextNames);
      return { ...row, prompt: linked.prompt, images: [...new Set([...row.images, ...linked.images])] };
    }));
    setRenaming(''); setRenameError('');
  };
  const moveRow = (index: number, direction: number): void => setRows((current) => {
    const next = [...current]; const destination = index + direction;
    if (destination < 0 || destination >= next.length) return current;
    [next[index], next[destination]] = [next[destination], next[index]]; return next;
  });
  const pickImages = async (rowId?: string): Promise<void> => {
    const result = await window.electronAPI.tasks.selectImages();
    if (!result.success) { if (result.error) throw new Error(result.error); return; }
    const chosen = result.filePaths || [];
    if (chosen.some((file) => !/\.(png|jpe?g|webp)$/i.test(file))) throw new Error('参考图支持 PNG、JPG 和 WebP，请重新选择');
    const target = rowId ? rows.find((row) => row.id === rowId) : undefined;
    if (target && new Set([...target.images, ...chosen]).size > 9) throw new Error('每条分镜最多 9 张参考图，本次未添加');
    const next = [...new Set([...images, ...(result.filePaths || [])])];
    const nextNames = { ...referenceNames };
    const taken = new Set(images.map((file) => referenceName(file, referenceNames)));
    for (const file of chosen) {
      if (images.includes(file)) continue;
      const base = validReferenceName(imageName(file)) ? imageName(file) : '参考图';
      let name = base; let suffix = 2;
      while (taken.has(name)) name = `${base.slice(0, 54)}_${suffix++}`;
      nextNames[file] = name; taken.add(name);
    }
    updateDraft((current) => ({ ...current, referenceNames: nextNames }));
    setImages(next);
    setRows((current) => current.map((row) => rowId
      ? row.id === rowId ? { ...row, images: [...new Set([...row.images, ...chosen])] } : row
      : { ...row, images: [...new Set([...row.images, ...matchStoryboardImages(row.prompt, next, nextNames).images])] }));
  };
  const importScript = (): void => {
    try {
      const next = splitStoryboards(script, duration).map((row) => {
        const linked = smartMentionReferences(row.prompt, images, referenceNames);
        return { ...row, prompt: linked.prompt, images: linked.images };
      });
      setRows(next); setImportOpen(false); setImportError('');
      void message.success(`已拆分 ${next.length} 条分镜，请检查参考图和时长`);
    } catch (reason: unknown) { setImportError(formatError(reason)); }
  };
  const newBatch = (): void => {
    const next = createDraft(projectId, drafts.filter((item) => item.projectId === projectId && !item.batchId).length + batches.filter((item) => item.projectId === projectId).length + 1);
    setWorkspace((current) => ({ drafts: [...current.drafts, next], selectedId: next.id }));
    void message.success('已新建空白批次，请选择豆包账号');
  };
  const removeBatch = (id: string, saved?: StoryboardBatch): void => {
    const name = saved?.title || drafts.find((item) => item.id === id)?.title || '未命名批次';
    Modal.confirm({
      title: `删除“${name}”？`, okText: '删除批次', okButtonProps: { danger: true }, cancelText: '取消',
      content: saved ? '只删除本机批次记录。原豆包画布、任务队列记录和已保存的视频会保留。' : '删除这份未保存的草稿，其他批次不受影响。',
      onOk: async (): Promise<void> => {
        try {
          if (saved) {
            if (!window.electronAPI.storyboardBatch.remove) throw new Error('请先重启工作台以加载批次删除功能');
            await window.electronAPI.storyboardBatch.remove(saved.id);
            setBatches((current) => current.filter((item) => item.id !== saved.id));
          }
          setWorkspace((current) => {
            const remaining = current.drafts.filter((item) => item.id !== id && (!saved || item.batchId !== saved.id));
            if (current.selectedId !== id && current.selectedId !== saved?.id) return { ...current, drafts: remaining };
            const next = remaining.find((item) => item.projectId === projectId) || createDraft(projectId, 1);
            return { drafts: remaining.includes(next) ? remaining : [...remaining, next], selectedId: next.id };
          });
          void message.success('批次已删除');
        } catch (reason: unknown) { void message.error(formatError(reason)); throw reason; }
      },
    });
  };
  const prepare = (): void => {
    void run('准备节点', async (): Promise<void> => {
      let target = batch;
      if (!target) {
        if (!draft || draft.batchId) throw new Error('批次记录尚未加载，请稍后重试');
        const linkedRows = rows.map((row) => {
          const linked = smartMentionReferences(row.prompt, images, referenceNames);
          if (linked.errors.length) throw new Error(`分镜${row.number}：${linked.errors.join('；')}`);
          return { ...row, prompt: linked.prompt, images: [...new Set([...row.images, ...linked.images])] };
        });
        setRows(linkedRows);
        target = await window.electronAPI.storyboardBatch.create({ title, projectId, accountId, model, ratio, resolution: model === 'seedance-2.5' ? resolution : undefined, concurrency: 4, rows: linkedRows, referenceNames });
        const created = target;
        setBatches((current) => [created, ...current.filter((item) => item.id !== created.id)]);
        updateDraft((current) => ({ ...current, batchId: created.id }));
      }
      await window.electronAPI.storyboardBatch.prepare(target.id);
    });
  };
  const submit = (): void => {
    if (!batch) return;
    const held = batch.rows.filter(row => row.state === 'review' && row.submissionIntentAt).length;
    Modal.confirm({
      title: `确认批量发送 ${ready} 个视频节点？`,
      content: `${held ? `另外 ${held} 条待核对分镜将保留，不会重发。` : ''}本次只发送已就绪节点，发送前重新核对提示词、参考图和参数。不等待上一条生成结束，会消耗所选豆包账号的额度。节点明确生成失败时自动点击“重新生成”，每个节点最多 5 次；暂停会停止后续点击。`,
      okText: '确认批量发送', cancelText: '再检查一下',
      onOk: (): void => { void run('批量发送', () => window.electronAPI.storyboardBatch.start(batch.id)); },
    });
  };
  const restoreUnsent = (row: StoryboardRow): void => {
    if (!batch) return;
    Modal.confirm({
      title: `确认分镜${row.number}没有提交？`,
      content: '请先打开原豆包画布并核对任务记录。只有确认该分镜没有提交、没有排队或生成时，才恢复草稿；仅凭空白节点无法判断。恢复后还需重新准备并确认发送。无法确认时请取消，继续找回进度，避免重复生成。',
      okText: '已核对，恢复待准备', cancelText: '继续核对', autoFocusButton: 'cancel',
      onOk: (): void => { void run('恢复未发送分镜', () => window.electronAPI.storyboardBatch.restoreUnsent(batch.id, row.id, true)); },
    });
  };
  const allReady = Boolean(recoveryAvailable && ready && batch?.rows.every((row) => ['ready', 'generating', 'saving', 'done', 'failed'].includes(row.state) || (row.state === 'review' && row.submissionIntentAt)));
  const canPrepare = Boolean(!batch || batch.rows.some((row) => !row.submissionIntentAt && !row.submittedAt && ['pending', 'review', 'creating', 'filling'].includes(row.state)));
  const canResume = Boolean(batch?.canvasId && !busy && (batch.phase !== 'done' || batch.rows.some(row => row.state === 'failed' && row.submittedAt && !row.outputUrl && (row.regeneration?.attempts || 0) < 5)));
  const shownRows = batch?.rows || rows;
  const displayNames = batch?.referenceNames || referenceNames;
  const step = !batch ? 0 : batch.phase === 'done' ? 3 : batch.rows.some((row) => row.submissionIntentAt || row.submittedAt) ? 2 : 1;

  return <section className="storyboard-page" aria-label="分镜并发生成">
    <header className="storyboard-header">
      <div className="storyboard-header-brand"><span className="storyboard-eyebrow">豆包画布 · 批量创作</span><h1><ThunderboltOutlined aria-hidden="true" />并发生成</h1></div>
      <nav className="storyboard-flow" aria-label="批量生成流程">
        {['整理分镜', '全部准备', '批量发送', '保存产物'].map((label, index) => <div key={label} className={`storyboard-flow-step ${index === step ? 'is-current' : index < step ? 'is-complete' : ''}`} aria-current={index === step ? 'step' : undefined}><span className="storyboard-step-number">{index < step ? <CheckCircleOutlined /> : index + 1}</span><strong>{label}</strong>{index < 3 ? <i aria-hidden="true" /> : null}</div>)}
      </nav>
      <div className="storyboard-header-actions"><Button icon={<FolderOpenOutlined />} onClick={(): void => onNavigate('artifacts')}>产物中心</Button><Button icon={<PlusOutlined />} onClick={newBatch}>新建批次</Button></div>
    </header>
    {!apiAvailable ? <Alert className="storyboard-runtime-notice" type="warning" showIcon message="并发后台尚未加载，更新主进程并重启工作台后可使用。" /> : null}
    {apiAvailable && !recoveryAvailable ? <Alert className="storyboard-runtime-notice" type="info" showIcon message="分镜恢复功能需要更新并重启工作台后使用，当前任务记录仍保留。" /> : null}
    {error ? <Alert type="error" showIcon message={error} closable onClose={(): void => setErrors((current) => ({ ...current, [selectedId]: '', list: '' }))} /> : null}
    <div className="storyboard-layout">
      <aside className="storyboard-history">
        <div className="storyboard-section-heading"><h2>批次记录</h2><span>{drafts.filter((item) => item.projectId === projectId && !item.batchId).length + batches.filter((item) => item.projectId === projectId).length}</span></div>
        {drafts.filter((item) => item.projectId === projectId && !item.batchId).map((item) => <div key={item.id} className="storyboard-history-row"><button type="button" className={`storyboard-history-item ${item.id === selectedId ? 'is-active' : ''}`} aria-current={item.id === selectedId ? 'true' : undefined} onClick={(): void => setWorkspace((current) => ({ ...current, selectedId: item.id }))}><span><EditOutlined /> {item.title || '未命名批次'}</span><small>{item.rows.length} 条分镜 · 草稿</small><small>{accounts.find((account) => account.id === item.accountId)?.name || '未选择账号'}</small></button><Tooltip title="删除草稿"><Button className="storyboard-history-delete" type="text" danger size="small" aria-label={`删除草稿 ${item.title}`} icon={<DeleteOutlined />} disabled={Boolean(operations[item.id])} onClick={(): void => removeBatch(item.id)} /></Tooltip></div>)}
        {batches.filter((item) => item.projectId === projectId).map((item) => {
          const viewId = drafts.find((candidate) => candidate.batchId === item.id)?.id || item.id;
          const deleteBlocked = Boolean(item.busy || operations[viewId] || item.rows.some((row) => ['submitting', 'generating', 'saving'].includes(row.state) || ((row.submissionIntentAt || row.submittedAt) && !['done', 'failed'].includes(row.state))));
          return <div key={item.id} className="storyboard-history-row"><button type="button" className={`storyboard-history-item ${viewId === selectedId ? 'is-active' : ''}`} aria-current={viewId === selectedId ? 'true' : undefined} onClick={(): void => setWorkspace((current) => ({ ...current, selectedId: viewId }))}><span>{item.title}</span><small>{item.rows.length} 条分镜 · {phases[item.phase]}</small><small>{accounts.find((account) => account.id === item.accountId)?.name || '原账号不可用'}</small></button><Tooltip title={deleteBlocked ? '运行中或提交待确认，请先暂停并找回进度' : '删除批次记录'}><Button className="storyboard-history-delete" type="text" danger size="small" aria-label={`删除批次 ${item.title}`} icon={<DeleteOutlined />} disabled={deleteBlocked} onClick={(): void => removeBatch(viewId, item)} /></Tooltip></div>;
        })}
        <p className="storyboard-history-note">可切换批次查看进度，不同账号独立执行。草稿在准备后保存到本机。</p>
      </aside>
      <main className="storyboard-content">
        <section className="storyboard-settings">
          <div className="storyboard-section-heading"><h2>{batch ? batch.title : '生成设置'}</h2>{batch ? <Tag>{phases[batch.phase]}</Tag> : <span>一个批次使用一个豆包账号</span>}</div>
          <div className="storyboard-fields">
            <label><span>批次名称</span><Input aria-label="批次名称" maxLength={100} value={batch?.title || title} disabled={Boolean(batch) || Boolean(operation)} onChange={(event): void => { const value = event.target.value; updateDraft((current) => ({ ...current, title: value })); }} /></label>
            <label><span>豆包账号</span><Select aria-label="豆包账号" placeholder="选择账号" value={batch?.accountId || accountId || undefined} disabled={Boolean(batch) || Boolean(operation)} onChange={(value: string): void => updateDraft((current) => ({ ...current, accountId: value }))} options={accounts.filter((item) => item.platform !== 'dola').map((item) => ({ value: item.id, label: item.name }))} /></label>
            <label><span>视频模型</span><Select aria-label="视频模型" value={batch?.model || model} disabled={Boolean(batch) || Boolean(operation)} onChange={(value: VideoModel): void => updateDraft((current) => ({ ...current, model: value }))} options={models} /></label>
            <label><span>画面比例</span><Select aria-label="画面比例" value={batch?.ratio || ratio} disabled={Boolean(batch) || Boolean(operation)} onChange={(value: VideoAspectRatio): void => updateDraft((current) => ({ ...current, ratio: value }))} options={ratios.map((value) => ({ value, label: value }))} /></label>
            {!batch ? <label><span>默认时长 / 秒</span><InputNumber aria-label="默认时长" min={4} max={model === 'seedance-2.5' ? 30 : 15} precision={0} value={duration} onChange={(value): void => updateDraft((current) => ({ ...current, duration: value || 5 }))} /></label> : null}
            {(batch?.model || model) === 'seedance-2.5' ? <label><span>分辨率</span><Select aria-label="分辨率" placeholder="豆包默认" value={batch ? batch.resolution : resolution} disabled={Boolean(batch) || Boolean(operation)} onChange={(value: '720P' | '1080P'): void => updateDraft((current) => ({ ...current, resolution: value }))} options={['720P', '1080P'].map((value) => ({ value, label: value }))} /></label> : null}
          </div>
          {batch ? <div className="storyboard-batch-status" role="status"><span>{batch.message}</span>{batch.canvasId ? <Button size="small" icon={<FolderOpenOutlined />} onClick={(): void => { void run('打开画布', () => window.electronAPI.storyboardBatch.open(batch.id)); }}>打开豆包画布</Button> : null}</div> : null}
        </section>
        <section className="storyboard-editor">
          <div className="storyboard-section-heading"><h2>分镜清单 <span>{shownRows.length}</span></h2>{!batch ? <div className="storyboard-tools"><Button disabled={!rows.length || !images.length} onClick={(): void => bindMentions()}>智能 @ 匹配</Button><Button icon={<PictureOutlined />} onClick={(): void => { void run('选择图片', () => pickImages()); }}>添加参考图</Button><Button icon={<PlusOutlined />} onClick={(): void => setImportOpen(true)}>导入分镜</Button></div> : <span>就绪 {ready} · 已保存 {finished}</span>}</div>
          {!batch && images.length ? <div className="storyboard-image-bank"><span>参考图库</span>{images.map((file) => <div key={file} className="storyboard-image-chip"><ReferenceThumbnail path={file} />
            {renaming === file ? <div className="storyboard-rename"><Input size="small" autoFocus aria-label="参考图名称" value={renameValue} status={renameError ? 'error' : undefined} maxLength={60} onChange={(event): void => { setRenameValue(event.target.value); setRenameError(''); }} onPressEnter={renameImage} onKeyDown={(event): void => { if (event.key === 'Escape') { setRenaming(''); setRenameError(''); } }} /><Button type="text" size="small" onClick={renameImage}>保存</Button><Button type="text" size="small" onClick={(): void => { setRenaming(''); setRenameError(''); }}>取消</Button>{renameError ? <span role="alert">{renameError}</span> : null}</div>
              : <button type="button" className="storyboard-reference-name" title={`修改名称：${referenceName(file, referenceNames)}`} onClick={(): void => { setRenaming(file); setRenameValue(referenceName(file, referenceNames)); setRenameError(''); }}><span>{referenceName(file, referenceNames)}</span><EditOutlined /></button>}
            <Button type="text" size="small" aria-label={`移除参考图${referenceName(file, referenceNames)}`} icon={<DeleteOutlined />} onClick={(): void => { setImages((current) => current.filter((item) => item !== file)); setRows((current) => current.map((row) => ({ ...row, images: row.images.filter((item) => item !== file) }))); if (renaming === file) setRenaming(''); }} /></div>)}</div> : null}
          {!shownRows.length ? <div className="storyboard-empty"><Empty image={<span className="storyboard-empty-icon"><ThunderboltOutlined /></span>} description={<><strong>让整组分镜一起开拍</strong><p>粘贴带有「分镜001」「分镜002」标题的提示词，自动拆分成视频节点。</p></>} /><Button type="primary" size="large" icon={<PlusOutlined />} onClick={(): void => setImportOpen(true)}>导入分镜提示词</Button></div> : null}
          <div className="storyboard-rows">{shownRows.map((row, index) => {
            const saved = batch?.rows.find((item) => item.id === row.id);
            const references = matchStoryboardImages(row.prompt, row.images, displayNames);
            return <article className="storyboard-row" key={row.id} id={`storyboard-row-${row.id}`}>
              <div className="storyboard-row-top"><div className="storyboard-row-title"><span className="storyboard-order">{String(index + 1).padStart(2, '0')}</span><strong>分镜{row.number}</strong>{saved ? <span className={`storyboard-state is-${saved.state}`}>{states[saved.state]}</span> : null}</div>
                {!batch ? <div className="storyboard-row-actions"><Tooltip title="上移"><Button type="text" aria-label={`上移分镜${row.number}`} disabled={index === 0} icon={<ArrowUpOutlined />} onClick={(): void => moveRow(index, -1)} /></Tooltip><Tooltip title="下移"><Button type="text" aria-label={`下移分镜${row.number}`} disabled={index === rows.length - 1} icon={<ArrowDownOutlined />} onClick={(): void => moveRow(index, 1)} /></Tooltip><Tooltip title="删除分镜"><Button type="text" danger aria-label={`删除分镜${row.number}`} icon={<DeleteOutlined />} onClick={(): void => setRows((current) => current.filter((item) => item.id !== row.id))} /></Tooltip></div> : <span className="storyboard-duration">{row.duration}s</span>}
              </div>
              <div className="storyboard-row-body"><div className="storyboard-prompt"><StoryboardPromptInput label={`分镜${row.number}提示词`} value={row.prompt} readOnly={Boolean(batch)} names={[...new Set((batch ? row.images : images).map((file) => referenceName(file, displayNames)))].filter(validReferenceName)} onChange={(value): void => {
                const linked = matchStoryboardImages(value, images, referenceNames);
                changeRow(row.id, { prompt: value, images: [...new Set([...row.images, ...linked.images])] });
              }} onBlur={(): void => { if (!batch) bindMentions(row.id); }} />{!batch ? <span className="storyboard-prompt-hint">输入 @ 或图片名，自动关联参考图</span> : null}</div>
                <div className="storyboard-row-references">
                  <div className="storyboard-reference-controls">
                    <span className="storyboard-reference-label">参考图 <span>{row.images.length}/9</span></span>
                    {!batch ? <Select mode="multiple" aria-label={`分镜${row.number}参考图片`} placeholder="选择本分镜参考图" value={row.images} maxTagCount="responsive" onChange={(value: string[]): void => { if (value.length > 9) { void message.warning('每条分镜最多 9 张参考图'); return; } changeRow(row.id, { images: value }); }} options={images.map((file) => ({ value: file, label: referenceName(file, referenceNames) }))} /> : null}
                    {!batch ? <Button icon={<PlusOutlined />} disabled={Boolean(operation)} onClick={(): void => { void run('选择本分镜图片', () => pickImages(row.id)); }}>上传本分镜图片</Button> : null}
                    {!batch ? <label className="storyboard-seconds">时长<InputNumber aria-label={`分镜${row.number}时长`} min={4} max={model === 'seedance-2.5' ? 30 : 15} precision={0} value={row.duration} onChange={(value): void => changeRow(row.id, { duration: value || 5 })} />秒</label> : !row.images.length ? <span className="storyboard-no-image">纯文生视频</span> : null}
                  </div>
                  {row.images.length ? <div className="storyboard-reference-list" aria-label={`分镜${row.number}参考图提交顺序`}>{row.images.map((file, imageIndex) => <span key={file} title={`${storyboardImageLabel(imageIndex)} ${referenceName(file, displayNames)}`}><ReferenceThumbnail path={file} /><small>{storyboardImageLabel(imageIndex)} · {referenceName(file, displayNames)}</small></span>)}</div> : null}
                  {row.images.length ? <span className="storyboard-reference-hint">按此顺序上传，提交后固定编号</span> : null}
                </div>
              </div>
              {row.images.length ? <details className="storyboard-submission-preview"><summary>查看提交给豆包的提示词</summary><p>{storyboardPromptWithReferences(row, displayNames)}</p></details> : null}
              {!saved && references.errors.length ? <p className="storyboard-row-error">{references.errors.join('；')}</p> : null}
              {saved?.message ? <div className="storyboard-row-message"><span>{saved.message}</span>{saved.state === 'failed' && saved.outputUrl ? <Button size="small" disabled={busy} icon={<ReloadOutlined />} onClick={(): void => { void run('重试保存', () => window.electronAPI.storyboardBatch.retryDownload(batch!.id, saved.id)); }}>重试保存</Button> : null}
                {saved.state === 'review' && saved.submissionIntentAt && !saved.submittedAt && !saved.outputUrl ? <Tooltip title={typeof window.electronAPI.storyboardBatch.restoreUnsent === 'function' ? '先核对豆包任务记录，恢复不会自动发送' : '需要重启工作台后使用恢复功能'}><Button disabled={busy || typeof window.electronAPI.storyboardBatch.restoreUnsent !== 'function'} icon={<ReloadOutlined />} onClick={(): void => restoreUnsent(saved)}>确认未提交，恢复草稿</Button></Tooltip> : null}
              </div> : null}
            </article>;
          })}</div>
        </section>
      </main>
      <aside className="storyboard-progress-panel" aria-label="分镜任务进度">
        <div className="storyboard-section-heading"><h2>任务进度</h2><span>{finished}/{shownRows.length}</span></div>
        <p className="storyboard-progress-summary">{batch ? `已就绪 ${ready} 条 · 已保存 ${finished} 条` : '准备后显示各分镜实时进度'}</p>
        <div className="storyboard-progress-list">{shownRows.map((row) => {
          const saved = batch?.rows.find((item) => item.id === row.id);
          const progress = saved?.progress;
          const label = saved?.state === 'ready' ? '已准备完毕' : saved ? states[saved.state] : '待准备';
          return <button type="button" key={row.id} className="storyboard-progress-item" onClick={(): void => document.getElementById(`storyboard-row-${row.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })}>
            <span className="storyboard-progress-title"><strong>分镜{row.number}</strong><span className={`storyboard-state is-${saved?.state || 'pending'}`}>{label}</span></span>
            {typeof progress === 'number' ? <span className="storyboard-progress-meter"><progress max={100} value={progress} aria-label={`分镜${row.number}豆包生成进度`} /><b>{progress}%</b></span> : null}
            {saved?.message ? <small>{saved.message}</small> : null}
          </button>;
        })}</div>
        <span className="storyboard-progress-note">读取豆包进度，完成后保存视频。</span>
      </aside>
    </div>
    <footer className="storyboard-footer"><span className="storyboard-footer-note">{batch ? batch.message : '全部节点就绪后，再确认批量发送'}</span><div className="storyboard-footer-actions">
      {batch && (batch.phase === 'running' || batch.phase === 'preparing' || batch.busy) ? <Button icon={<PauseOutlined />} loading={pausePending} onClick={(): void => { setPausing((current) => ({ ...current, [selectedId]: true })); void window.electronAPI.storyboardBatch.pause(batch.id).then(refresh).catch((reason: unknown) => setError(formatError(reason))).finally(() => setPausing((current) => ({ ...current, [selectedId]: false }))); }}>暂停后续操作</Button> : null}
      {canResume && batch && batch.rows.some(row => row.state !== 'done' && (row.submissionIntentAt || row.submittedAt)) ? <Tooltip title="继续查询和保存原节点；明确生成失败的节点自动重新生成，每个节点累计最多 5 次"><Button icon={<ReloadOutlined />} onClick={(): void => { void run('恢复查询', () => window.electronAPI.storyboardBatch.recover(batch.id)); }}>找回进度并继续查询 / 重试</Button></Tooltip> : null}
      {canPrepare ? <Button type="primary" size="large" icon={<CheckCircleOutlined />} disabled={!apiAvailable || !(batch?.rows.length || rows.length) || !(batch?.accountId || accountId) || busy} loading={operation === '准备节点'} onClick={prepare}>{batch ? '恢复准备全部节点' : `准备全部 ${shownRows.length || ''} 个节点`}</Button> : null}
      {batch && (batch.phase === 'ready' || batch.rows.some((row) => row.state === 'ready')) ? <Button type="primary" size="large" icon={<SendOutlined />} disabled={!allReady || busy} loading={operation === '批量发送'} onClick={submit}>批量发送 {ready} 个节点</Button> : null}
      {batch?.phase === 'done' ? <Button type="primary" icon={<FolderOpenOutlined />} onClick={(): void => onNavigate('artifacts')}>查看产物</Button> : null}
      {busy ? <span className="storyboard-working" role="status">{operation || batch?.message}</span> : null}
    </div></footer>
    <Modal title="导入分镜提示词" open={importOpen} width={760} okText={rows.length ? '替换草稿并拆分' : '拆分为视频节点'} cancelText="取消" onOk={importScript} onCancel={(): void => setImportOpen(false)}>
      <p className="storyboard-import-hint">分镜标题独占一行；用 @图片文件名 指定参考图，正文中的分镜引用不会被拆开。</p>
      {rows.length ? <Alert type="warning" showIcon message="导入会替换当前未提交的草稿清单，历史批次不受影响。" /> : null}
      <Input.TextArea className="storyboard-import-input" aria-label="分镜原文" rows={13} value={script} placeholder={'分镜001\n@人物 站在窗边，镜头缓慢推进。\n时长：5秒\n\n分镜002\n人物转身走向门口，跟随镜头。\n时长：8秒'} onChange={(event): void => { const value = event.target.value; updateDraft((current) => ({ ...current, script: value })); }} />
      {importError ? <Alert type="error" showIcon message={importError} /> : null}
    </Modal>
  </section>;
};
