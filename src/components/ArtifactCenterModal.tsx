import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, message, Modal, Select, Space, Spin, Table, Tag, Tooltip } from 'antd';
import {
  AudioOutlined,
  CheckOutlined,
  CloseOutlined,
  CloudDownloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DownloadJob, GenerationMode, Task, TaskArtifact } from '../types';
import { useAccountStore } from '../store/useAccountStore';
import { useTaskStore } from '../store/useTaskStore';
import { useProjectStore } from '../store/useProjectStore';
import { decodeDataUrl, getLocalArtifactPath } from '../utils/artifactPreview';
import { getImageArtifactFormatRank, getImageArtifactIdentity } from '../utils/artifactKind';

interface ArtifactRecord {
  key: string;
  task: Task;
  artifact: TaskArtifact;
  localJob?: DownloadJob;
  textResult?: string;
}

type ArtifactViewType = 'video' | 'image' | 'text' | 'audio';

const ARTIFACT_VIEW_TYPES: Array<{ key: ArtifactViewType; label: string; icon: React.ReactNode }> = [
  { key: 'video', label: '视频', icon: <VideoCameraOutlined aria-hidden="true" /> },
  { key: 'image', label: '图片', icon: <PictureOutlined aria-hidden="true" /> },
  { key: 'text', label: '文本', icon: <FileTextOutlined aria-hidden="true" /> },
  { key: 'audio', label: '音频', icon: <AudioOutlined aria-hidden="true" /> },
];

function getArtifactViewType(record: ArtifactRecord): ArtifactViewType {
  if (record.textResult !== undefined || record.task.mode === 'chat') return 'text';
  if (record.task.mode === 'music') return 'audio';
  if (record.artifact.kind === 'video') return 'video';
  if (record.artifact.kind === 'image') return 'image';
  return 'text';
}

function getArtifactModeLabel(record: ArtifactRecord): string {
  const type = getArtifactViewType(record);
  if (type === 'video') {
    const model = record.task.videoConfig?.model;
    const duration = record.task.videoConfig?.duration;
    const ratio = record.task.videoConfig?.aspectRatio;
    return [model, duration, ratio].filter(Boolean).join(' · ') || '视频产物';
  }
  if (type === 'image') return '图片产物';
  if (type === 'audio') return '音频产物';
  return '对话结果';
}

function getDateGroupLabel(value: string): '今天' | '昨天' | '更早' {
  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (startOfDate === startOfToday) return '今天';
  if (startOfDate === startOfToday - day) return '昨天';
  return '更早';
}

function formatArtifactDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface ArtifactCenterModalProps {
  open: boolean;
  onClose: () => void;
  /** 在工作区主区域渲染，不创建遮罩层；业务查询、预览和下载逻辑保持一致。 */
  embedded?: boolean;
}

const VALIDATION_LABELS = {
  unknown: { label: '未验证', color: 'default' },
  valid: { label: '有效', color: 'success' },
  expired: { label: '已过期', color: 'warning' },
  invalid: { label: '不可用', color: 'error' },
} as const;

export const ArtifactCenterModal: React.FC<ArtifactCenterModalProps> = ({ open, onClose, embedded = false }) => {
  const tasks = useTaskStore((state) => state.tasks);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const accounts = useAccountStore((state) => state.accounts);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<GenerationMode | 'all'>('all');
  const [validity, setValidity] = useState<'all' | 'unknown' | 'valid' | 'expired' | 'invalid'>('all');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactRecord | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewConversionAttempted, setPreviewConversionAttempted] = useState(false);
  const previewRequestRef = useRef(0);
  const previewConversionInFlightRef = useRef(false);
  const previewUsingCompatibleFormatRef = useRef(false);
  const previewObjectUrlRef = useRef<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewClosingRef = useRef(false);
  const previewOpenRef = useRef(open);
  // Keep this current during render so an in-flight IPC result cannot reopen
  // media after the outer modal has started closing.
  previewOpenRef.current = open;

  const revokePreviewObjectUrl = useCallback((): void => {
    if (!previewObjectUrlRef.current) return;
    URL.revokeObjectURL(previewObjectUrlRef.current);
    previewObjectUrlRef.current = null;
  }, []);

  const stopPreviewMedia = useCallback((): void => {
    const video = previewVideoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch { /* the element may already be detached */ }
      previewVideoRef.current = null;
    }
    revokePreviewObjectUrl();
  }, [revokePreviewObjectUrl]);

  /**
   * Convert an IPC data URL to a Blob URL without fetch(). The renderer CSP
   * intentionally omits data: from connect-src, so fetch(data:) is rejected
   * even though the payload itself is valid.
   */
  const makeBlobUrl = async (dataUrl: string): Promise<string> => {
    const { mimeType, bytes } = decodeDataUrl(dataUrl);
    // Copy into an ArrayBuffer so TypeScript and Chromium agree on the BlobPart
    // type even when the typed-array lib models buffers as ArrayBufferLike.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blobUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    revokePreviewObjectUrl();
    previewObjectUrlRef.current = blobUrl;
    return blobUrl;
  };

  const refreshDownloads = useCallback(async (): Promise<void> => {
    // listDownloads 会把旧版 manual-* 成功记录保守归档到唯一匹配任务；
    // 随后刷新任务状态，确保本次打开产物中心即可看到新 artifact。
    const jobs = await window.electronAPI.tasks.listDownloads();
    await loadTasks();
    setDownloads(jobs);
  }, [loadTasks]);
  useEffect(() => {
    if (open) void refreshDownloads();
  }, [open, refreshDownloads]);

  const allRecords = useMemo(() => {
    const result: ArtifactRecord[] = [];
    for (const task of tasks) {
      if ((task.projectId || 'default-project') !== activeProjectId) continue;
      for (const artifact of task.artifacts || []) {
        const localJob = [...downloads].reverse().find((job) => job.taskId === task.id && job.url === artifact.url && job.status === 'done');
        result.push({ key: `${task.id}:${artifact.id}`, task, artifact, localJob });
      }
      // 对话任务没有媒体 URL，使用任务结果创建一个内存中的只读记录；
      // 不写入伪造的下载地址，也不影响图片/视频产物模型。
      if (task.mode === 'chat' && task.status === 'done' && task.result?.trim()) {
        result.push({
          key: `${task.id}:conversation`,
          task,
          artifact: {
            id: `conversation-${task.id}`,
            url: `conversation://${task.id}`,
            kind: 'file',
            source: 'page',
            conversationUrl: task.runtime?.conversationUrl,
            discoveredAt: task.updatedAt,
            validation: { state: 'valid', checkedAt: task.updatedAt },
          },
          textResult: task.result.trim(),
        });
      }
    }
    // 同一任务可能同时收到 image_raw.png 与 image_raw.heic 两个格式。
    // HEIC 在当前 Electron 预览器中不可直接显示，只保留同一资源中
    // 优先级最高且可预览的记录；不同资源和视频记录保持原样。
    const deduplicated = new Map<string, ArtifactRecord>();
    for (const record of result) {
      if (record.artifact.kind !== 'image') {
        deduplicated.set(`record:${record.key}`, record);
        continue;
      }
      const identity = `${record.task.id}:image:${getImageArtifactIdentity(record.artifact.url)}`;
      const existing = deduplicated.get(identity);
      if (!existing) {
        deduplicated.set(identity, record);
        continue;
      }
      const candidateRank = getImageArtifactFormatRank(record.artifact.url);
      const existingRank = getImageArtifactFormatRank(existing.artifact.url);
      const candidateIsPreferred = candidateRank < existingRank
        || (candidateRank === existingRank
          && record.artifact.discoveredAt > existing.artifact.discoveredAt);
      if (candidateIsPreferred) deduplicated.set(identity, record);
    }
    return [...deduplicated.values()]
      .sort((a, b) => b.artifact.discoveredAt.localeCompare(a.artifact.discoveredAt));
  }, [activeProjectId, downloads, tasks]);

  const records = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return allRecords
      // 图片/视频筛选按真实产物类型，而不是任务模式。一个视频任务
      // 可能同时产生视频与封面图，按 task.mode 会把封面误列到视频分类。
      .filter((record) => mode === 'all' || (mode === 'image' || mode === 'video' ? record.artifact.kind === mode : record.task.mode === mode))
      .filter((record) => validity === 'all' || (record.artifact.validation?.state || 'unknown') === validity)
      .filter((record) => !normalizedQuery
        || record.task.prompt.toLowerCase().includes(normalizedQuery)
        || record.task.id.includes(normalizedQuery)
        || record.textResult?.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => b.artifact.discoveredAt.localeCompare(a.artifact.discoveredAt));
  }, [allRecords, mode, query, validity]);

  const typeCounts = useMemo(() => {
    const counts: Record<ArtifactViewType, number> = { video: 0, image: 0, text: 0, audio: 0 };
    for (const record of allRecords) counts[getArtifactViewType(record)] += 1;
    return counts;
  }, [allRecords]);

  const groupedRecords = useMemo(() => {
    const groups: Record<'今天' | '昨天' | '更早', ArtifactRecord[]> = { 今天: [], 昨天: [], 更早: [] };
    for (const record of records) groups[getDateGroupLabel(record.artifact.discoveredAt)].push(record);
    return (['今天', '昨天', '更早'] as const)
      .map((label) => ({ label, records: groups[label] }))
      .filter((group) => group.records.length > 0);
  }, [records]);

  const storageStats = useMemo(() => {
    const downloaded = allRecords.filter((record) => Boolean(record.localJob)).length;
    return {
      downloaded,
      total: allRecords.length,
      percent: allRecords.length > 0 ? Math.round((downloaded / allRecords.length) * 100) : 0,
    };
  }, [allRecords]);

  const validate = async (record: ArtifactRecord) => {
    if (record.textResult !== undefined) return;
    setCheckingId(record.artifact.id);
    try {
      const result = await window.electronAPI.tasks.validateArtifact(record.task.id, record.artifact.id);
      await loadTasks();
      if (result.success) message.success('产物地址有效');
      else message.warning(result.error || '产物地址不可用或已过期');
    } finally {
      setCheckingId(null);
    }
  };

  const download = async (record: ArtifactRecord) => {
    if (record.textResult !== undefined) {
      message.info('对话记录是文本内容，无需下载');
      return;
    }
    const settings = await window.electronAPI.settings.get();
    const result = await window.electronAPI.tasks.downloadOutputs([{
      taskId: record.task.id,
      prompt: record.task.prompt,
      outputs: [record.artifact.url],
      accountId: record.task.assignedAccountId,
      mode: record.task.mode,
    }], settings.downloadDir || undefined);
    await refreshDownloads();
    if (result.success) message.success('产物下载完成');
    else message.error(result.error || '下载失败');
  };

  /**
   * 本地下载完成后优先经 IPC 读取为 data URL，避免签名 CDN 地址过期、
   * 跨域或被账号 Session 拦截；本地文件读取失败时仍回退到原始地址。
   */
  const openPreview = async (record: ArtifactRecord): Promise<void> => {
    if (!previewOpenRef.current) return;
    const requestId = ++previewRequestRef.current;
    const localPath = getLocalArtifactPath(record.localJob);

    // Do not mount a video element until its local source is ready. Mounting
    // the original remote/HEVC URL first creates a late error event that can
    // race with the compatible preview and overwrite the working source.
    previewClosingRef.current = false;
    stopPreviewMedia();
    setPreview(record);
    setPreviewUrl(null);
    setPreviewConversionAttempted(record.artifact.kind === 'video' && Boolean(localPath));
    previewConversionInFlightRef.current = false;
    previewUsingCompatibleFormatRef.current = false;
    revokePreviewObjectUrl();

    if (record.textResult !== undefined) return;

    if (!localPath) {
      setPreviewUrl(record.artifact.url);
      return;
    }

    try {
      // Video files may be HEVC, which Electron 33 cannot decode on Windows.
      // Prepare the H.264/AAC derivative before creating the <video> element;
      // the downloaded source remains untouched on disk.
      if (record.artifact.kind === 'video') {
        previewConversionInFlightRef.current = true;
        const result = await window.electronAPI.tasks.prepareVideoPreview(localPath);
        if (requestId !== previewRequestRef.current || !previewOpenRef.current) return;
        if (!result.success || !result.data) {
          setPreviewUrl(record.artifact.url);
          message.error(result.error || '无法生成兼容预览，请确认系统已配置 ffmpeg');
          return;
        }

        const compatibleUrl = await makeBlobUrl(result.data);
        if (requestId !== previewRequestRef.current || !previewOpenRef.current) {
          // A conversion may finish after the user closed the modal or chose
          // another artifact. Revoke only this request's URL.
          URL.revokeObjectURL(compatibleUrl);
          if (previewObjectUrlRef.current === compatibleUrl) previewObjectUrlRef.current = null;
          return;
        }
        previewUsingCompatibleFormatRef.current = true;
        setPreviewUrl(compatibleUrl);
        message.info('已切换为兼容预览格式，原始无水印文件未修改');
        return;
      }

      const result = await window.electronAPI.tasks.readFileAsBase64(localPath);
      if (requestId !== previewRequestRef.current || !previewOpenRef.current) return;
      if (result.success && result.data) {
        setPreviewUrl(result.data);
      } else {
        setPreviewUrl(record.artifact.url);
        message.warning('本地产物读取失败，已回退在线地址');
      }
    } catch (error) {
      if (requestId !== previewRequestRef.current || !previewOpenRef.current) return;
      console.warn('[ArtifactCenter] 读取本地产物失败，回退在线地址', error);
      setPreviewUrl(record.artifact.url);
      message.warning('本地产物读取失败，已回退在线地址');
    } finally {
      if (requestId === previewRequestRef.current) {
        previewConversionInFlightRef.current = false;
      }
    }
  };

  const closePreview = useCallback((): void => {
    previewClosingRef.current = true;
    ++previewRequestRef.current;
    previewConversionInFlightRef.current = false;
    previewUsingCompatibleFormatRef.current = false;
    stopPreviewMedia();
    setPreview(null);
    setPreviewUrl(null);
    setPreviewConversionAttempted(false);
  }, [stopPreviewMedia]);

  // Closing the outer artifact modal must also close a nested preview modal.
  useEffect(() => {
    if (open) return;
    closePreview();
  }, [open, closePreview]);

  // Release media even if the component is removed while a modal transition
  // is in progress (for example, when the application window is closed).
  useEffect(() => () => {
    ++previewRequestRef.current;
    previewOpenRef.current = false;
    const video = previewVideoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch { /* best effort during unmount */ }
    }
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
  }, []);

  const handlePreviewError = async (): Promise<void> => {
    if (!preview) return;
    if (previewClosingRef.current) return;
    // Chromium may emit a late error for the previous source while the
    // compatible copy is being prepared; never let that stale event replace it.
    if (previewConversionInFlightRef.current) return;
    if (previewUsingCompatibleFormatRef.current) {
      message.error('兼容预览仍无法播放，请检查视频文件是否完整');
      return;
    }
    if (preview.artifact.kind === 'video' && previewConversionAttempted) {
      message.error('兼容预览无法播放，原始文件仍保留在下载目录');
      return;
    }
    message.error('产物无法预览，可能是地址已过期或当前播放器不支持该编码');
  };

  const columns: ColumnsType<ArtifactRecord> = [
    {
      title: '产物', width: 90,
      render: (_, record) => <Tag color={record.textResult !== undefined ? 'cyan' : record.artifact.kind === 'video' ? 'magenta' : 'blue'}>{record.textResult !== undefined ? '对话' : record.artifact.kind === 'video' ? '视频' : record.artifact.kind === 'image' ? '图片' : '文件'}</Tag>,
    },
    {
      title: '任务', ellipsis: true,
      render: (_, record) => (
        <Tooltip title={record.task.prompt}>
          <span>{record.task.prompt.slice(0, 48)}{record.task.prompt.length > 48 ? '...' : ''}</span>
        </Tooltip>
      ),
    },
    {
      title: '账号', width: 110,
      render: (_, record) => accounts.find((account) => account.id === record.task.assignedAccountId)?.name || '未指派',
    },
    {
      title: '状态', width: 105,
      render: (_, record) => {
        const validation = VALIDATION_LABELS[record.artifact.validation?.state || 'unknown'];
        return <Space size={4}><Tag color={validation.color}>{validation.label}</Tag>{record.localJob && <Tag color="green">本地</Tag>}</Space>;
      },
    },
    {
      title: '发现时间', width: 145,
      render: (_, record) => new Date(record.artifact.discoveredAt).toLocaleString('zh-CN'),
    },
    {
      title: '操作', width: 155,
      render: (_, record) => (
        <Space size={2}>
          <Tooltip title="预览"><Button size="small" icon={<PlayCircleOutlined />} onClick={() => void openPreview(record)} /></Tooltip>
          <Tooltip title="验证地址"><Button size="small" disabled={record.textResult !== undefined} loading={checkingId === record.artifact.id} icon={<ReloadOutlined />} onClick={() => void validate(record)} /></Tooltip>
          <Tooltip title="下载"><Button size="small" disabled={record.textResult !== undefined} icon={<CloudDownloadOutlined />} onClick={() => void download(record)} /></Tooltip>
          <Tooltip title="打开原对话"><Button size="small" icon={<LinkOutlined />} disabled={!record.artifact.conversationUrl} onClick={() => window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task: record.task } }))} /></Tooltip>
        </Space>
      ),
    },
  ];

  const content = (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示词或任务 ID" style={{ width: 280 }} allowClear />
        <Select value={mode} onChange={setMode} style={{ width: 130 }} options={[
          { value: 'all', label: '全部类型' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }, { value: 'chat', label: '对话' }, { value: 'music', label: '音乐' },
        ]} />
        <Select value={validity} onChange={setValidity} style={{ width: 130 }} options={[
          { value: 'all', label: '全部状态' }, { value: 'unknown', label: '未验证' }, { value: 'valid', label: '有效' }, { value: 'expired', label: '已过期' }, { value: 'invalid', label: '不可用' },
        ]} />
      </Space>
      {records.length === 0 ? <Empty description="没有符合条件的产物" /> : <Table columns={columns} dataSource={records} size="small" pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: 980 }} />}
    </>
  );

  const activeViewType: ArtifactViewType | 'all' = mode === 'chat' ? 'text' : mode === 'music' ? 'audio' : mode;
  const setArtifactViewType = (value: ArtifactViewType | 'all'): void => {
    setMode(value === 'all' ? 'all' : value === 'text' ? 'chat' : value === 'audio' ? 'music' : value);
  };
  const artifactTabs: Array<{ key: ArtifactViewType | 'all'; label: string; count: number }> = [
    { key: 'all', label: '全部', count: allRecords.length },
    ...ARTIFACT_VIEW_TYPES.map((item) => ({ key: item.key, label: item.label, count: typeCounts[item.key] })),
  ];

  const renderArtifactCard = (record: ArtifactRecord): React.ReactElement => {
    const type = getArtifactViewType(record);
    const typeConfig = ARTIFACT_VIEW_TYPES.find((item) => item.key === type) || ARTIFACT_VIEW_TYPES[2];
    const validation = VALIDATION_LABELS[record.artifact.validation?.state || 'unknown'];
    const accountName = accounts.find((account) => account.id === record.task.assignedAccountId)?.name || '未指派账号';
    const title = record.task.prompt.trim() || `${typeConfig.label}产物`;
    const isImage = type === 'image' && /^https?:|^data:|^blob:/.test(record.artifact.url);
    const isVideo = type === 'video' && /^https?:|^data:|^blob:/.test(record.artifact.url);
    return (
      <article className="artifact-card" key={record.key}>
        <div className={`artifact-thumb artifact-thumb--${type}`}>
          <div className="artifact-thumb-icon" aria-hidden="true">{typeConfig.icon}</div>
          {isImage && (
            <img
              src={record.artifact.url}
              alt=""
              loading="lazy"
              onError={(event) => { event.currentTarget.style.display = 'none'; }}
            />
          )}
          {isVideo && (
            <video
              className="artifact-thumb-video"
              src={record.artifact.url}
              preload="metadata"
              muted
              playsInline
              aria-hidden="true"
              onLoadedData={(event) => { event.currentTarget.currentTime = 0; }}
              onError={(event) => { event.currentTarget.style.display = 'none'; }}
            />
          )}
          <span className="artifact-thumb-type">{typeConfig.label}</span>
          <span className={`artifact-card-status artifact-card-status--${record.artifact.validation?.state || 'unknown'}`}>
            {record.artifact.validation?.state === 'valid' && <CheckOutlined aria-hidden="true" />}
            {validation.label}
          </span>
        </div>
        <div className="artifact-card-body">
          <h3 title={title}>{title}</h3>
          <p className="artifact-card-meta">{getArtifactModeLabel(record)}</p>
          <p className="artifact-card-meta">{accountName} · {formatArtifactDate(record.artifact.discoveredAt)}</p>
          {record.localJob && <p className="artifact-card-local"><FolderOpenOutlined aria-hidden="true" /> 已下载到本地</p>}
          <div className="artifact-card-actions">
            <Button size="small" icon={<PlayCircleOutlined aria-hidden="true" />} onClick={() => void openPreview(record)} aria-label={`预览${title}`}>预览</Button>
            <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} disabled={record.textResult !== undefined} loading={checkingId === record.artifact.id} onClick={() => void validate(record)} aria-label={`校验${title}`}>校验</Button>
            <Button size="small" icon={<CloudDownloadOutlined aria-hidden="true" />} disabled={record.textResult !== undefined} onClick={() => void download(record)} aria-label={`下载${title}`}>下载</Button>
            {record.artifact.conversationUrl && (
              <Tooltip title="打开原对话">
                <Button size="small" icon={<LinkOutlined aria-hidden="true" />} onClick={() => window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task: record.task } }))} aria-label={`打开${title}的原对话`} />
              </Tooltip>
            )}
          </div>
        </div>
      </article>
    );
  };

  const artifactWorkspace = (
    <section className="workspace-full-page workspace-artifact-page artifact-center-shell" aria-label="产物中心">
      <header className="artifact-center-topbar">
        <div>
          <div className="workspace-page-kicker">LIBRARY / OUTPUTS</div>
          <h1>产物中心 <span>{records.length}</span></h1>
          <p>查看任务产物、校验地址并管理本地下载记录。</p>
        </div>
        <div className="artifact-center-topbar-actions">
          <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={() => void refreshDownloads()} aria-label="刷新产物中心">刷新</Button>
          <Button icon={<CloseOutlined aria-hidden="true" />} onClick={() => { closePreview(); onClose(); }} aria-label="关闭产物中心" />
        </div>
      </header>
      <div className="artifact-center-filterbar">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          prefix={<SearchOutlined aria-hidden="true" />}
          placeholder="搜索提示词、任务或账号"
          aria-label="搜索提示词、任务或账号"
          allowClear
        />
        <Select
          value={validity}
          onChange={setValidity}
          aria-label="筛选产物状态"
          options={[
            { value: 'all', label: '状态　全部' },
            { value: 'unknown', label: '状态　未验证' },
            { value: 'valid', label: '状态　有效' },
            { value: 'expired', label: '状态　已过期' },
            { value: 'invalid', label: '状态　不可用' },
          ]}
        />
      </div>
      <div className="artifact-center-layout">
        <aside className="artifact-center-sidebar" aria-label="产物类型筛选">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            prefix={<SearchOutlined aria-hidden="true" />}
            placeholder="搜索产物"
            aria-label="搜索产物"
            allowClear
          />
          <div className="artifact-sidebar-heading">
            <strong>产物类型</strong>
            <span>按真实任务结果分类</span>
          </div>
          <nav className="artifact-type-list" aria-label="按类型筛选">
            {ARTIFACT_VIEW_TYPES.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`artifact-type-item${activeViewType === item.key ? ' is-active' : ''}`}
                aria-pressed={activeViewType === item.key}
                onClick={() => setArtifactViewType(item.key)}
              >
                {item.icon}<span>{item.label}</span><strong>{typeCounts[item.key]}</strong>
              </button>
            ))}
          </nav>
          <div className="artifact-storage" aria-label="本地下载记录">
            <div className="artifact-storage-head"><span>本地下载记录</span><strong>{storageStats.downloaded} 项</strong></div>
            <div className="artifact-storage-track"><span style={{ width: `${storageStats.percent}%` }} /></div>
            <small>来源：任务产物与对话结果</small>
          </div>
        </aside>
        <main className="artifact-center-main">
          <div className="artifact-center-tabs" role="tablist" aria-label="产物类型标签">
            {artifactTabs.map((item) => (
              <button
                type="button"
                role="tab"
                key={item.key}
                className={`artifact-center-tab${activeViewType === item.key ? ' is-active' : ''}`}
                aria-selected={activeViewType === item.key}
                onClick={() => setArtifactViewType(item.key)}
              >
                {item.label}<span>{item.count}</span>
              </button>
            ))}
          </div>
          {groupedRecords.length === 0 ? (
            <div className="artifact-empty-state"><Empty description="没有符合条件的产物" /></div>
          ) : (
            groupedRecords.map((group) => (
              <section className="artifact-date-section" key={group.label}>
                <div className="artifact-date-heading"><h2>{group.label}</h2><span>{group.records.length} 项</span></div>
                <div className="artifact-card-grid">{group.records.map(renderArtifactCard)}</div>
              </section>
            ))
          )}
        </main>
      </div>
    </section>
  );

  const previewContent = preview?.textResult !== undefined
    ? <div style={{ maxHeight: '70vh', overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.7, padding: 16 }}>{preview.textResult}</div>
    : preview?.artifact.kind === 'video'
    ? <div style={{ position: 'relative', minHeight: 180, background: '#000' }}>
      {previewUrl && <video
        ref={previewVideoRef}
        key={previewUrl}
        src={previewUrl}
        controls
        preload="metadata"
        onError={() => void handlePreviewError()}
        style={{ width: '100%', maxHeight: '75vh', background: '#000' }}
      />}
      {!previewUrl && <div style={{ minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Space direction="vertical" align="center">
          <Spin />
          <Alert type="info" showIcon message="正在准备兼容预览，不会修改原始视频" />
        </Space>
      </div>}
    </div>
    : preview && <img src={previewUrl || preview.artifact.url} alt="产物预览" onError={handlePreviewError} style={{ width: '100%', maxHeight: '75vh', objectFit: 'contain' }} />;

  return (
    <>
      {embedded ? (
        artifactWorkspace
      ) : (
        <Modal title={`产物中心 (${records.length})`} open={open} onCancel={() => { closePreview(); onClose(); }} destroyOnClose footer={null} width={1120}>
          {content}
        </Modal>
      )}
      {/* 预览属于上下文操作，嵌入式产物页仍使用二级对话框承载媒体，避免导航页被替换。 */}
      <Modal open={open && !!preview} onCancel={closePreview} destroyOnClose footer={null} width={preview?.artifact.kind === 'video' ? 820 : 680}>
        {previewContent}
      </Modal>
    </>
  );
};
