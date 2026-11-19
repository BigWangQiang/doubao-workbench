/**
 * src/components/TaskConsole.tsx
 * 任务调度控制台 — V3 多模式支持
 *
 * 支持：
 * - 批量添加任务 + 选择生成模式（对话/图片/视频/音乐）
 * - 指派账号、启动自动化、查看状态
 * - 任务列表中显示模式标签
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Button, Select, Input, Modal, Dropdown, Space, Segmented, Tooltip, message, Switch } from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  SyncOutlined,
  PictureOutlined,
  AudioOutlined,
  EyeOutlined,
  ReloadOutlined,
  EditOutlined,
  StopOutlined,
  FileExcelOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useTaskStore } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { useProjectStore } from '../store/useProjectStore';
import TaskDetailModal from './TaskDetailModal';
import { BatchDeleteDialog } from './BatchDeleteDialog';
import { taskDeletionBlocker, type DeleteItemResult } from '../utils/batchDeletion';
import type { AccountPlatform, Task, TaskUpdateInput } from '../types';
import { isTaskVisibleInProject } from '../utils/taskVisibility';
import {
  TASK_STATUS_CONFIG,
  GENERATION_MODE_CONFIG,
  VIDEO_MODEL_LABELS,
  VIDEO_MODEL_COST,
  DEFAULT_VIDEO_CONFIG,
  getDefaultVideoConfig,
  getVideoModelsForPlatform,
  isVideoModelAvailableForPlatform,
  type TaskStatus,
  type GenerationMode,
  type VideoModel,
  type VideoDuration,
  type VideoAspectRatio,
} from '../types';
import { evaluateVideoCapability } from '../utils/videoCapability';
import { buildManualAssignmentOptions } from '../utils/accountAssignment';
import { buildAutoAssignmentPlan } from '../utils/autoAssignment';
import { requiresSubmissionReconciliation } from '../utils/realSendStateMachine';
import { decideCsvDrop } from '../utils/csvDrop';
import { getAllowedGenerationModes, rejectDolaUnsupportedMode } from '../utils/dolaCapabilityPolicy';
import {
  MAX_REFERENCE_IMAGE_COUNT,
} from '../utils/uploadReadiness';
import { REFERENCE_AUDIO_LIMIT, REFERENCE_VIDEO_LIMIT } from '../utils/referenceMaterialLimits';

const { TextArea } = Input;

interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  targetPlatform?: AccountPlatform;
  mode: GenerationMode;
  videoConfig?: Task['videoConfig'];
  attachments: string[];
  referenceVideos?: string[];
  audioAttachment?: string;
  audioAttachments?: string[];
}

function expandPromptVariables(promptText: string, rowsText: string): string {
  const rows = rowsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length === 0) return promptText;
  const prompts = promptText.split('%%%%%%%%%%').map((item) => item.trim()).filter(Boolean);
  const expanded: string[] = [];
  for (const row of rows) {
    const values = new Map<string, string>();
    for (const pair of row.split(/[;；]/)) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    for (const prompt of prompts) {
      expanded.push(prompt.replace(/\{\{([^}]+)\}\}/g, (match, key) => values.get(String(key).trim()) ?? match));
    }
  }
  return expanded.join('\n%%%%%%%%%%\n');
}

const STANDARD_VIDEO_DURATIONS: readonly VideoDuration[] = [
  '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s',
];

/** 两个平台都展示 30 秒；最终是否可用仍由对应页面的真实可见控件回读确认。 */
function getVideoDurationOptions(_platform: AccountPlatform): Array<{ label: string; value: VideoDuration }> {
  const durations = [...STANDARD_VIDEO_DURATIONS, '30s' as const];
  return durations.map((duration) => ({ label: `${Number.parseInt(duration, 10)} 秒`, value: duration }));
}

function canRecoverRunningVideo(task: Task | undefined): boolean {
  return !!task
    && task.mode === 'video'
    && !!task.assignedAccountId
    && !!task.runtime?.submittedAt
    && !!task.runtime?.conversationUrl
    && ['executing', 'generating', 'manual_submission_observing'].includes(task.status);
}

// ==================== 模式选择组件 ====================

const ModeSelector: React.FC<{
  value: GenerationMode;
  onChange: (mode: GenerationMode) => void;
  allowedModes?: readonly GenerationMode[];
}> = ({ value, onChange, allowedModes = Object.keys(GENERATION_MODE_CONFIG) as GenerationMode[] }) => {
  const options = Object.entries(GENERATION_MODE_CONFIG)
    .filter(([key]) => allowedModes.includes(key as GenerationMode))
    .map(([key, cfg]) => ({
    label: (
      <div className="flex flex-col items-center py-1 px-2">
        <span className="text-lg">{cfg.icon}</span>
        <span className="text-xs mt-0.5">{cfg.label}</span>
      </div>
    ),
    value: key,
    }));

  return (
    <Segmented
      value={value}
      onChange={(val) => onChange(val as GenerationMode)}
      options={options}
      block
      style={{
        background: '#1a1a24',
        padding: '4px',
        borderRadius: 10,
      }}
    />
  );
};

// ==================== 组件 ====================

const TaskConsole: React.FC = () => {
  const {
    tasks: allTasks,
    addTasks,
    importCsv,
    assignTask,
    deleteTask,
    batchPause,
    getCompletedOutputs,
    startAutomation,
    accountBusy,
    clearError,
    error,
    updateTask,
    processQueue,
  } = useTaskStore();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const activeProject = useProjectStore((state) => state.projects.find((project) => project.id === state.activeProjectId));
  const tasks = allTasks.filter((task) => isTaskVisibleInProject(task, activeProjectId));
  const executingTasks = useTaskStore(state => state.executingTasks);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const deleteBatchTask = async (id: string): Promise<DeleteItemResult> => {
    const state = useTaskStore.getState();
    const task = state.tasks.find(item => item.id === id);
    if (task && !isTaskVisibleInProject(task, useProjectStore.getState().activeProjectId)) return { success: false, error: '当前项目已切换，请重新选择任务' };
    const blocker = taskDeletionBlocker(task, Object.values(state.executingTasks));
    if (blocker) return { success: false, error: blocker };
    const success = await deleteTask(id);
    return { success, error: success ? undefined : useTaskStore.getState().error || '任务删除失败' };
  };

  const accounts = useAccountStore((s) => s.accounts);
  const selectedAccountId = useAccountStore((s) => s.selectedAccountId);
  const selectAccount = useAccountStore((s) => s.selectAccount);

  const [inputText, setInputText] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<AccountPlatform>('doubao');
  const [selectedMode, setSelectedMode] = useState<GenerationMode>('chat');
  const [videoConfig, setVideoConfig] = useState({ ...DEFAULT_VIDEO_CONFIG });
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachmentBase64s, setAttachmentBase64s] = useState<Record<string, string>>({});
  const [referenceVideos, setReferenceVideos] = useState<string[]>([]);
  const [audioAttachment, setAudioAttachment] = useState<string>('');
  const [audioAttachments, setAudioAttachments] = useState<string[]>([]);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [autoAssign, setAutoAssign] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editingPrompt, setEditingPrompt] = useState('');
  const [editingVideoConfig, setEditingVideoConfig] = useState({ ...DEFAULT_VIDEO_CONFIG });
  const [editingAttachments, setEditingAttachments] = useState<string[]>([]);
  const [editingAttachmentBase64s, setEditingAttachmentBase64s] = useState<Record<string, string>>({});
  const [editingReferenceVideos, setEditingReferenceVideos] = useState<string[]>([]);
  const [editingAudioAttachment, setEditingAudioAttachment] = useState('');
  const [editingAudioAttachments, setEditingAudioAttachments] = useState<string[]>([]);
  const [variableRows, setVariableRows] = useState('');
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [isCsvDragging, setIsCsvDragging] = useState(false);
  const [isCsvImporting, setIsCsvImporting] = useState(false);
  const csvDragDepth = useRef(0);

  const handlePlatformChange = (platform: AccountPlatform) => {
    setSelectedPlatform(platform);
    if (!getAllowedGenerationModes(platform).includes(selectedMode)) {
      setSelectedMode('video');
    }
    setVideoConfig((current) => {
      const next = { ...current };
      // Dola 当前不提供 Mini；只有在当前模型确实不可用时才切到 Dola 默认值，
      // 保留用户主动选择的 2.5/Fast，不做跨模型静默降级。
      if (!isVideoModelAvailableForPlatform(platform, next.model)) {
        next.model = getDefaultVideoConfig(platform).model;
      }
      return next;
    });
  };

  const openAddTaskModal = useCallback(() => {
    // 从当前账号池进入添加任务时，默认使用该账号的平台，避免 Dola 账号被误回退到豆包池。
    const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
    const platform: AccountPlatform = selectedAccount?.platform === 'dola' ? 'dola' : 'doubao';
    setSelectedPlatform(platform);
    setVideoConfig(getDefaultVideoConfig(platform));
    setAddModalOpen(true);
  }, [accounts, selectedAccountId]);

  useLayoutEffect(() => {
    const handleWorkspaceNewTask = () => openAddTaskModal();
    window.addEventListener('workspace-open-new-task', handleWorkspaceNewTask);
    return () => window.removeEventListener('workspace-open-new-task', handleWorkspaceNewTask);
  }, [openAddTaskModal]);

  useEffect(() => {
    void window.electronAPI.settings.get().then((settings) => {
      setTemplates(Array.isArray(settings.taskTemplates) ? settings.taskTemplates : []);
      setAutoAssign(settings.autoAssignEnabled === true);
    });
  }, []);

  const persistTemplates = async (nextTemplates: TaskTemplate[]) => {
    const settings = await window.electronAPI.settings.get();
    await window.electronAPI.settings.save({ ...settings, taskTemplates: nextTemplates });
    setTemplates(nextTemplates);
  };

  const saveCurrentTemplate = async () => {
    if (!templateName.trim()) return;
    const template: TaskTemplate = {
      id: `template-${Date.now()}`,
      name: templateName.trim(),
      prompt: inputText,
      targetPlatform: selectedPlatform,
      mode: selectedMode,
      videoConfig: selectedMode === 'video' ? { ...videoConfig } : undefined,
      attachments: [...attachments],
      referenceVideos: [...referenceVideos],
      audioAttachment: audioAttachment || undefined,
      audioAttachments: [...audioAttachments],
    };
    await persistTemplates([...templates, template]);
    setTemplateName('');
    setTemplateModalOpen(false);
    message.success('任务模板已保存');
  };

  const applyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setInputText(template.prompt);
    const platform = template.targetPlatform || 'doubao';
    setSelectedPlatform(platform);
    setSelectedMode(getAllowedGenerationModes(platform).includes(template.mode) ? template.mode : 'video');
    setVideoConfig({ ...(template.videoConfig || DEFAULT_VIDEO_CONFIG) });
    setAttachments([...template.attachments]);
    setReferenceVideos([...(template.referenceVideos || [])]);
    const templateAudios = [...new Set([...(template.audioAttachments || []), template.audioAttachment || ''].filter(Boolean))];
    setAudioAttachments(templateAudios);
    setAudioAttachment(templateAudios[0] || '');
    setAttachmentBase64s({});
    for (const filePath of template.attachments) {
      void window.electronAPI.tasks.readFileAsBase64(filePath).then((result) => {
        if (result.success && result.data) {
          setAttachmentBase64s((current) => ({ ...current, [filePath]: result.data! }));
        }
      });
    }
  };

  // ---- 自动分配账号 ----
  const autoAssignTasks = useCallback(async (newTasks: Task[]) => {
    const plan = buildAutoAssignmentPlan(newTasks, allTasks, accounts);
    let assigned = 0;
    let unassigned = plan.unassignedTaskIds.length;
    for (const assignment of plan.assignments) {
      if (await assignTask(assignment.taskId, assignment.accountId)) assigned++;
      else unassigned++;
    }
    return { assigned, unassigned };
  }, [accounts, allTasks, assignTask]);

  // ---- 添加任务 ----

  const handleAddTasks = useCallback(async () => {
    const modeError = rejectDolaUnsupportedMode(selectedPlatform, selectedMode);
    if (modeError) {
      message.error(modeError);
      return;
    }
    const vc = selectedMode === 'video' ? videoConfig : undefined;
    if (selectedMode === 'video' && vc && !isVideoModelAvailableForPlatform(selectedPlatform, vc.model)) {
      message.error('当前 Dola 页面不提供 Seedance 2.0 Mini，请选择 Seedance 2.5 或 Seedance 2.0 Fast；不会自动替换模型');
      return;
    }
    if ((selectedMode === 'video' || selectedMode === 'image') && attachments.length > MAX_REFERENCE_IMAGE_COUNT) {
      message.error(`参考图片最多 ${MAX_REFERENCE_IMAGE_COUNT} 张，请删除多余图片后再创建任务`);
      return;
    }
    if (selectedMode === 'video' && referenceVideos.length > REFERENCE_VIDEO_LIMIT) {
      message.error(`参考视频最多 ${REFERENCE_VIDEO_LIMIT} 个，请删除多余视频后再创建任务`);
      return;
    }
    if (selectedMode === 'video' && audioAttachments.length > REFERENCE_AUDIO_LIMIT) {
      message.error(`参考音频最多 ${REFERENCE_AUDIO_LIMIT} 个，请删除多余音频后再创建任务`);
      return;
    }
    const att = (selectedMode === 'video' || selectedMode === 'image') && attachments.length > 0 ? attachments : undefined;
    const audioAtt = selectedMode === 'video' && audioAttachments[0] ? audioAttachments[0] : (selectedMode === 'video' ? audioAttachment || undefined : undefined);
    const videoRefs = selectedMode === 'video' && referenceVideos.length > 0 ? referenceVideos : undefined;
    const audioRefs = selectedMode === 'video' && audioAttachments.length > 0 ? audioAttachments : undefined;
    const expandedText = expandPromptVariables(inputText, variableRows);
    const newTasks = await addTasks(expandedText, selectedMode, vc, att, audioAtt, selectedPlatform, videoRefs, audioRefs);
    if (newTasks && newTasks.length > 0) {
      // 自动指派
      if (autoAssign) {
        const assignment = await autoAssignTasks(newTasks);
        if (assignment.unassigned > 0) {
          message.warning(`${assignment.unassigned} 个任务没有满足额度/健康条件的可用账号，已保留为未指派`);
        }
      }
      setInputText('');
      setAddModalOpen(false);
      setSelectedPlatform('doubao');
      setSelectedMode('chat');
      setVideoConfig({ ...DEFAULT_VIDEO_CONFIG });
      setAttachments([]);
      setReferenceVideos([]);
      setAudioAttachment('');
      setAudioAttachments([]);
      setVariableRows('');
    }
  }, [inputText, variableRows, selectedPlatform, selectedMode, videoConfig, attachments, referenceVideos, audioAttachment, audioAttachments, addTasks, autoAssign, autoAssignTasks]);

  const handleImportCsv = useCallback(async (filePath?: string) => {
    if (isCsvImporting) return;
    setIsCsvImporting(true);
    try {
      const result = await importCsv(filePath);
      if (!result) {
        if (useTaskStore.getState().error) message.error(useTaskStore.getState().error);
        return;
      }
      const assignment = autoAssign && result.tasks.length > 0
        ? await autoAssignTasks(result.tasks)
        : { assigned: 0, unassigned: 0 };
      if (result.errors.length > 0) {
        message.warning(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条；${result.errors[0]}`);
      } else if (assignment.unassigned > 0) {
        message.warning(`已导入 ${result.imported} 条；${assignment.unassigned} 条无可用账号，保留为未指派`);
      } else {
        message.success(`已导入 ${result.imported} 条任务`);
      }
    } finally {
      setIsCsvImporting(false);
    }
  }, [autoAssign, autoAssignTasks, importCsv, isCsvImporting]);

  const handleCsvDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    csvDragDepth.current += 1;
    if (Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) setIsCsvDragging(true);
  }, []);

  const handleCsvDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    csvDragDepth.current = Math.max(0, csvDragDepth.current - 1);
    if (csvDragDepth.current === 0) setIsCsvDragging(false);
  }, []);

  const handleCsvDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    csvDragDepth.current = 0;
    setIsCsvDragging(false);
    const decision = decideCsvDrop(event.dataTransfer.files);
    if (!decision.ok) {
      message.error(decision.message);
      return;
    }
    try {
      const filePath = window.electronAPI.tasks.getPathForDroppedFile(decision.file);
      if (!filePath) throw new Error('无法读取拖入文件的本地路径');
      void handleImportCsv(filePath);
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '无法导入拖入的 CSV 文件');
    }
  }, [handleImportCsv]);

  const handleAutoAssignChange = useCallback(async (enabled: boolean) => {
    setAutoAssign(enabled);
    const settings = await window.electronAPI.settings.get();
    const result = await window.electronAPI.settings.save({ ...settings, autoAssignEnabled: enabled });
    if (!result.success) {
      setAutoAssign(!enabled);
      message.error(result.error || '自动指派设置保存失败');
    }
  }, []);

  // ---- 选择参考图片 ----
  const handleSelectImages = useCallback(async () => {
    const result = await window.electronAPI.tasks.selectImages();
    if (result.success && result.filePaths && result.filePaths.length > 0) {
      const newPaths = result.filePaths.filter((path) => !attachments.includes(path));
      if (attachments.length + newPaths.length > MAX_REFERENCE_IMAGE_COUNT) {
        message.error(`参考图片最多 ${MAX_REFERENCE_IMAGE_COUNT} 张；当前已有 ${attachments.length} 张，本次未添加`);
        return;
      }
      setAttachments((prev) => [...prev, ...newPaths]);
      // 读取文件为 base64 用于缩略图显示
      for (const filePath of newPaths) {
        const base64Result = await window.electronAPI.tasks.readFileAsBase64(filePath);
        if (base64Result.success && base64Result.data) {
          setAttachmentBase64s((prev) => ({ ...prev, [filePath]: base64Result.data! }));
        }
      }
    }
  }, [attachments]);

  // ---- 选择参考视频 ----
  const handleSelectVideos = useCallback(async () => {
    const result = await window.electronAPI.tasks.selectVideos();
    if (!result.success || !result.filePaths?.length) return;
    const newPaths = result.filePaths.filter((path) => !referenceVideos.includes(path));
    if (referenceVideos.length + newPaths.length > REFERENCE_VIDEO_LIMIT) {
      message.error(`参考视频最多 ${REFERENCE_VIDEO_LIMIT} 个；当前已有 ${referenceVideos.length} 个，本次未添加`);
      return;
    }
    setReferenceVideos((current) => [...current, ...newPaths]);
  }, [referenceVideos]);

  // ---- 选择参考音频 ----
  const handleSelectAudios = useCallback(async () => {
    const result = await window.electronAPI.tasks.selectAudios();
    if (!result.success || !result.filePaths?.length) return;
    const newPaths = result.filePaths.filter((path) => !audioAttachments.includes(path));
    if (audioAttachments.length + newPaths.length > REFERENCE_AUDIO_LIMIT) {
      message.error(`参考音频最多 ${REFERENCE_AUDIO_LIMIT} 个；当前已有 ${audioAttachments.length} 个，本次未添加`);
      return;
    }
    const next = [...audioAttachments, ...newPaths];
    setAudioAttachments(next);
    setAudioAttachment(next[0] || '');
  }, [audioAttachments]);

  // ---- 指派账号 ----

  const handleAssign = useCallback(
    async (taskId: string, accountId: string) => {
      await assignTask(taskId, accountId);
    },
    [assignTask]
  );

  // ---- 启动自动化 ----

  const handleStartTask = useCallback(
    async (taskId: string) => {
      await clearError();
      await startAutomation(taskId);
    },
    [startAutomation, clearError]
  );

  const openEditAndRerun = (task: Task) => {
    setEditingTask(task);
    setEditingPrompt(task.prompt);
    setEditingVideoConfig({ ...(task.videoConfig || DEFAULT_VIDEO_CONFIG) });
    setEditingAttachments([...(task.attachments || [])]);
    setEditingReferenceVideos([...(task.referenceVideos || [])]);
    const taskAudios = [...new Set([...(task.audioAttachments || []), task.audioAttachment || ''].filter(Boolean))];
    setEditingAudioAttachments(taskAudios);
    setEditingAudioAttachment(taskAudios[0] || '');
    setEditingAttachmentBase64s({});
    for (const filePath of task.attachments || []) {
      void window.electronAPI.tasks.readFileAsBase64(filePath).then((result) => {
        if (result.success && result.data) {
          setEditingAttachmentBase64s((current) => ({ ...current, [filePath]: result.data! }));
        }
      });
    }
  };

  const resetEditingTask = () => {
    setEditingTask(null);
    setEditingPrompt('');
    setEditingVideoConfig({ ...DEFAULT_VIDEO_CONFIG });
    setEditingAttachments([]);
    setEditingAttachmentBase64s({});
    setEditingReferenceVideos([]);
    setEditingAudioAttachment('');
    setEditingAudioAttachments([]);
  };

  const handleSelectEditingImages = async () => {
    const result = await window.electronAPI.tasks.selectImages();
    if (!result.success || !result.filePaths?.length) return;
    const newPaths = result.filePaths.filter((path) => !editingAttachments.includes(path));
    if (editingAttachments.length + newPaths.length > MAX_REFERENCE_IMAGE_COUNT) {
      message.error(`参考图片最多 ${MAX_REFERENCE_IMAGE_COUNT} 张；当前已有 ${editingAttachments.length} 张，本次未添加`);
      return;
    }
    setEditingAttachments((current) => [...current, ...newPaths]);
    for (const filePath of newPaths) {
      const base64Result = await window.electronAPI.tasks.readFileAsBase64(filePath);
      if (base64Result.success && base64Result.data) {
        setEditingAttachmentBase64s((current) => ({ ...current, [filePath]: base64Result.data! }));
      }
    }
  };

  const handleSelectEditingVideos = async () => {
    const result = await window.electronAPI.tasks.selectVideos();
    if (!result.success || !result.filePaths?.length) return;
    const newPaths = result.filePaths.filter((path) => !editingReferenceVideos.includes(path));
    if (editingReferenceVideos.length + newPaths.length > REFERENCE_VIDEO_LIMIT) {
      message.error(`参考视频最多 ${REFERENCE_VIDEO_LIMIT} 个；当前已有 ${editingReferenceVideos.length} 个，本次未添加`);
      return;
    }
    setEditingReferenceVideos((current) => [...current, ...newPaths]);
  };

  const handleSelectEditingAudios = async () => {
    const result = await window.electronAPI.tasks.selectAudios();
    if (!result.success || !result.filePaths?.length) return;
    const newPaths = result.filePaths.filter((path) => !editingAudioAttachments.includes(path));
    if (editingAudioAttachments.length + newPaths.length > REFERENCE_AUDIO_LIMIT) {
      message.error(`参考音频最多 ${REFERENCE_AUDIO_LIMIT} 个；当前已有 ${editingAudioAttachments.length} 个，本次未添加`);
      return;
    }
    const next = [...editingAudioAttachments, ...newPaths];
    setEditingAudioAttachments(next);
    setEditingAudioAttachment(next[0] || '');
  };

  const handleEditAndRerun = async () => {
    if (!editingTask || !editingPrompt.trim()) {
      message.warning('提示词不能为空');
      return;
    }

    const editingPlatform: AccountPlatform = editingTask.targetPlatform || (
      editingTask.assignedAccountId && accounts.find((account) => account.id === editingTask.assignedAccountId)?.platform === 'dola'
        ? 'dola'
        : 'doubao'
    );
    const modeError = rejectDolaUnsupportedMode(editingPlatform, editingTask.mode);
    if (modeError) {
      message.error(modeError);
      return;
    }
    if (editingTask.mode === 'video' && !isVideoModelAvailableForPlatform(editingPlatform, editingVideoConfig.model)) {
      message.error('当前 Dola 页面不提供 Seedance 2.0 Mini，请选择 Seedance 2.5 或 Seedance 2.0 Fast；不会自动替换模型');
      return;
    }
    if (
      (editingTask.mode === 'video' || editingTask.mode === 'image')
      && editingAttachments.length > MAX_REFERENCE_IMAGE_COUNT
    ) {
      message.error(`参考图片最多 ${MAX_REFERENCE_IMAGE_COUNT} 张，请删除多余图片后再重新执行`);
      return;
    }
    if (editingTask.mode === 'video' && editingReferenceVideos.length > REFERENCE_VIDEO_LIMIT) {
      message.error(`参考视频最多 ${REFERENCE_VIDEO_LIMIT} 个，请删除多余视频后再重新执行`);
      return;
    }
    if (editingTask.mode === 'video' && editingAudioAttachments.length > REFERENCE_AUDIO_LIMIT) {
      message.error(`参考音频最多 ${REFERENCE_AUDIO_LIMIT} 个，请删除多余音频后再重新执行`);
      return;
    }

    const updates: TaskUpdateInput = {
      prompt: editingPrompt.trim(),
      videoConfig: editingTask.mode === 'video' ? editingVideoConfig : undefined,
      attachments: editingTask.mode === 'video' || editingTask.mode === 'image'
        ? editingAttachments
        : undefined,
      referenceVideos: editingTask.mode === 'video' ? editingReferenceVideos : undefined,
      audioAttachment: editingTask.mode === 'video' ? editingAudioAttachments[0] || editingAudioAttachment || undefined : undefined,
      audioAttachments: editingTask.mode === 'video' ? editingAudioAttachments : undefined,
    };
    const isActive = editingTask.status === 'executing' || editingTask.status === 'generating' || editingTask.status === 'waiting_verification' || editingTask.status === 'waiting_generation_confirmation' || editingTask.status === 'manual_submission_observing';
    if (isActive) {
      window.dispatchEvent(new CustomEvent('cancel-task-automation', {
        detail: { taskId: editingTask.id, restartTask: updates },
      }));
    } else {
      const updated = await updateTask(editingTask.id, updates);
      if (!updated) {
        message.error(useTaskStore.getState().error || '编辑任务失败');
        return;
      }
      processQueue();
      message.success('提示词已更新，任务已重新加入队列');
    }

    resetEditingTask();
  };

  // ---- 右键菜单 ----

  const requestVideoArtifactRecovery = (taskId: string): void => {
    Modal.confirm({
      title: '识别原会话视频并回传？',
      content: '若任务仍在自动等待，系统会先安全停止并释放账号，然后只读取该任务保存的原会话；不会重新发送提示词。',
      okText: '开始识别并回传',
      cancelText: '取消',
      onOk: () => window.dispatchEvent(new CustomEvent('recover-task-video-artifact', { detail: { taskId } })),
    });
  };

  const getContextMenu = (taskId: string): MenuProps['items'] => {
    const task = tasks.find((t) => t.id === taskId);
    const mustReconcile = requiresSubmissionReconciliation(task);
    const canRecoverVideo = canRecoverRunningVideo(task);
    const canRetry = task && !mustReconcile && (
      task.status === 'fail' || task.status === 'done' || task.status === 'paused' ||
      task.status === 'cancelled' || task.status === 'waiting_verification'
    );

    return [
      {
        key: 'detail',
        label: '查看详情',
        icon: <EyeOutlined />,
        onClick: () => {
          setSelectedTask(task || null);
          setDetailModalOpen(true);
        },
      },
      ...(canRecoverVideo ? [{
        key: 'recover-video-artifact',
        label: '识别原会话视频并回传',
        icon: <VideoCameraOutlined />,
        onClick: () => requestVideoArtifactRecovery(taskId),
      }] : []),
      ...(mustReconcile ? [{
        key: 'reconcile-submission',
        label: task?.mode === 'video'
          ? '识别原会话视频并回传'
          : task?.status === 'waiting_generation_confirmation' ? '人工确认后，只读回读原会话' : '核对平台结果（不重新发送）',
        icon: <SyncOutlined />,
        onClick: () => window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId } })),
      }] : [{
        key: 'edit-rerun',
        label: '编辑提示词并重跑',
        icon: <EditOutlined />,
        onClick: () => task && openEditAndRerun(task),
      }]),
      ...(canRetry ? [
        {
          key: 'retry',
          label: task?.status === 'waiting_verification' ? '完成处理后重新执行' : '重新执行',
          icon: <ReloadOutlined />,
          onClick: () => useTaskStore.getState().retryTask(taskId),
        },
      ] : []),
      { type: 'divider' as const },
      {
        key: 'delete',
        label: '删除任务',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => deleteTask(taskId),
      },
    ];
  };

  // ---- 渲染模式标签 ----

  const renderModeTag = (mode: GenerationMode) => {
    const cfg = GENERATION_MODE_CONFIG[mode] || GENERATION_MODE_CONFIG.chat;
    return (
      <Tooltip title={cfg.description}>
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            backgroundColor: cfg.color + '18',
            color: cfg.color,
            border: `1px solid ${cfg.color}30`,
          }}
        >
          <span>{cfg.icon}</span>
          {cfg.label}
        </span>
      </Tooltip>
    );
  };

  const renderPlatformTag = (platform: AccountPlatform) => {
    const isDola = platform === 'dola';
    const color = isDola ? '#22d3ee' : '#a78bfa';
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
        style={{
          backgroundColor: color + '18',
          color,
          border: `1px solid ${color}30`,
        }}
      >
        {isDola ? 'Dola' : '豆包'}
      </span>
    );
  };

  // ---- 渲染状态标签 ----

  const renderStatusTag = (status: TaskStatus) => {
    const cfg = TASK_STATUS_CONFIG[status];
    return (
      <span className={`task-status-tag ${cfg.className}`} style={{ borderColor: cfg.color, color: cfg.color }}>
        {status === 'generating' && <SyncOutlined spin style={{ marginRight: 4 }} />}
        {status === 'executing' && <ThunderboltOutlined style={{ marginRight: 4 }} />}
        {status === 'waiting_verification' && <LoadingOutlined spin style={{ marginRight: 4 }} />}
        {status === 'waiting_generation_confirmation' && <ClockCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'manual_submission_observing' && <SyncOutlined spin style={{ marginRight: 4 }} />}
        {(status === 'paused' || status === 'cancelled') && <PauseCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'queued' && <ClockCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'done' && <CheckCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'fail' && <CloseCircleOutlined style={{ marginRight: 4 }} />}
        {cfg.label}
      </span>
    );
  };

  // ---- 点击任务跳转到对应账号 ----

  const handleTaskClick = (task: Task) => {
    if (task.assignedAccountId) {
      selectAccount(task.assignedAccountId);
    }
  };

  // ---- 渲染任务项 ----

  const renderTaskItem = (task: (typeof tasks)[0]) => {
    const isActive = task.status === 'executing' || task.status === 'generating' || task.status === 'waiting_verification' || task.status === 'waiting_generation_confirmation' || task.status === 'manual_submission_observing';
    const isQueued = task.status === 'queued';
    const canStart = isQueued && task.assignedAccountId && !accountBusy[task.assignedAccountId];
    const canRecoverVideo = canRecoverRunningVideo(task);
    const taskMode = task.mode || 'chat';
    const targetPlatform = task.targetPlatform || 'doubao';

    return (
      <Dropdown menu={{ items: getContextMenu(task.id) }} trigger={['contextMenu']} key={task.id}>
        <div
          className={`task-item ${isActive ? 'task-item-active' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => handleTaskClick(task)}
        >
          <div className="task-item-top">
            {renderStatusTag(task.status)}
            {renderPlatformTag(targetPlatform)}
            {renderModeTag(taskMode)}
            <span className="task-item-time">
              {new Date(task.createdAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          <p className="task-item-prompt">{task.prompt}</p>
          {(task.batchId || (task.dependsOnTaskIds?.length || 0) > 0) && (
            <div className="text-2xs text-db-text-muted mb-1 truncate">
              {task.batchId ? `批次 ${task.batchId.slice(-10)}` : ''}
              {(task.dependsOnTaskIds?.length || 0) > 0 ? ` · 等待 ${task.dependsOnTaskIds!.length} 个前置任务` : ''}
            </div>
          )}
          <div className="task-item-bottom" onClick={(e) => e.stopPropagation()}>
            <Select
              size="small"
              placeholder={`指派${targetPlatform === 'dola' ? 'Dola' : '豆包'}账号`}
              value={task.assignedAccountId || undefined}
              onChange={(value) => handleAssign(task.id, value)}
              style={{ width: 130 }}
              disabled={isActive}
              onClick={(e) => e.stopPropagation()}
              popupMatchSelectWidth={false}
              options={buildManualAssignmentOptions(accounts, targetPlatform, taskMode, task.videoConfig?.duration)}
            />
            <div className="task-item-actions">
              {canRecoverVideo && (
                <Tooltip title="停止当前等待，识别该任务原会话中的视频并回传">
                  <Button
                    size="small"
                    icon={<VideoCameraOutlined />}
                    onClick={() => requestVideoArtifactRecovery(task.id)}
                    aria-label="识别原会话视频并回传"
                  />
                </Tooltip>
              )}
              <Tooltip title="编辑提示词并重新运行">
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEditAndRerun(task)}
                />
              </Tooltip>
              {canStart && (
                <Button
                  type="primary"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  onClick={() => handleStartTask(task.id)}
                >
                  启动
                </Button>
              )}
              {isActive && (
                <>
                  <span className="task-progress-text">
                    <LoadingOutlined spin /> {task.runtime?.message || '执行中...'}
                  </span>
                  <Button
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    onClick={() => window.dispatchEvent(new CustomEvent('cancel-task-automation', {
                      detail: { taskId: task.id },
                    }))}
                  >
                    暂停任务
                  </Button>
                </>
              )}
              {task.status === 'done' && task.result && (
                <a
                  className="task-result-link"
                  href={task.result}
                  target="_blank"
                  rel="noreferrer"
                  title={task.result}
                >
                  查看结果
                </a>
              )}
            </div>
          </div>
          {(task.status === 'fail' || task.status === 'paused' || task.status === 'cancelled') && task.result && (
            <p className="task-error-text">{task.result}</p>
          )}
        </div>
      </Dropdown>
    );
  };

  // ---- 统计 ----

  const queuedCount = tasks.filter((t) => t.status === 'queued').length;
  const runningCount = tasks.filter(
    (t) => t.status === 'executing' || t.status === 'generating' || t.status === 'waiting_verification' || t.status === 'waiting_generation_confirmation' || t.status === 'manual_submission_observing'
  ).length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const failCount = tasks.filter((t) => t.status === 'fail').length;
  const editingPlatform: AccountPlatform = editingTask?.targetPlatform || (
    editingTask?.assignedAccountId && accounts.find((account) => account.id === editingTask.assignedAccountId)?.platform === 'dola'
      ? 'dola'
      : 'doubao'
  );
  const editingModelUnavailable = Boolean(
    editingTask?.mode === 'video' && !isVideoModelAvailableForPlatform(editingPlatform, editingVideoConfig.model),
  );

  return (
    <div
      className={`task-console${isCsvDragging ? ' csv-dragging' : ''}`}
      onDragEnter={handleCsvDragEnter}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={handleCsvDragLeave}
      onDrop={handleCsvDrop}
    >
      {isCsvDragging && (
        <div className="csv-drop-overlay" role="status" aria-live="polite">
          <FileExcelOutlined />
          <strong>松开导入 CSV</strong>
          <span>导入当前项目；未指派任务不会自动开始</span>
        </div>
      )}
      {/* 顶部操作栏 */}
      <div className="task-console-header">
        <Tooltip title={`项目 ID：${activeProjectId}`}>
          <span className="task-console-title">任务调度 · {activeProject?.name || activeProjectId}</span>
        </Tooltip>
        <div className="task-console-stats">
          <span className="stat-badge running"><LoadingOutlined spin={runningCount > 0} /> 运行 {runningCount}</span>
          <span className="stat-badge queued"><ClockCircleOutlined /> 排队 {queuedCount}</span>
          <span className="stat-badge done"><CheckCircleOutlined /> 完成 {doneCount}</span>
          {failCount > 0 && (
            <span className="stat-badge fail">
              <CloseCircleOutlined /> {failCount}
            </span>
          )}
        </div>
        <div className="task-console-actions">
          <Button size="small" icon={<DeleteOutlined aria-hidden="true" />} disabled={!tasks.length} onClick={(): void => setBatchDeleteOpen(true)}>批量删除</Button>
          <Tooltip title={autoAssign ? '自动指派：开启' : '自动指派：关闭'}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 8 }}>
              <Switch
                size="small"
                checked={autoAssign}
                onChange={(enabled) => void handleAutoAssignChange(enabled)}
              />
              <span style={{ color: '#9898b8', fontSize: 12 }}>自动指派</span>
            </div>
          </Tooltip>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={openAddTaskModal}
            type="primary"
          >
            添加任务
          </Button>
          <Tooltip title="从 CSV 导入任务批次">
            <Button
              size="small"
              icon={<FileExcelOutlined />}
              loading={isCsvImporting}
              disabled={isCsvImporting}
              onClick={() => void handleImportCsv()}
            />
          </Tooltip>
          {(runningCount > 0 || queuedCount > 0) && (
            <Button
              size="small"
              icon={<PauseCircleOutlined />}
              onClick={batchPause}
              danger
            >
              全部暂停
            </Button>
          )}
          {doneCount > 0 && (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={async () => {
                const outputs = await getCompletedOutputs();
                console.log('[TaskConsole] 已完成产物:', outputs);
                if (outputs.length === 0) {
                  message.info('暂无已完成产物');
                  return;
                }
                // 通过自定义事件通知 Toolbar 打开预览
                window.dispatchEvent(new CustomEvent('batch-download-outputs', { detail: outputs }));
              }}
            >
              批量下载
            </Button>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {batchDeleteOpen && <BatchDeleteDialog key={activeProjectId} noun="任务" items={tasks.map(task => ({
        id: task.id, label: task.prompt || '未命名任务',
        detail: `${TASK_STATUS_CONFIG[task.status]?.label || task.status} · ${task.targetPlatform === 'dola' ? 'Dola' : '豆包'} · ${new Date(task.createdAt).toLocaleString('zh-CN')}`,
        blockedReason: taskDeletionBlocker(task, Object.values(executingTasks)), dependsOnIds: task.dependsOnTaskIds,
      }))} description="仅删除当前列表中选定的任务记录，已下载的图片和视频文件保留。执行中任务需要先暂停；被未选中任务依赖的记录会保留。"
        onDelete={deleteBatchTask} onClose={(): void => setBatchDeleteOpen(false)} />}
      {error && (
        <div className="task-console-error">
          <CloseCircleOutlined style={{ marginRight: 6 }} />
          {error}
        </div>
      )}

      {/* 任务列表 */}
      <div className="task-list">
        {tasks.length === 0 ? (
          <div className="task-empty">
            <p>暂无任务</p>
            <span>点击「添加任务」开始</span>
          </div>
        ) : (
          tasks.map(renderTaskItem)
        )}
      </div>

      {/* 添加任务弹窗 */}
      <Modal
        title="添加任务"
        open={addModalOpen}
        onOk={handleAddTasks}
        onCancel={() => {
          setAddModalOpen(false);
          setInputText('');
          setSelectedPlatform('doubao');
          setSelectedMode('chat');
          setVideoConfig({ ...DEFAULT_VIDEO_CONFIG });
          setAttachments([]);
          setVariableRows('');
        }}
        okText="添加"
        cancelText="取消"
        width={520}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <Select
            placeholder="应用任务模板"
            style={{ flex: 1 }}
            options={templates.map((template) => ({ value: template.id, label: template.name }))}
            onChange={applyTemplate}
            allowClear
          />
          <Button icon={<PlusOutlined />} onClick={() => setTemplateModalOpen(true)}>保存模板</Button>
          <Tooltip title="删除最近保存的模板">
            <Button
              danger
              disabled={templates.length === 0}
              icon={<DeleteOutlined />}
              onClick={() => {
                const last = templates[templates.length - 1];
                if (last) void persistTemplates(templates.filter((item) => item.id !== last.id));
              }}
            />
          </Tooltip>
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>
            生成平台
          </div>
          <Segmented
            aria-label="选择任务生成平台"
            value={selectedPlatform}
            onChange={(value) => handlePlatformChange(value as AccountPlatform)}
            options={[
              { label: `豆包 (${accounts.filter((account) => (account.platform || 'doubao') === 'doubao').length})`, value: 'doubao' },
              { label: `Dola (${accounts.filter((account) => account.platform === 'dola').length})`, value: 'dola' },
            ]}
            block
            style={{ background: '#1a1a24', padding: 4, borderRadius: 8 }}
          />
        </div>
        {/* 模式选择 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>
            选择生成模式
          </div>
          <ModeSelector
            value={selectedMode}
            onChange={setSelectedMode}
            allowedModes={getAllowedGenerationModes(selectedPlatform)}
          />
          <div style={{ color: '#6b6b88', marginTop: 6, fontSize: 12 }}>
            {GENERATION_MODE_CONFIG[selectedMode].description}
          </div>
        </div>

        {/* 视频配置（仅视频模式） */}
        {selectedMode === 'video' && (
          <div style={{ marginBottom: 16 }}>
            {/* 模型选择 */}
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>视频模型</div>
            <Segmented
              value={videoConfig.model}
              onChange={(val) => setVideoConfig({ ...videoConfig, model: val as VideoModel })}
              options={Object.entries(VIDEO_MODEL_LABELS).map(([key, label]) => ({
                label: (
                  <div className="flex flex-col items-center py-1 px-2">
                    <span className="text-xs font-medium">{label}</span>
                    <span className="text-[10px] mt-0.5" style={{ color: '#6b6b88' }}>{VIDEO_MODEL_COST[key as VideoModel]}</span>
                  </div>
                ),
                value: key,
              }))}
              block
              style={{ background: '#1a1a24', padding: '4px', borderRadius: 8, marginBottom: 12 }}
            />

            {/* 时长选择 */}
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>视频时长</div>
            <Select
              value={videoConfig.duration}
              onChange={(val) => setVideoConfig({ ...videoConfig, duration: val as VideoDuration })}
              options={getVideoDurationOptions(selectedPlatform)}
              style={{ width: '100%', marginBottom: 12 }}
              optionLabelProp="label"
            />

            {/* 比例选择 */}
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>画面比例</div>
            <Segmented
              className="video-ratio-segmented"
              value={videoConfig.aspectRatio}
              onChange={(val) => setVideoConfig({ ...videoConfig, aspectRatio: val as VideoAspectRatio })}
              options={['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].map((r) => ({
                label: r,
                value: r,
              }))}
              block
              style={{ background: '#1a1a24', padding: '4px', borderRadius: 8, marginBottom: 12 }}
            />

            {/* 视频能力预检提示（新任务仅展示风险，不阻止提交；实际执行账号可能由调度器分配） */}
            {(() => {
              const selectedAccount = useAccountStore.getState().accounts.find(a => a.id === useAccountStore.getState().selectedAccountId);
              if (!selectedAccount) return null;
              const capability = evaluateVideoCapability({
                model: videoConfig.model,
                duration: videoConfig.duration,
                aspectRatio: videoConfig.aspectRatio,
                platform: selectedPlatform,
                manual15sEnabled: false,
                seedanceQuota: selectedAccount.seedanceQuota,
                health: selectedAccount.health,
                scheduling: selectedAccount.scheduling,
                accountStatus: selectedAccount.status,
              });
              if (capability.state === 'allowed') return null;
              // 新任务仅展示风险提示，不阻止提交（实际执行账号可能由调度器分配）
              return (
                <div style={{
                  padding: '8px 12px',
                  marginBottom: 12,
                  borderRadius: 8,
                  fontSize: 12,
                  background: 'rgba(250,173,20,0.1)',
                  border: '1px solid rgba(250,173,20,0.3)',
                  color: '#faad14',
                }}>
                  {`[当前选中账号：${selectedAccount.name}] ${capability.userMessage}`}
                  {capability.suggestion && (
                    <div style={{ marginTop: 4, color: '#9898b8' }}>
                      建议：{capability.suggestion.reason}
                    </div>
                  )}
                  {capability.state === 'blocked' && (
                    <div style={{ marginTop: 4, color: '#9898b8' }}>
                      提示：自动指派模式下调度器将选择可用账号执行
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* 参考图片上传（视频/图片模式） */}
        {(selectedMode === 'video' || selectedMode === 'image') && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>
              参考图片（可选，最多 {MAX_REFERENCE_IMAGE_COUNT} 张）
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {attachments.map((filePath, idx) => (
                <div
                  key={idx}
                  style={{
                    position: 'relative',
                    width: 64,
                    height: 64,
                    borderRadius: 6,
                    border: '1px solid #2a2a3e',
                    overflow: 'hidden',
                    background: '#1a1a24',
                  }}
                >
                  <img
                    src={attachmentBase64s[filePath] || ''}
                    alt={`ref-${idx}`}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <button
                    onClick={() => {
                      setAttachments((prev) => prev.filter((_, i) => i !== idx));
                      setAttachmentBase64s((prev) => {
                        const next = { ...prev };
                        delete next[filePath];
                        return next;
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(0,0,0,0.6)',
                      color: '#fff',
                      fontSize: 10,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={handleSelectImages}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 6,
                  border: '1px dashed #3a3a5e',
                  background: 'transparent',
                  color: '#6b6b88',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  fontSize: 10,
                }}
              >
                <PictureOutlined style={{ fontSize: 20 }} />
                添加
              </button>
            </div>
          </div>
        )}

        {/* 参考视频和音频上传（仅视频模式） */}
        {selectedMode === 'video' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>
                参考视频（可选，最多 {REFERENCE_VIDEO_LIMIT} 个）
              </div>
              <Space wrap size={[8, 8]}>
                {referenceVideos.map((filePath) => (
                  <span key={filePath} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 240, padding: '6px 10px', background: '#1a1a24', border: '1px solid #2a2a3e', borderRadius: 6, color: '#d0d0e0', fontSize: 12 }}>
                    <VideoCameraOutlined />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filePath.split(/[/\\]/).pop()}</span>
                    <Button type="text" size="small" onClick={() => setReferenceVideos((current) => current.filter((item) => item !== filePath))} style={{ color: '#ff7875', padding: 0, minWidth: 18 }}>×</Button>
                  </span>
                ))}
                <Button icon={<VideoCameraOutlined />} onClick={handleSelectVideos}>添加视频</Button>
              </Space>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>
                参考音频（可选，最多 {REFERENCE_AUDIO_LIMIT} 个）
              </div>
              <Space wrap size={[8, 8]}>
                {audioAttachments.map((filePath) => (
                  <span key={filePath} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 240, padding: '6px 10px', background: '#1a1a24', border: '1px solid #2a2a3e', borderRadius: 6, color: '#d0d0e0', fontSize: 12 }}>
                    <AudioOutlined />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filePath.split(/[/\\]/).pop()}</span>
                    <Button type="text" size="small" onClick={() => {
                      const next = audioAttachments.filter((item) => item !== filePath);
                      setAudioAttachments(next);
                      setAudioAttachment(next[0] || '');
                    }} style={{ color: '#ff7875', padding: 0, minWidth: 18 }}>×</Button>
                  </span>
                ))}
                <Button icon={<AudioOutlined />} onClick={handleSelectAudios}>添加音频</Button>
              </Space>
            </div>
          </>
        )}

        {/* 提示词输入 */}
        <p style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>
          使用 <code style={{ color: '#f0c040', background: '#2a2a3e', padding: '2px 6px', borderRadius: 4 }}>%%%%%%%%%%</code> 分割多个任务
        </p>
        <TextArea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            selectedMode === 'image'
              ? '一只橘色短毛猫，趴在阳光窗台上，写实摄影风格，8K高清\n%%%%%%%%%%\n赛博朋克城市夜景，霓虹灯，雨夜，16:9'
              : selectedMode === 'video'
              ? '海边日落，海浪慢动作，暖色调，电影氛围感，10秒\n%%%%%%%%%%\n女生漫步樱花树下，微笑，近景，自然光，5秒'
              : selectedMode === 'music'
              ? '轻快的钢琴曲，治愈系，30秒\n%%%%%%%%%%\n电子音乐，节奏感强，适合短视频BGM'
              : '写一篇关于AI的科普文章\n%%%%%%%%%%\n总结2024年科技趋势\n%%%%%%%%%%\n翻译这段文本为英文'
          }
          rows={8}
          autoFocus
          style={{
            background: '#1a1a24',
            border: '1px solid #2a2a3e',
            color: '#e8e8f0',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 13,
            lineHeight: 1.8,
            borderRadius: 8,
          }}
        />
        <div style={{ color: '#9898b8', marginTop: 14, marginBottom: 8, fontSize: 13 }}>
          批量变量（可选，每行生成一组任务）
        </div>
        <TextArea
          value={variableRows}
          onChange={(event) => setVariableRows(event.target.value)}
          rows={3}
          placeholder={'产品=保温杯;场景=客厅\n产品=咖啡杯;场景=办公室'}
          style={{ background: '#1a1a24', borderColor: '#2a2a3e', color: '#e8e8f0' }}
        />
      </Modal>

      <Modal
        title="保存任务模板"
        open={templateModalOpen}
        onOk={() => void saveCurrentTemplate()}
        onCancel={() => setTemplateModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <Input
          value={templateName}
          onChange={(event) => setTemplateName(event.target.value)}
          onPressEnter={() => void saveCurrentTemplate()}
          placeholder="模板名称"
          autoFocus
        />
      </Modal>

      <Modal
        title="编辑提示词并重新运行"
        open={!!editingTask}
        onOk={handleEditAndRerun}
        onCancel={resetEditingTask}
        okText="保存并重新运行"
        cancelText="取消"
        width={620}
        okButtonProps={{
          // 已绑定账号且预检 blocked 时禁用确认按钮
          disabled: (() => {
            if (!editingTask || editingTask.mode !== 'video') return false;
            const boundAccountId = editingTask.assignedAccountId;
            if (!boundAccountId) return false;
            const boundAccount = useAccountStore.getState().accounts.find(a => a.id === boundAccountId);
            if (!boundAccount) return false;
            const capability = evaluateVideoCapability({
              model: editingVideoConfig.model,
              duration: editingVideoConfig.duration,
              aspectRatio: editingVideoConfig.aspectRatio,
              platform: editingTask.targetPlatform || boundAccount.platform || 'doubao',
              manual15sEnabled: false,
              seedanceQuota: boundAccount.seedanceQuota,
              health: boundAccount.health,
              scheduling: boundAccount.scheduling,
              accountStatus: boundAccount.status,
            });
            return !capability.canSubmit;
          })(),
        }}
      >
        <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>提示词</div>
        <TextArea
          value={editingPrompt}
          onChange={(event) => setEditingPrompt(event.target.value)}
          rows={10}
          autoFocus
          placeholder="请输入提示词"
          style={{
            background: '#1a1a24',
            border: '1px solid #2a2a3e',
            color: '#e8e8f0',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineHeight: 1.7,
            marginBottom: 16,
          }}
        />

        {editingTask?.mode === 'video' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>视频模型</div>
            <Segmented
              value={editingVideoConfig.model}
              onChange={(value) => setEditingVideoConfig({ ...editingVideoConfig, model: value as VideoModel })}
              options={Object.entries(VIDEO_MODEL_LABELS).map(([key, label]) => ({
                label,
                value: key,
              }))}
              block
              style={{ background: '#1a1a24', padding: 4, marginBottom: 12 }}
            />
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>视频时长</div>
            <Select
              value={editingVideoConfig.duration}
              onChange={(value) => setEditingVideoConfig({ ...editingVideoConfig, duration: value as VideoDuration })}
              options={getVideoDurationOptions(
                editingTask?.targetPlatform || (
                  editingTask?.assignedAccountId && accounts.find((account) => account.id === editingTask.assignedAccountId)?.platform === 'dola'
                    ? 'dola'
                    : 'doubao'
                ),
              )}
              style={{ width: '100%', marginBottom: 12 }}
              optionLabelProp="label"
            />
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>画面比例</div>
            <Segmented
              className="video-ratio-segmented"
              value={editingVideoConfig.aspectRatio}
              onChange={(value) => setEditingVideoConfig({ ...editingVideoConfig, aspectRatio: value as VideoAspectRatio })}
              options={['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']}
              block
              style={{ background: '#1a1a24', padding: 4 }}
            />

            {/* 视频能力预检提示（使用任务已绑定账号，非 selectedAccountId） */}
            {(() => {
              const boundAccountId = editingTask?.assignedAccountId;
              if (!boundAccountId) {
                // 未绑定账号时仅展示风险提示
                if (Number.parseInt(editingVideoConfig.duration, 10) >= 11) {
                  return (
                    <div style={{
                      marginTop: 12,
                      padding: '8px 12px',
                      borderRadius: 8,
                      fontSize: 12,
                      background: 'rgba(250,173,20,0.1)',
                      border: '1px solid rgba(250,173,20,0.3)',
                      color: '#faad14',
                    }}>
                      豆包 11–30 秒与 Dola 30 秒都以对应页面的真实可见选项为准
                    </div>
                  );
                }
                return null;
              }
              const boundAccount = useAccountStore.getState().accounts.find(a => a.id === boundAccountId);
              if (!boundAccount) return null;
              const capability = evaluateVideoCapability({
                model: editingVideoConfig.model,
                duration: editingVideoConfig.duration,
                aspectRatio: editingVideoConfig.aspectRatio,
                platform: editingTask.targetPlatform || boundAccount.platform || 'doubao',
                manual15sEnabled: false,
                seedanceQuota: boundAccount.seedanceQuota,
                health: boundAccount.health,
                scheduling: boundAccount.scheduling,
                accountStatus: boundAccount.status,
              });
              if (capability.state === 'allowed') return null;
              const isBlocked = capability.state === 'blocked';
              return (
                <div style={{
                  marginTop: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  background: isBlocked ? 'rgba(255,77,79,0.1)' : 'rgba(250,173,20,0.1)',
                  border: `1px solid ${isBlocked ? 'rgba(255,77,79,0.3)' : 'rgba(250,173,20,0.3)'}`,
                  color: isBlocked ? '#ff6b6b' : '#faad14',
                }}>
                  {`[绑定账号：${boundAccount.name}] ${capability.userMessage}`}
                  {capability.suggestion && (
                    <div style={{ marginTop: 4, color: '#9898b8' }}>
                      建议：{capability.suggestion.reason}
                    </div>
                  )}
                  {isBlocked && (
                    <div style={{ marginTop: 4, color: '#9898b8' }}>
                      该账号当前不可用，请先解决上述问题或更换绑定账号
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {(editingTask?.mode === 'video' || editingTask?.mode === 'image') && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>参考图片</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {editingAttachments.map((filePath) => (
                <div key={filePath} style={{ position: 'relative', width: 64, height: 64 }}>
                  <img
                    src={editingAttachmentBase64s[filePath] || ''}
                    alt="参考图片"
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid #2a2a3e' }}
                  />
                  <Button
                    size="small"
                    danger
                    shape="circle"
                    icon={<DeleteOutlined />}
                    onClick={() => setEditingAttachments((current) => current.filter((path) => path !== filePath))}
                    style={{ position: 'absolute', top: -7, right: -7, width: 22, minWidth: 22, height: 22 }}
                  />
                </div>
              ))}
              <Button
                icon={<PictureOutlined />}
                onClick={handleSelectEditingImages}
                style={{ width: 64, height: 64 }}
              >
                添加
              </Button>
            </div>
          </div>
        )}

        {editingTask?.mode === 'video' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>参考视频（最多 {REFERENCE_VIDEO_LIMIT} 个）</div>
              <Space wrap size={[8, 8]}>
                {editingReferenceVideos.map((filePath) => (
                  <span key={filePath} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 240, padding: '6px 10px', background: '#1a1a24', border: '1px solid #2a2a3e', borderRadius: 6, color: '#d0d0e0', fontSize: 12 }}>
                    <VideoCameraOutlined />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filePath.split(/[/\\]/).pop()}</span>
                    <Button type="text" size="small" onClick={() => setEditingReferenceVideos((current) => current.filter((item) => item !== filePath))} style={{ color: '#ff7875', padding: 0, minWidth: 18 }}>×</Button>
                  </span>
                ))}
                <Button icon={<VideoCameraOutlined />} onClick={handleSelectEditingVideos}>添加视频</Button>
              </Space>
            </div>
            <div>
              <div style={{ color: '#9898b8', marginBottom: 8, fontSize: 13 }}>参考音频（最多 {REFERENCE_AUDIO_LIMIT} 个）</div>
              <Space wrap size={[8, 8]}>
                {editingAudioAttachments.map((filePath) => (
                  <span key={filePath} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 240, padding: '6px 10px', background: '#1a1a24', border: '1px solid #2a2a3e', borderRadius: 6, color: '#d0d0e0', fontSize: 12 }}>
                    <AudioOutlined />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filePath.split(/[/\\]/).pop()}</span>
                    <Button type="text" size="small" onClick={() => {
                      const next = editingAudioAttachments.filter((item) => item !== filePath);
                      setEditingAudioAttachments(next);
                      setEditingAudioAttachment(next[0] || '');
                    }} style={{ color: '#ff7875', padding: 0, minWidth: 18 }}>×</Button>
                  </span>
                ))}
                <Button icon={<AudioOutlined />} onClick={handleSelectEditingAudios}>添加音频</Button>
              </Space>
            </div>
          </>
        )}
      </Modal>

      {/* 任务详情弹窗 */}
      <TaskDetailModal
        open={detailModalOpen}
        task={selectedTask}
        onEditAndRerun={openEditAndRerun}
        onClose={() => {
          setDetailModalOpen(false);
          setSelectedTask(null);
        }}
      />
    </div>
  );
};

export default TaskConsole;
