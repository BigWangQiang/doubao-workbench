export interface UploadReadinessSnapshot {
  inputFileCount: number;
  visibleAttachmentCount: number;
  matchingFileNameCount: number;
  pending: boolean;
  /** 真实缩略图去重计数；存在时禁止用 input.files 冒充上传完成。 */
  renderedAttachmentCount?: number;
}

export const MAX_REFERENCE_IMAGE_COUNT = 30;

/** 同一编辑区用于上传阶段和发送前复核，不能按固定 DOM 层数或整页判断。 */
export function buildComposerRootProbe(): string {
  return `(function() {
    var editor = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')).find(function(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return el.offsetParent !== null && r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (!editor) return null;
    var known = editor.closest('[class*="input-content-container"],.guidance-input-surface,[data-testid="chat-input"],[data-testid="chat_input"],form');
    if (known) return known;
    var root = editor.parentElement;
    for (var depth = 0; depth < 12 && root && root !== document.body; depth++, root = root.parentElement) {
      if (root.querySelector('input[type="file"],#flow-end-msg-send,[class*="send-msg-btn"],[aria-label="发送"],[aria-label="Send"]')) return root;
    }
    return null;
  })()`;
}

/**
 * 识别明确上传状态及素材缩略图上的百分比；排除提示词和普通页面进度。
 */
export function buildUploadPendingProbe(rootExpression: string): string {
  return `(function(root) {
    if (!root || !root.querySelectorAll) return true;
    var candidates = Array.from(root.querySelectorAll(
      '[aria-busy="true"],[data-status],[data-upload-status],[data-state],[role="progressbar"],[class*="upload"],[aria-label],[title],span,div'
    ));
    return candidates.some(function(el) {
      if (!el || el.offsetParent === null) return false;
      if (el.closest('textarea,[contenteditable],[role="textbox"]')) return false;
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
      if ((el.getAttribute('aria-busy') || '').toLowerCase() === 'true') return true;
      var status = [el.getAttribute('data-status'), el.getAttribute('data-upload-status'), el.getAttribute('data-state')]
        .filter(Boolean).join(' ').toLowerCase();
      if (/\\b(?:uploading|pending)\\b/.test(status)) return true;
      if ((el.getAttribute('role') || '').toLowerCase() === 'progressbar') {
        var rawNow = el.getAttribute('aria-valuenow');
        var rawMax = el.getAttribute('aria-valuemax');
        if (rawNow === null || rawNow === '') return true;
        var now = Number(rawNow);
        var max = rawMax === null || rawMax === '' ? 100 : Number(rawMax);
        if (!Number.isFinite(now) || !Number.isFinite(max) || now < max) return true;
        return false;
      }
      var percent = (el.textContent || '').trim().match(/^(\\d{1,3}(?:\\.\\d+)?)\\s*%$/);
      if (percent && el.children.length === 0) {
        var tile = el.parentElement;
        for (var depth = 0; depth < 5 && tile && tile !== root; depth++, tile = tile.parentElement) {
          var tileRect = tile.getBoundingClientRect();
          if (tileRect.width <= 320 && tileRect.height <= 240 && tile.querySelector('img,video,audio,[class*="thumb"]')) {
            return Number(percent[1]) < 100;
          }
        }
      }
      var descriptor = [
        typeof el.className === 'string' ? el.className : '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('data-testid') || ''
      ].join(' ').toLowerCase();
      return /upload/.test(descriptor) && /(?:uploading|pending|loading|progress)/.test(descriptor);
    });
  })(${rootExpression})`;
}

/** 只统计当前编辑区里真实出现的素材，不重复计算缩略图外层容器。 */
export function buildImageUploadSnapshotProbe(fileNames: string[]): string {
  return `(function() {
    var root = ${buildComposerRootProbe()};
    if (!root) return { inputFileCount: 0, visibleAttachmentCount: 0, renderedAttachmentCount: 0, matchingFileNameCount: 0, pending: true };
    var visible = function(el) {
      var r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
      return el.offsetParent !== null && r.width > 12 && r.height > 12 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    var candidates = Array.from(root.querySelectorAll('img,[class*="thumb"],[class*="preview"],[class*="attachment"],[class*="upload-item"]')).filter(function(el) {
      return visible(el) && !el.closest('textarea,[contenteditable],[role="textbox"]');
    });
    var attachments = candidates.filter(function(el) {
      return !candidates.some(function(child) { return child !== el && el.contains(child); });
    });
    var text = attachments.map(function(el) {
      return [el.textContent, el.getAttribute('alt'), el.getAttribute('title')].filter(Boolean).join(' ');
    }).join(' ');
    var names = ${JSON.stringify(fileNames)};
    var inputFileCount = Array.from(root.querySelectorAll('input[type="file"]')).reduce(function(max, input) {
      return Math.max(max, input.files ? input.files.length : 0);
    }, 0);
    return { inputFileCount: inputFileCount, visibleAttachmentCount: attachments.length, renderedAttachmentCount: attachments.length,
      matchingFileNameCount: names.filter(function(name) { return text.indexOf(name) >= 0; }).length,
      pending: ${buildUploadPendingProbe('root')} };
  })()`;
}

export type UploadReadinessFailure = 'pending' | 'count_incomplete' | 'count_mismatch' | 'unstable';

export interface UploadReadinessDiagnostic {
  attempts: number;
  elapsedMs: number;
  expectedCount: number;
  observedCount: number;
  pending: boolean;
  stableSamples: number;
  failure?: UploadReadinessFailure;
}

export function getObservedUploadCount(snapshot: UploadReadinessSnapshot, baselineAttachmentCount: number): number {
  if (snapshot.renderedAttachmentCount !== undefined) {
    return Math.max(0, snapshot.renderedAttachmentCount - baselineAttachmentCount);
  }
  return Math.max(
    snapshot.inputFileCount,
    snapshot.matchingFileNameCount,
    Math.max(0, snapshot.visibleAttachmentCount - baselineAttachmentCount),
  );
}

/** 上传必须数量足够、无进行中标记，并连续多次保持稳定。 */
export function isUploadSnapshotReady(
  snapshot: UploadReadinessSnapshot,
  expectedCount: number,
  baselineAttachmentCount: number,
): boolean {
  const observedCount = getObservedUploadCount(snapshot, baselineAttachmentCount);
  return expectedCount > 0 && observedCount === expectedCount && !snapshot.pending;
}

export function classifyUploadReadinessFailure(
  snapshot: UploadReadinessSnapshot,
  expectedCount: number,
  baselineAttachmentCount: number,
): UploadReadinessFailure | undefined {
  const observed = getObservedUploadCount(snapshot, baselineAttachmentCount);
  if (snapshot.pending) return 'pending';
  if (observed < expectedCount) return 'count_incomplete';
  if (observed > expectedCount) return 'count_mismatch';
  return undefined;
}

export function nextStableUploadCount(
  previous: number,
  snapshot: UploadReadinessSnapshot,
  expectedCount: number,
  baselineAttachmentCount: number,
): number {
  return isUploadSnapshotReady(snapshot, expectedCount, baselineAttachmentCount) ? previous + 1 : 0;
}
