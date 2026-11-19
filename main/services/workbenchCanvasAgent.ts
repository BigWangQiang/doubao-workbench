import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { requireLalorGenerationAccess } from '../ipc/lalorAuth';
import { loadLalorSession } from '../utils/lalorAuthStore';
import { canvasApiRequest } from './workbenchCanvasApi';
import { canvasRead, canvasWrite, getCanvasResource, type CanvasRecord } from './workbenchCanvasStorage';

interface AgentTask extends CanvasRecord {
    id: string;
    ownerId: string;
    requestHash: string;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    resultJson?: string;
}
const active = new Map<string, AbortController>();
const transitions = new Map<string, Promise<AgentTask>>();
let creating: Promise<unknown> = Promise.resolve();

function object(value: unknown): CanvasRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('助手请求格式不正确');
    return value as CanvasRecord;
}
function requiredText(value: unknown, label: string, max = 256): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效，请重新选择后再试`);
    return value.trim();
}
function ownerId(): string {
    const id = loadLalorSession()?.profile.userId;
    if (!id) throw new Error('请先登录工作台会员账号');
    return id;
}
function taskKey(id: string): string {
    if (!/^agent-[a-f0-9]{64}$/.test(id)) throw new Error('助手任务编号无效');
    return 'agent-task:' + id;
}
async function readTask(id: string): Promise<AgentTask> {
    const task = await canvasRead<AgentTask>(taskKey(id));
    if (!task || task.ownerId !== ownerId()) throw new Error('当前账号没有此助手任务');
    return task;
}
async function transition(id: string, update: (task: AgentTask) => AgentTask): Promise<AgentTask> {
    // 完成和停止可能同时返回，串行落盘，终态不能被较晚的响应覆盖。
    const run = (transitions.get(id) || Promise.resolve()).catch((): void => undefined).then(async (): Promise<AgentTask> => {
        const task = await canvasRead<AgentTask>(taskKey(id));
        if (!task) throw new Error('助手任务记录不存在');
        if (task.status !== 'running') return task;
        const next = { ...update(task), updatedAt: new Date().toISOString() };
        await canvasWrite(taskKey(id), next);
        return next;
    });
    transitions.set(id, run);
    try { return await run; } finally { if (transitions.get(id) === run) transitions.delete(id); }
}
function state(task: AgentTask): CanvasRecord {
    const { ownerId: _owner, requestHash: _hash, ...view } = task;
    const result = task.resultJson ? object(JSON.parse(task.resultJson)) : {};
    return { task: view, replay: { deltas: [], complete: task.status !== 'running', finalText: typeof result.text === 'string' ? result.text : '' } };
}

async function imageAddress(value: unknown): Promise<string> {
    const address = requiredText(value, '参考图', 70 * 1024 * 1024);
    let resourceId = address.startsWith('resource:') ? address.slice(9) : '';
    if (address.startsWith('lalor-canvas:')) {
        const url = new URL(address);
        if (url.hostname !== 'resources') throw new Error('参考图不是已登记的本地资源');
        resourceId = decodeURIComponent(url.pathname.slice(1));
    }
    if (resourceId) {
        const resource = await getCanvasResource(resourceId);
        if (resource.kind !== 'image' || !resource.mimeType.startsWith('image/') || resource.size > 50 * 1024 * 1024) throw new Error('参考图类型无效或超过五十兆');
        const bytes = await fs.readFile(resource.localPath);
        if (!bytes.length || bytes.length !== resource.size) throw new Error('参考图片已变化，请重新上传');
        return `data:${resource.mimeType};base64,${bytes.toString('base64')}`;
    }
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(address)) return address;
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('参考图需要已保存的本地图片或公开安全地址');
    return url.href;
}
async function messageContent(value: unknown): Promise<string | CanvasRecord[]> {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) throw new Error('助手消息内容无效');
    return Promise.all(value.map(async (raw: unknown): Promise<CanvasRecord> => {
        const part = object(raw);
        if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
        if (part.type === 'image_url') return { type: 'image_url', image_url: { url: await imageAddress(object(part.image_url).url) } };
        throw new Error('助手暂不支持此消息素材类型');
    }));
}
async function chatRequest(input: CanvasRecord): Promise<CanvasRecord> {
    const config = object(input.config);
    if (config.channelId !== 'lalor-api') throw new Error('画布智能助手请使用网站文本模型；本地文本模型请在文本节点中调用');
    const model = requiredText(config.model, '文本模型');
    if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('助手对话不能为空');
    const messages: CanvasRecord[] = [];
    if (typeof config.systemPrompt === 'string' && config.systemPrompt.trim()) messages.push({ role: 'system', content: config.systemPrompt });
    // 画布保存的是 Responses 风格工具回执；公共接口需要 Chat Completions 的成组 tool_calls。
    for (const raw of input.messages) {
        const message = object(raw);
        if (message.type === 'function_call') {
            const call = { id: requiredText(message.call_id, '工具调用编号'), type: 'function', function: { name: requiredText(message.name, '工具名称'), arguments: typeof message.arguments === 'string' ? message.arguments : '{}' } };
            const previous = messages[messages.length - 1];
            if (previous?.role === 'assistant' && previous.content === null && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
            else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        } else if (message.role === 'tool') {
            if (typeof message.content !== 'string') throw new Error('工具回执内容无效');
            messages.push({ role: 'tool', tool_call_id: requiredText(message.tool_call_id, '工具调用编号'), content: message.content });
        } else {
            if (!['system', 'user', 'assistant'].includes(String(message.role))) throw new Error('助手消息角色无效');
            messages.push({ role: message.role, content: await messageContent(message.content) });
        }
    }
    if (!Array.isArray(input.tools)) throw new Error('助手工具列表无效');
    const tools = input.tools.map((raw: unknown): CanvasRecord => {
        const tool = object(raw), fn = object(tool.function);
        if (tool.type !== 'function') throw new Error('助手工具类型无效');
        return { type: 'function', function: { name: requiredText(fn.name, '工具名称'), parameters: object(fn.parameters), ...(typeof fn.description === 'string' ? { description: fn.description } : {}), ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}) } };
    });
    const request: CanvasRecord = { model, messages, stream: false };
    if (tools.length) request.tools = tools;
    const choice = input.toolChoice;
    if (choice && choice !== 'auto') {
        if (!tools.length) throw new Error('此请求需要工具，但工具列表为空');
        if (choice === 'required') request.tool_choice = choice;
        else {
            const selected = object(choice);
            const name = requiredText(selected.name, '工具名称');
            if (selected.type !== 'function' || !tools.some((tool: CanvasRecord): boolean => object(tool.function).name === name)) throw new Error('所选工具不在允许列表中');
            request.tool_choice = { type: 'function', function: { name } };
        }
    }
    return request;
}
function resultFromResponse(value: CanvasRecord): CanvasRecord {
    if (!Array.isArray(value.choices) || !value.choices.length) throw new Error('文本模型未返回回答，请先核对网站记录');
    const message = object(object(value.choices[0]).message);
    const text = typeof message.content === 'string' ? message.content : '';
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('模型返回的工具调用格式无效');
    const toolCalls = ((message.tool_calls || []) as unknown[]).map((raw: unknown): CanvasRecord => {
        const call = object(raw), fn = object(call.function);
        if (call.type !== 'function' || typeof fn.arguments !== 'string') throw new Error('模型返回的工具调用格式无效');
        return { id: requiredText(call.id, '工具调用编号'), type: 'function', function: { name: requiredText(fn.name, '工具名称'), arguments: fn.arguments } };
    });
    if (!text.trim() && !toolCalls.length) throw new Error('文本模型未返回回答，请先核对网站记录');
    return { text, toolCalls };
}
function safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : '';
    if (/insufficient|balance|余额|积分不足/i.test(raw)) return '接口账户积分不足，请充值后再试';
    if (/api key|密钥|401|403|unauthorized|authentication/i.test(raw)) return '接口鉴权失败，请在接口设置中检查密钥和模型权限';
    if (/tool.*support|不支持.*工具/i.test(raw)) return '该文本模型不支持画布助手工具，请更换支持工具调用的文本模型';
    // 不把上游网址、堆栈或凭据写入任务记录。
    if (raw && /^[^A-Za-z]*[\u4e00-\u9fff][^A-Za-z]*$/.test(raw) && !/(?:密码|密钥|令牌)\s*[:：=]|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(raw)) return raw;
    return '文本请求未取得完整结果，未自动重发；请先核对网站调用记录';
}
async function execute(id: string, body: CanvasRecord, controller: AbortController): Promise<void> {
    try {
        const result = resultFromResponse(await canvasApiRequest('/chat/completions', body, undefined, 'POST', controller.signal));
        await transition(id, (task: AgentTask): AgentTask => ({ ...task, status: 'succeeded', progress: 100, stage: '回答已保存', resultJson: JSON.stringify(result), completedAt: new Date().toISOString() }));
    } catch (error) {
        await transition(id, (task: AgentTask): AgentTask => ({ ...task, status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? '已停止本地等待；已提交的请求是否计费以网站记录为准' : safeError(error), completedAt: new Date().toISOString() }));
    } finally { active.delete(id); }
}
export async function createCanvasAgentTurn(input: CanvasRecord): Promise<CanvasRecord> {
    const run = creating.catch((): void => undefined).then(async (): Promise<CanvasRecord> => {
        const owner = ownerId();
        const project = requiredText(input.projectId, '画布编号');
        const key = requiredText(input.idempotencyKey, '请求编号');
        const id = 'agent-' + createHash('sha256').update(JSON.stringify([owner, project, key])).digest('hex');
        const config = object(input.config);
        const requestHash = createHash('sha256').update(JSON.stringify([config.channelId, config.model, config.systemPrompt, input.messages, input.tools, input.toolChoice])).digest('hex');
        const existing = await canvasRead<AgentTask>(taskKey(id));
        if (existing) {
            if (existing.requestHash !== requestHash) throw new Error('同一请求编号对应的内容已变化，未重复提交');
            return getCanvasAgentTurn(id);
        }
        const body = await chatRequest(input);
        await requireLalorGenerationAccess();
        if (ownerId() !== owner) throw new Error('登录账号已变化，请重新提交');
        const now = new Date().toISOString();
        const task: AgentTask = { id, ownerId: owner, requestHash, projectId: project, type: 'canvas_agent_turn', model: body.model, prompt: requiredText(input.prompt, '消息', 100_000), status: 'running', progress: -1, stage: '正在等待文本模型回答', attempts: 1, createdAt: now, updatedAt: now };
        // 先保存编号再发起唯一一次请求，页面刷新只接回原任务，不重复扣费。
        await canvasWrite(taskKey(id), task);
        const controller = new AbortController();
        active.set(id, controller);
        void execute(id, body, controller).catch((): void => { console.error('[WorkbenchCanvas] 助手结果保存失败，保留原任务编号，未自动重发'); });
        return state(task);
    });
    creating = run;
    return run;
}
export async function getCanvasAgentTurn(id: string): Promise<CanvasRecord> {
    let task = await readTask(id);
    if (task.status === 'running' && !active.has(id)) {
        // 同步文本接口没有远端可查询编号，重启后不能假装继续查询或再次生成。
        task = await transition(id, (current: AgentTask): AgentTask => ({ ...current, status: 'failed', error: '原文本请求连接已中断，未自动重发；请先核对网站调用记录', completedAt: new Date().toISOString() }));
    }
    return state(task);
}
export async function cancelCanvasAgentTurn(id: string): Promise<CanvasRecord> {
    const task = await readTask(id);
    if (task.status !== 'running') return state(task);
    active.get(id)?.abort();
    return state(await transition(id, (current: AgentTask): AgentTask => ({ ...current, status: 'cancelled', stage: '已停止等待', error: '已停止本地等待；已提交的请求是否计费以网站记录为准', completedAt: new Date().toISOString() })));
}
