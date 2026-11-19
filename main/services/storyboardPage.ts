import { STORYBOARD_PAGE_CONTROLS } from './storyboardPageControls';
import { STORYBOARD_PAGE_NAVIGATION } from './storyboardPageNavigation';
import { STORYBOARD_PARAMETER_MENU } from './storyboardParameterMenu';

/** 仅在所选账号的豆包页面执行。所有回执绑定节点 ID，未确认的提交不得重发。 */
export const STORYBOARD_PAGE_SCRIPT = String.raw`(() => {
  if (window.__lalorStoryboardV1) return true;
  const state = { stopped: false, replies: {}, requests: {}, retries: {}, requestSequence: 0, registrations: [], uploads: {}, verified: {}, activeNodeId: undefined };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el?.isConnected && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const waitFor = async (find, label, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (state.stopped) throw Error('已停止后续页面操作');
      const value = find(); if (value) return value;
      await delay(25);
    }
    throw Error('等待' + label + '超时');
  };
` + STORYBOARD_PAGE_CONTROLS + STORYBOARD_PARAMETER_MENU + STORYBOARD_PAGE_NAVIGATION + String.raw`
  const origin = location.origin;
  const compact = text => String(text || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
  const promptText = editor => {
    const copy = editor.cloneNode(true);
    copy.querySelectorAll('.node-canvasReferenceChip,[data-canvas-reference-chip]').forEach(chip => chip.remove());
    return compact(copy.textContent);
  };
  const attachmentImages = editor => [...(editor.closest('[data-canvas-generation-composer]')?.querySelectorAll('img:not([aria-hidden="true"])') || [])].filter(visible);
  const nodeComposer = id => document.querySelector('[data-canvas-generation-composer="video"][data-canvas-generation-item-id="' + CSS.escape(id) + '"]');
  const attachmentKeys = editor => attachmentImages(editor).map(img => {
    const resource = img.closest('[data-canvas-open-resource-id]')?.getAttribute('data-canvas-open-resource-id');
    if (resource) return resource;
    const url = new URL(img.currentSrc || img.src, location.href);
    if (!['https:', 'blob:'].includes(url.protocol)) throw Error('参考图没有可回读的素材标识');
    url.search = ''; url.hash = '';
    return url.href;
  });
  const sameOrder = (actual, expected) => actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  const selector = id => '.react-flow__node[data-id="' + CSS.escape(id) + '"]';
  const nodeEntity = id => canvasApi().binding.getProjectionState().document?.itemsById[id];
  const identity = () => ({ canvasId: canvasApi().runtime.key.canvasId, url: location.href });
  const ensureIdentity = canvasId => { if (!canvasId || identity().canvasId !== canvasId) throw Error('当前画布已切换，已停止操作'); };
  const focusNode = async id => {
    if (state.stopped) throw Error('已停止后续页面操作');
    const api = canvasApi(), entity = nodeEntity(id);
    if (!entity) throw Error('原视频节点不存在，未自动重建');
    // 抓手模式不会打开节点编辑器。使用页面自身的工具和选择状态，不向提示词输入 V。
    if (!api.runtime.tools?.activate || !api.runtime.selection?.set) throw Error('当前画布不支持节点选择，请重新打开画布');
    api.runtime.tools.handleBoundary();
    api.runtime.tools.activate('select');
    if (api.runtime.tools.get().effectiveTool !== 'select') throw Error('无法切换到 V 选择模式');
    const view = api.binding.getViewportSize(), t = entity.transform;
    api.binding.setViewport({ x: view.width / 2 - (t.x + t.width / 2) * 0.25, y: view.height / 2 - (t.y + t.height / 2) * 0.25, zoom: 0.25 });
    api.runtime.selection.set([id], 'replace');
    // 视口改变会重挂载节点，必须重新查询；也不能先点空白区导致草稿被回收。
    await waitFor(() => {
      const node = document.querySelector(selector(id)), ids = api.runtime.selection.get().ids;
      return ids.length === 1 && ids[0] === id && node?.classList.contains('selected');
    }, '节点选中');
    state.activeNodeId = id;
    return document.querySelector(selector(id));
  };
  const selectNode = async id => {
    await focusNode(id);
    return waitFor(() => [...(nodeComposer(id)?.querySelectorAll('.tiptap[contenteditable="true"]') || [])].find(visible), '当前视频节点输入框');
  };
  // 整批复核后用户手动修改、点击或切换模式会使复核票据失效，不能继续快速发送。
  for (const name of ['pointerdown', 'keydown', 'input', 'change']) document.addEventListener(name, event => {
    if (event.isTrusted) state.verified = {};
  }, true);
  const draftSignature = id => {
    const entity = nodeEntity(id);
    // 服务端保存确认会推进 version，不代表用户修改了提示词、素材或生成参数。
    return JSON.stringify(entity && { status: entity.status, editor: entity.editor, asset: entity.asset, ext: entity.ext });
  };
  const sendButton = id => [...(nodeComposer(id)?.querySelectorAll('button[data-testid="chat_input_send_button"],button#flow-end-msg-send') || [])]
    .find(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.dataset.disabled !== 'true' && el.dataset.loading !== 'true');
  const checkDraft = (input, editor) => {
    if (promptText(editor) !== compact(input.prompt)) throw Error('节点提示词已变化，请核对后重新准备');
    if (attachmentImages(editor).length !== input.imageCount || !sameOrder(attachmentKeys(editor), input.expectedKeys)) throw Error('参考图顺序或内容与准备记录不一致，已阻止发送');
    if (['done', 'generating', 'failed'].includes(observe(input.nodeId).state)) throw Error('节点已有生成记录，不得再次发送');
    if ([...document.querySelectorAll('[role="dialog"],[aria-modal="true"],button[aria-label="取消选择参考素材"]')].some(visible)) throw Error('豆包存在待处理弹窗或素材选择，请处理后继续');
  };
  const writePrompt = async (editor, prompt) => {
    editor.focus(); window.getSelection().selectAllChildren(editor);
    if (editor.textContent.trim() && !document.execCommand('delete')) throw Error('无法清空提示词');
    if (!document.execCommand('insertText', false, prompt)) throw Error('无法写入提示词');
    await waitFor(() => promptText(editor) === compact(prompt), '提示词回读');
  };
  const requestInfo = (url, body) => {
    let pathname = ''; try { pathname = new URL(url, origin).pathname; } catch {}
    let req; try { req = JSON.parse(body).req; } catch {}
    return { pathname, nodeId: req?.biding_item?.id || req?.binding_item?.id };
  };
  const recordReply = (info, status, body) => {
    let code; try { code = (typeof body === 'string' ? JSON.parse(body) : body)?.code; } catch {}
    const result = { status, code, ok: status >= 200 && status < 300 && code === 0, at: Date.now() };
    if (info.pathname === '/alice/resource/register') state.registrations.push(result);
    if (info.pathname === '/creativity/canvas_workspace/tool/exec' && info.nodeId && state.requests[info.nodeId]?.sequence === info.sequence) state.replies[info.nodeId] = { ...result, sequence: info.sequence };
  };
  const recordRequest = info => {
    if (info.pathname === '/creativity/canvas_workspace/tool/exec' && info.nodeId) {
      info.sequence = ++state.requestSequence;
      state.requests[info.nodeId] = { sequence: info.sequence, at: Date.now() };
      delete state.replies[info.nodeId];
    }
    return info;
  };
  // 与页面共享 MAIN world；扩展原上传监听在隔离世界里，不能直接照搬。
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { this.__lalorBatchUrl = url; return open.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function(body) {
    const info = recordRequest(requestInfo(this.__lalorBatchUrl, body));
    this.addEventListener('loadend', () => { let text = ''; try { text = this.responseType === 'json' ? this.response : this.responseText; } catch {} recordReply(info, this.status, text); }, { once: true });
    return send.call(this, body);
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const infoPromise = typeof init?.body === 'string' ? Promise.resolve(requestInfo(url, init.body))
      : input instanceof Request ? input.clone().text().then(body => requestInfo(url, body)).catch(() => requestInfo(url, ''))
      : Promise.resolve(requestInfo(url, ''));
    void infoPromise.then(recordRequest);
    return originalFetch.apply(this, arguments).then(response => {
      const copy = response.clone();
      infoPromise.then(info => {
        if (info.pathname === '/alice/resource/register' || info.pathname === '/creativity/canvas_workspace/tool/exec') return copy.text().then(body => recordReply(info, response.status, body));
      }).catch(() => {});
      return response;
    });
  };
  const readProgress = node => {
    if (!node) return undefined;
    const meter = node.querySelector('[role="progressbar"][aria-valuenow],progress[value]');
    if (meter) {
      const raw = meter.getAttribute('aria-valuenow') ?? meter.getAttribute('value');
      const min = Number(meter.getAttribute('aria-valuemin') ?? 0);
      const max = Number(meter.getAttribute('aria-valuemax') ?? meter.getAttribute('max') ?? 100);
      const value = raw === null ? NaN : Number(raw);
      if (Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && max > min && value >= min && value <= max) return Math.round((value - min) / (max - min) * 100);
    }
    const region = node.querySelector('[data-canvas-generation-state="generating"],[data-canvas-generation-state="loading"],[data-canvas-generation-state="pending"]');
    // 只读生成状态区域的百分比，不能把提示词里写的百分比当进度。
    const matches = region?.textContent.match(/(?:^|[^\d])(\d{1,3}(?:\.\d+)?)\s*[%％]/g) || [];
    if (matches.length === 1) {
      const value = Number(matches[0].match(/\d+(?:\.\d+)?/)[0]);
      if (value >= 0 && value <= 100) return Math.round(value);
    }
    return undefined;
  };
  const retryButtons = node => [...(node?.querySelectorAll('button,[role="button"]') || [])]
    .filter(el => visible(el) && compact(el.textContent || el.getAttribute('aria-label')) === '重新生成');
  const retryBlocker = node => {
    // 只检查节点和可见弹窗，不扫描提示词或其他节点，避免把创作内容当平台错误。
    const copy = node?.cloneNode(true);
    copy?.querySelectorAll('[data-canvas-generation-composer],.tiptap').forEach(el => el.remove());
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
    const text = compact(copy?.textContent) + dialogs.map(el => compact(el.textContent)).join('');
    if (/审核|违规|不符合|不支持|敏感|版权|安全策略|额度|余额|积分不足|次数.*(?:用完|不足|上限)|登录|验证|风控|升级|购买|订阅|频繁|限流/.test(text)) return '节点有审核、账号或额度限制，请人工处理';
    if (dialogs.length) return '豆包有待处理弹窗，请先人工处理';
    return undefined;
  };
  const retryReceipt = (id, attemptId) => {
    const retry = state.retries[id];
    if (!retry || retry.attemptId !== attemptId) return { attemptId, status: 'unknown', message: '页面已刷新或重试回执丢失，请核对原节点' };
    const request = state.requests[id], reply = state.replies[id];
    if (request?.sequence > retry.beforeSequence && reply?.sequence === request.sequence) {
      return { attemptId, status: reply.ok ? 'settled' : 'blocked', message: reply.ok ? undefined : '重新生成回执未受理：HTTP ' + reply.status + '，业务码 ' + String(reply.code) };
    }
    return { attemptId, status: Date.now() - retry.at < 25000 ? 'waiting' : 'unknown', message: '重新生成回执未确认，未继续点击' };
  };
  const observe = id => {
    const entity = nodeEntity(id);
    if (!entity) return { state: 'missing' };
    const node = document.querySelector(selector(id));
    const progress = readProgress(node);
    const video = node?.querySelector('video');
    const candidates = [video?.currentSrc, video?.getAttribute('src'), video?.querySelector('source')?.src, entity.asset?.uri];
    const url = candidates.find(value => typeof value === 'string' && value.startsWith('https://'));
    if (url && (video || ['ready', 'success', 'succeeded', 'done'].includes(entity.asset?.status) || node?.querySelector('[data-canvas-generation-state="ready"]'))) return { state: 'done', url, progress: 100 };
    const status = String(entity.status || '') + ' ' + String(entity.asset?.status || '');
    if (/generating|processing|running|queued|loading/.test(status) || progress !== undefined || node?.querySelector('[data-canvas-generation-state="generating"],[data-canvas-generation-state="loading"]')) return { state: 'generating', progress };
    if (/failed|error/.test(status) || retryButtons(node).length) {
      const blocker = retryBlocker(node);
      return { state: 'failed', retryable: !blocker, message: blocker || '豆包节点显示视频生成失败' };
    }
    return { state: 'unknown', progress };
  };
  const api = {
    stop() { state.stopped = true; return true; },
    reset() { state.stopped = false; state.verified = {}; return true; },
    identity,
    parserSnapshot(input) {
      ensureIdentity(input.canvasId);
      return { canvasId: input.canvasId, items: Object.values(canvasApi().binding.getProjectionState().document?.itemsById || {}) };
    },
    enter: enterCanvas,
    expand: expandCanvas,
    reopen: reopenCanvas,
    async create(input) {
      ensureIdentity(input.canvasId);
      // 创建回执中断时按分镜身份找回，不能因重试多建一个视频节点。
      const existing = Object.values(canvasApi().binding.getProjectionState().document?.itemsById || {})
        .filter(item => item.ext?.lalorStoryboardRowId === input.rowId);
      if (existing.length > 1) throw Error('此分镜存在多个原节点，请先在豆包画布核对');
      if (existing.length === 1) return { nodeId: existing[0].id };
      const api = canvasApi(), size = sizeFor(input), column = input.index % 5, row = Math.floor(input.index / 5);
      const point = { x: column * 2800, y: row * 2800 };
      const result = api.runtime.itemCreation.create({ key: api.runtime.key, requestId: 'lalor:' + input.rowId,
        size, placement: { viewportCenter: { x: point.x + size.width / 2, y: point.y + size.height / 2 }, viewportZoom: api.runtime.coordinates.getViewport().zoom,
          intent: { anchor: { type: 'world-point', point, alignment: 'top-left' }, collision: { type: 'allow-overlap' }, scope: { type: 'root' } } },
        draft: { kind: 'video', editor: true, title: '分镜' + input.number, status: 'ready', createdBy: 'ai', asset: { id: '', kind: 'video', uri: '', status: 'init', ext: {} }, ext: { lalorStoryboardRowId: input.rowId } } });
      if (result.status !== 'created' || !result.ref?.entityId) throw Error('视频节点创建未确认，请核对原画布');
      await waitFor(() => nodeEntity(result.ref.entityId), '视频节点保存');
      return { nodeId: result.ref.entityId };
    },
    async resumeDraft(input) {
      ensureIdentity(input.canvasId);
      if (!nodeEntity(input.nodeId)) return { missing: true, referenceKeys: [] };
      const editor = await selectNode(input.nodeId), entity = nodeEntity(input.nodeId);
      const status = observe(input.nodeId).state;
      if (status !== 'unknown' || entity.editor !== true || entity.status !== 'ready' || entity.asset?.uri || (entity.asset?.status && entity.asset.status !== 'init')) throw Error('原节点已有生成状态，不能覆盖或重新发送，请找回进度');
      const text = promptText(editor);
      if (text && text !== compact(input.prompt)) throw Error('原节点提示词已被修改，请核对原画布后再继续准备');
      const keys = attachmentKeys(editor);
      // 仅复用有持久回执的有序前缀；未知附件不猜测、不删除，也不重复上传。
      if (keys.length > input.expectedKeys.length || !sameOrder(keys, input.expectedKeys.slice(0, keys.length))) throw Error('原节点附件与上传记录不一致，请在原节点移除未确认的附件后继续准备');
      return { missing: false, referenceKeys: keys };
    },
    async fill(input) {
      ensureIdentity(input.canvasId);
      await selectNode(input.nodeId);
      await setParameters({ model: input.model.replace('seedance-', 'seedance_v').replace('-fast', '_fast').replace('-mini', '_mini'), ratio: input.ratio, duration: input.duration, resolution: input.resolution });
      // 切换模型/参数可能重挂载编辑器，必须重新按节点 ID 获取，不能写入底部主对话框。
      const editor = await selectNode(input.nodeId);
      await writePrompt(editor, input.prompt);
      return { filled: true };
    },
    async upload(input) {
      ensureIdentity(input.canvasId);
      const editor = await selectNode(input.nodeId), composer = nodeComposer(input.nodeId);
      if (promptText(editor) !== compact(input.prompt)) throw Error('提示词与当前分镜不符，已阻止上传');
      if (attachmentImages(editor).length !== input.imageIndex) throw Error('当前参考图数量与分镜顺序不一致，已停止上传');
      if (!sameOrder(attachmentKeys(editor), input.expectedKeys)) throw Error('先前参考图的顺序或内容已变化，已停止上传');
      const before = new Set([...composer.querySelectorAll('img')].filter(visible)), registrationStart = state.registrations.length;
      const getUploadTrigger = () => [...(nodeComposer(input.nodeId)?.querySelectorAll('[data-testid="upload_file_button"]') || [])].find(visible);
      const plus = getUploadTrigger();
      if (!plus) throw Error('找不到当前节点的上传按钮');
      const findUploadChoice = () => [...document.querySelectorAll('button,[role="menuitem"],[role="button"]')].find(el => visible(el) && el.textContent.trim() === '上传文件');
      plus.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const choice = await openMenu(getUploadTrigger, findUploadChoice, '上传文件菜单', 'pointer');
      const nativeClick = HTMLInputElement.prototype.click, nativePicker = HTMLInputElement.prototype.showPicker;
      const beforeInputs = new Set(document.querySelectorAll('input[type="file"]'));
      let chosenInput;
      try {
        HTMLInputElement.prototype.click = function(...args) { if (this.type === 'file') { chosenInput = this; return; } return nativeClick.apply(this, args); };
        if (nativePicker) HTMLInputElement.prototype.showPicker = function(...args) { if (this.type === 'file') { chosenInput = this; return; } return nativePicker.apply(this, args); };
        choice.click();
        const fileInput = await waitFor(() => {
          if (chosenInput) return chosenInput;
          const added = [...document.querySelectorAll('input[type="file"]')].filter(el => !beforeInputs.has(el) && /image|\.(?:png|jpe?g|webp)/i.test(el.accept));
          return added.length === 1 ? added[0] : undefined;
        }, '当前上传菜单创建的图片控件');
        const bytes = Uint8Array.from(atob(input.base64), c => c.charCodeAt(0));
        const file = new File([bytes], input.name, { type: input.mime });
        const transfer = new DataTransfer(); transfer.items.add(file);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set.call(fileInput, transfer.files);
        fileInput.dispatchEvent(new Event('input', { bubbles: true })); fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => {
          const replies = state.registrations.slice(registrationStart);
          if (replies.some(reply => !reply.ok)) throw Error('豆包素材注册失败');
          const images = attachmentImages(editor);
          return replies.some(reply => reply.ok) && images.length === input.imageIndex + 1 && images.some(img => !before.has(img));
        }, '图片注册及附件回读', 90000);
        state.uploads[input.nodeId] = input.imageIndex + 1;
        const keys = attachmentKeys(editor);
        if (!sameOrder(keys.slice(0, -1), input.expectedKeys)) throw Error('豆包附件顺序发生变化，已停止本分镜');
        if (new Set(keys).size !== keys.length) throw Error('豆包附件标识重复，无法确认图片顺序');
        return { uploaded: true, referenceKeys: keys };
      } finally { HTMLInputElement.prototype.click = nativeClick; if (nativePicker) HTMLInputElement.prototype.showPicker = nativePicker; }
    },
    async verify(input) {
      ensureIdentity(input.canvasId);
      const editor = await selectNode(input.nodeId);
      if (promptText(editor) !== compact(input.prompt)) throw Error('节点提示词已变化，请核对后重新准备');
      if (attachmentImages(editor).length !== input.imageCount) throw Error('参考图尚未全部保存到此节点，已阻止发送');
      if (!sameOrder(attachmentKeys(editor), input.expectedKeys)) throw Error('参考图顺序或内容与准备记录不一致，已阻止发送');
      if (['done', 'generating', 'failed'].includes(observe(input.nodeId).state)) throw Error('节点已有生成记录，不得再次发送');
      const model = [...nodeComposer(input.nodeId).querySelectorAll('button[data-input-engine-actionbar-control-key="video-model"]')].find(visible);
      const params = await readParameters();
      const label = { 'seedance-2.5': 'Seedance 2.5', 'seedance-2.0': 'Seedance 2.0', 'seedance-2.0-fast': 'Seedance 2.0 Fast', 'seedance-2.0-mini': 'Seedance 2.0 Mini' }[input.model];
      if (![...(model?.querySelectorAll('span') || [])].some(el => el.textContent.trim() === label) || params.ratio !== input.ratio || params.duration !== input.duration || (input.resolution && params.resolution !== input.resolution)) throw Error('模型、比例、时长或分辨率回读不一致');
      await closeParameters();
      const dialog = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find(visible);
      if (dialog) throw Error('豆包存在待处理弹窗，请在账号窗口处理后继续');
      const button = sendButton(input.nodeId);
      if (!button) throw Error('当前节点无法提交，请检查额度、登录和素材授权');
      if ([...document.querySelectorAll('button[aria-label="取消选择参考素材"]')].some(visible)) throw Error('节点仍在选择参考素材，请先结束选择');
      state.verified[input.nodeId] = { input: JSON.stringify(input), draft: draftSignature(input.nodeId), at: Date.now(), model: label };
      return { verified: true };
    },
    async submit(input) {
      let button;
      // 只有点击前的校验失败能明确返回未点击；click 本身报错仍可能已发出请求。
      try {
        ensureIdentity(input.canvasId);
        const ticket = state.verified[input.nodeId];
        if (!ticket || ticket.input !== JSON.stringify(input) || Date.now() - ticket.at > 300000) throw Error('发送前复核已失效，请重新复核整批节点');
        const editor = await selectNode(input.nodeId);
        checkDraft(input, editor);
        const model = nodeComposer(input.nodeId)?.querySelector('button[data-input-engine-actionbar-control-key="video-model"]');
        if (draftSignature(input.nodeId) !== ticket.draft || ![...(model?.querySelectorAll('span') || [])].some(el => el.textContent.trim() === ticket.model)) throw Error('节点配置已变化，已停止发送');
        if (state.verified[input.nodeId] !== ticket) throw Error('复核后发生手动操作，请重新确认整批节点');
        if (state.stopped) throw Error('已暂停，未点击发送');
        button = sendButton(input.nodeId);
        if (!button) throw Error('发送按钮状态已变化，未点击发送');
      } catch (error) {
        return { clicked: false, message: error instanceof Error ? error.message : String(error) };
      }
      delete state.verified[input.nodeId];
      delete state.replies[input.nodeId];
      button.click();
      // 点击与受理分开：不等待网络回执再点击下一条，更不能把 clicked 当成 accepted。
      return { clicked: true };
    },
    async regenerate(input) {
      let button;
      try {
        ensureIdentity(input.canvasId);
        if (!input.attemptId || state.retries[input.nodeId]?.attemptId === input.attemptId) throw Error('此重试意图已经执行，未重复点击');
        const node = await focusNode(input.nodeId);
        const current = observe(input.nodeId);
        if (current.state !== 'failed' || current.retryable !== true) throw Error(current.message || '节点已不处于明确失败状态，未点击');
        const request = state.requests[input.nodeId], reply = state.replies[input.nodeId];
        if (request && reply?.sequence !== request.sequence) throw Error('节点仍有未结束的生成请求，未重复点击');
        const buttons = retryButtons(node);
        if (buttons.length !== 1) throw Error('当前节点没有唯一的重新生成按钮，请核对原画布');
        button = buttons[0];
        if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.dataset.disabled === 'true' || button.dataset.loading === 'true') throw Error('重新生成按钮暂不可用，未点击');
        if (state.stopped) throw Error('已暂停，未点击重新生成');
        // 选择过程可能切换画布或被手动操作打断，点击前再次核对身份。
        ensureIdentity(input.canvasId);
        const ids = canvasApi().runtime.selection.get().ids;
        if (ids.length !== 1 || ids[0] !== input.nodeId || !button.isConnected) throw Error('节点选择已变化，未点击重新生成');
      } catch (error) {
        return { clicked: false, message: error instanceof Error ? error.message : String(error) };
      }
      state.retries[input.nodeId] = { attemptId: input.attemptId, at: Date.now(), beforeSequence: state.requests[input.nodeId]?.sequence || 0 };
      button.click();
      return { clicked: true };
    },
    async confirmUnsentDraft(input) {
      ensureIdentity(input.canvasId);
      const entity = nodeEntity(input.nodeId);
      if (!entity || entity.editor !== true || entity.status !== 'ready' || entity.asset?.uri || (entity.asset?.status && entity.asset.status !== 'init')) throw Error('原节点不是未生成草稿，不能恢复发送');
      if (state.requests[input.nodeId] || state.replies[input.nodeId] || observe(input.nodeId).state !== 'unknown') throw Error('此节点存在发送或生成记录，请继续查询，不能恢复草稿');
      // 该检查只佐证人工核对；不能把缺少回执自动当作从未提交。
      return { draft: true };
    },
    async receipts(input) {
      ensureIdentity(input.canvasId);
      const deadline = Date.now() + 25000;
      while (input.nodeIds.some(id => !state.replies[id]) && Date.now() < deadline) {
        if (state.stopped) break;
        await delay(50);
      }
      return input.nodeIds.map(nodeId => {
        const reply = state.replies[nodeId];
        return { nodeId, accepted: reply?.ok === true, message: reply ? '豆包受理回执：HTTP ' + reply.status + '，业务码 ' + String(reply.code) : '提交回执未确认，请查询原节点，禁止自动重发' };
      });
    },
    async observe(input) {
      ensureIdentity(input.canvasId);
      const result = observe(input.nodeId);
      return input.attemptId ? { ...result, retryReceipt: retryReceipt(input.nodeId, input.attemptId) } : result;
    },
    async overview(input) {
      ensureIdentity(input.canvasId);
      const items = input.nodeIds.map(nodeEntity).filter(Boolean);
      if (!items.length) throw Error('原画布中没有可查询的分镜节点');
      const bounds = items.map(item => item.transform);
      const left = Math.min(...bounds.map(item => item.x)), top = Math.min(...bounds.map(item => item.y));
      const right = Math.max(...bounds.map(item => item.x + item.width)), bottom = Math.max(...bounds.map(item => item.y + item.height));
      const canvas = canvasApi(), view = canvas.binding.getViewportSize();
      const zoom = Math.min(0.25, (view.width - 80) / (right - left), (view.height - 80) / (bottom - top));
      if (!Number.isFinite(zoom) || zoom <= 0) throw Error('无法读取分镜画布视口');
      canvas.binding.setViewport({ x: view.width / 2 - (left + right) / 2 * zoom, y: view.height / 2 - (top + bottom) / 2 * zoom, zoom });
      return { visible: items.length };
    }
  };
  window.__lalorStoryboardV1 = api;
  return true;
})()`;
