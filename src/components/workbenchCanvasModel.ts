import type { Task, VideoAspectRatio, VideoDuration, VideoModel } from '../types';

export type CanvasNodeKind = 'prompt' | 'image' | 'video' | 'audio' | 'result' | 'frame';

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  x: number;
  y: number;
  value?: string;
  filePath?: string;
  taskId?: string;
  frameId?: string;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface WorkbenchCanvasProject {
  id: string;
  name: string;
  updatedAt: string;
  document: CanvasDocument;
}

export interface CanvasExport {
  schema: 'doubao-studio-workbench-canvas';
  version: 1;
  exportedAt: string;
  projects: WorkbenchCanvasProject[];
}

export const NODE_TITLES: Record<CanvasNodeKind, string> = {
  prompt: '提示词',
  image: '图片素材',
  video: '视频素材',
  audio: '音频素材',
  result: '生成结果',
  frame: '分组',
};

export const NODE_KINDS: CanvasNodeKind[] = ['prompt', 'image', 'video', 'audio', 'result', 'frame'];
export const VIDEO_MODELS: Array<{ value: VideoModel; label: string }> = [
  { value: 'seedance-2.5', label: 'Seedance 2.5' },
  { value: 'seedance-2.0', label: 'Seedance 2.0' },
  { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast' },
  { value: 'seedance-2.0-mini', label: 'Seedance 2.0 Mini' },
];
export const VIDEO_DURATIONS: Array<{ value: VideoDuration; label: string }> = [
  { value: '4s', label: '4 秒' },
  { value: '5s', label: '5 秒' },
  { value: '10s', label: '10 秒' },
  { value: '30s', label: '30 秒' },
];
export const VIDEO_RATIOS: Array<{ value: VideoAspectRatio; label: string }> = [
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
];

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyDocument(): CanvasDocument {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

export function copyDocument(value: CanvasDocument): CanvasDocument {
  return {
    nodes: value.nodes.map((node) => ({ ...node })),
    edges: value.edges.map((edge) => ({ ...edge })),
    viewport: value.viewport ? { ...value.viewport } : { x: 0, y: 0, zoom: 1 },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeNode(value: unknown, index: number): CanvasNode | null {
  if (!isRecord(value) || !NODE_KINDS.includes(value.kind as CanvasNodeKind)) return null;
  const kind = value.kind as CanvasNodeKind;
  const x = typeof value.x === 'number' && Number.isFinite(value.x) ? Math.max(0, Math.min(value.x, 5000)) : 48 + (index % 3) * 260;
  const y = typeof value.y === 'number' && Number.isFinite(value.y) ? Math.max(0, Math.min(value.y, 5000)) : 52 + Math.floor(index / 3) * 190;
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : makeId(kind),
    kind,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.slice(0, 80) : NODE_TITLES[kind],
    x,
    y,
    value: typeof value.value === 'string' ? value.value.slice(0, 20000) : undefined,
    filePath: typeof value.filePath === 'string' && value.filePath.trim() ? value.filePath : undefined,
    taskId: typeof value.taskId === 'string' && value.taskId.trim() ? value.taskId : undefined,
    frameId: typeof value.frameId === 'string' && value.frameId.trim() ? value.frameId : undefined,
  };
}

export function normalizeDocument(value: unknown): CanvasDocument {
  if (!isRecord(value)) return emptyDocument();
  const rawNodes = Array.isArray(value.nodes) ? value.nodes.slice(0, 100) : [];
  const nodes = rawNodes.map(normalizeNode).filter((node): node is CanvasNode => Boolean(node));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(value.edges) ? value.edges : [])
    .slice(0, 300)
    .filter(isRecord)
    .map((edge) => ({
      id: typeof edge.id === 'string' && edge.id.trim() ? edge.id : makeId('edge'),
      from: typeof edge.from === 'string' ? edge.from : '',
      to: typeof edge.to === 'string' ? edge.to : '',
    }))
    .filter((edge) => edge.from && edge.to && edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const rawViewport = isRecord(value.viewport) ? value.viewport : {};
  const zoom = typeof rawViewport.zoom === 'number' && Number.isFinite(rawViewport.zoom)
    ? Math.max(0.45, Math.min(rawViewport.zoom, 1.8))
    : 1;
  return {
    nodes,
    edges,
    viewport: {
      x: typeof rawViewport.x === 'number' && Number.isFinite(rawViewport.x) ? rawViewport.x : 0,
      y: typeof rawViewport.y === 'number' && Number.isFinite(rawViewport.y) ? rawViewport.y : 0,
      zoom,
    },
  };
}

export function normalizeProjects(value: unknown): WorkbenchCanvasProject[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).filter(isRecord).map((item, index) => ({
    id: typeof item.id === 'string' && item.id.trim() ? item.id : makeId('project'),
    name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 80) : `画布项目 ${index + 1}`,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    document: normalizeDocument(item.document),
  }));
}

export function statusLabel(task: Task | undefined): string {
  if (!task) return '等待提交';
  if (task.status === 'done') return '已完成';
  if (task.status === 'fail') return task.result || '失败';
  if (task.status === 'cancelled') return '已取消';
  if (task.status === 'paused') return '已暂停';
  return task.runtime?.message || '排队中';
}

export function isVideoUrl(url: string, task: Task | undefined): boolean {
  if (task?.artifacts?.some((artifact) => artifact.kind === 'video')) return true;
  return task?.mode === 'video' || /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url);
}
