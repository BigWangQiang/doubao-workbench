// 豆包画布视频解析器 - background service worker v1.0.1
// 流程: webRequest 捕获 canvas_workspace 请求 -> 页面内重放拿画布文档
//      兜底: chrome.debugger 直接读取画布文档响应
//      -> 提取 fallback_api -> 改参请求 (codec_type=8 & logo_type=unwatermarked)
//      -> 解码 main_url (qAAB/AES-CBC, key_seed 派生密钥) -> 返回原始地址

const QAAB_SALT_HEX =
  '4dd4c2e6b83162090e52b3c7a6733ba4' +
  '1cb2462b829ab58a196b39db57177524' +
  'f49baf7f08e8d68d26a72e37c1a95a2f' +
  '1f05a51892aef2949732b62a38aadd58';

// ---------- 1. 捕获画布文档请求 ----------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !/canvas_workspace/.test(details.url)) return;
    let post = '';
    const rb = details.requestBody;
    if (rb && rb.raw) {
      post = (rb.raw || [])
        .map((b) => { try { return new TextDecoder().decode(b); } catch (e) { return ''; } })
        .join('');
    } else if (rb && rb.formData) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(rb.formData)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
      post = p.toString();
    }
    saveCapture(details.tabId, { url: details.url, method: details.method, post, ts: Date.now() });
  },
  { urls: ['*://www.doubao.com/*'] },
  ['requestBody']
);

async function saveCapture(tabId, req) {
  const key = 'cap_' + tabId;
  const store = await chrome.storage.session.get(key);
  const arr = store[key] || [];
  arr.push(req);
  if (arr.length > 10) arr.shift();
  await chrome.storage.session.set({ [key]: arr });
}

async function getCaptures(tabId) {
  const key = 'cap_' + tabId;
  const store = await chrome.storage.session.get(key);
  return store[key] || [];
}

// ---------- 2. 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'PARSE') {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    if (tabId) handleParse(tabId);
  } else if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download({ url: msg.url, filename: 'doubao-videos/' + msg.name, conflictAction: 'uniquify' });
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: 'DO_PARSE' }).catch(() => {});
});

function status(tabId, text) {
  chrome.tabs.sendMessage(tabId, { type: 'STATUS', text }).catch(() => {});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openCanvasSafe(tabId) {
  for (let i = 0; i < 6; i++) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'OPEN_CANVAS' }); return; } catch (e) { await sleep(1000); }
  }
}

// ---------- 3. 主流程 ----------
async function handleParse(tabId) {
  try {
    status(tabId, '等待画布数据…');
    let caps = await getCaptures(tabId);
    if (!caps.length) {
      status(tabId, '尝试自动打开画布…');
      await openCanvasSafe(tabId);
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        caps = await getCaptures(tabId);
        if (caps.length) break;
      }
    }
    if (!caps.length) {
      status(tabId, '未捕获到画布数据，请先在聊天里手动点开一次画布，再点解析');
      return;
    }

    // 通道 A: 页面内重放（无调试提示条）
    status(tabId, '正在读取画布文档…');
    let doc = await replayDoc(tabId, caps.slice(-8));
    let viaReplay = true;

    if (!doc || doc.startsWith('DIAG:')) {
      const diag = doc && doc.startsWith('DIAG:') ? doc.slice(5) : '';
      // 通道 B: chrome.debugger 直接读响应
      status(tabId, '切换直读模式（浏览器顶部可能出现调试提示，属正常）…');
      doc = await captureDocViaDebugger(tabId);
      viaReplay = false;
      if (!doc) {
        const d = diag ? ' [' + diag + ']' : '';
        status(tabId, '读取画布文档失败' + d + '，请刷新豆包页面后重试');
        return;
      }
    }

    status(tabId, '提取视频地址…');
    const apis = extractFallbackApis(doc);
    if (!apis.length) {
      status(tabId, '该画布文档中没有视频（' + (viaReplay ? '重放' : '直读') + '通道）');
      return;
    }

    const results = [];
    for (let i = 0; i < apis.length; i++) {
      status(tabId, `解析视频 ${i + 1}/${apis.length}…`);
      const r = { url: '', size: 0, expires: 0 };
      try {
        r.url = await resolveOne(apis[i]);
        if (r.url) {
          const u = new URL(r.url);
          r.expires = parseInt(u.searchParams.get('x-expires') || '0', 10) || 0;
          r.size = await probeSize(r.url);
        }
      } catch (e) {
        r.error = e.message;
      }
      results.push(r);
    }
    chrome.tabs.sendMessage(tabId, { type: 'PARSE_RESULT', results }).catch(() => {});
  } catch (e) {
    status(tabId, '出错: ' + (e.message || e));
  }
}

// ---------- 4. 通道 A: 页面内重放 ----------
function replayDocInPage(reqs) {
  return (async () => {
    const diag = [];
    const ctypes = ['application/json', 'application/json; encoding=utf-8'];
    for (const p of reqs) {
      for (const ct of ctypes) {
        try {
          const opt = { method: p.method, credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } };
          if (p.post) { opt.body = p.post; opt.headers['content-type'] = ct; }
          const r = await fetch(p.url, opt);
          const t = await r.text();
          if (/fallback_api|b-video/.test(t)) return t;
          diag.push(r.status + '/' + t.length);
        } catch (e) {
          diag.push('ERR:' + String(e).slice(0, 40));
        }
      }
    }
    return 'DIAG:' + [...new Set(diag)].slice(0, 5).join(',');
  })();
}

async function replayDoc(tabId, reqs) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: replayDocInPage,
    args: [reqs.map((r) => ({ url: r.url, method: r.method, post: r.post }))]
  });
  return res && res.result ? res.result : '';
}

// ---------- 4b. 通道 B: debugger 直读响应 ----------
async function captureDocViaDebugger(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return '';
  }
  let done = false;
  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });

  const cleanup = async () => {
    chrome.debugger.onEvent.removeListener(handler);
    chrome.debugger.onDetach.removeListener(onDetach);
    try { await chrome.debugger.detach(target); } catch (e) {}
  };
  const finish = (body) => {
    if (done) return;
    done = true;
    resolveFn(body || '');
    cleanup();
  };
  const onDetach = (src) => {
    if (src.tabId === tabId && !done) {
      done = true;
      resolveFn('');
      chrome.debugger.onEvent.removeListener(handler);
    }
  };
  const handler = async (src, method, params) => {
    if (src.tabId !== tabId || done) return;
    if (method === 'Network.responseReceived' && /canvas_workspace/.test(params.response.url)) {
      const requestId = params.requestId;
      for (let i = 0; i < 6; i++) {
        await sleep(400);
        try {
          const b = await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId });
          if (b && b.body && /fallback_api|b-video/.test(b.body)) return finish(b.body);
        } catch (e) {}
      }
    }
  };

  chrome.debugger.onDetach.addListener(onDetach);
  chrome.debugger.onEvent.addListener(handler);
  await chrome.debugger.sendCommand(target, 'Network.enable').catch(() => {});

  try {
    // 第一轮: 点画布卡片，等待响应
    await openCanvasSafe(tabId);
    await sleep(10000);
    // 第二轮: 刷新页面再点画布
    if (!done) {
      status(tabId, '刷新页面重新加载画布…');
      await chrome.debugger.sendCommand(target, 'Page.enable').catch(() => {});
      await chrome.debugger.sendCommand(target, 'Page.reload', { ignoreCache: false }).catch(() => {});
      await sleep(9000);
      await openCanvasSafe(tabId);
      await sleep(12000);
    }
  } catch (e) {}

  if (!done) finish('');
  return promise;
}

// ---------- 5. 提取 fallback_api ----------
function extractFallbackApis(rawText) {
  const out = new Set();
  try { walkJson(JSON.parse(rawText), out, 0); } catch (e) {}
  const re = /fallback_api\\+"?\s*:\s*\\+"([^"]+?)\\+"/g;
  let m;
  while ((m = re.exec(rawText)) !== null) {
    const u = unescapeJsonString(m[1]).replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (u.startsWith('https://')) out.add(u);
  }
  return [...out].filter((u) => /key_seed=|video/.test(u));
}

function walkJson(v, out, depth) {
  if (depth > 12 || v == null) return;
  if (typeof v === 'string') {
    if (v.includes('fallback_api')) { try { walkJson(JSON.parse(v), out, depth + 1); } catch (e) {} }
    return;
  }
  if (typeof v !== 'object') return;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'fallback_api' && typeof val === 'string') {
      const u = val.startsWith('https://') ? val : unescapeJsonString(val).replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      if (u.startsWith('https://')) out.add(u);
    } else {
      walkJson(val, out, depth + 1);
    }
  }
}

function unescapeJsonString(v) {
  let t = v;
  for (let i = 0; i < 3; i++) {
    try { const d = JSON.parse('"' + t.replace(/"/g, '\\"') + '"'); if (d === t) break; t = d; } catch (e) { break; }
  }
  return t;
}

// ---------- 6. 请求 + 解码 ----------
async function resolveOne(api) {
  const u = new URL(api);
  const keySeedUrl = u.searchParams.get('key_seed') || '';
  u.searchParams.set('channel', 'no');
  u.searchParams.set('codec_type', '8');
  u.searchParams.set('logo_type', 'unwatermarked');
  const r = await fetch(u.toString(), { headers: { accept: 'application/json,text/plain,*/*' } });
  if (!r.ok) throw new Error('fplay HTTP ' + r.status);
  const payload = await r.json();
  const best = pickBest(payload);
  if (!best) throw new Error('响应中无 main_url');
  const ks = findKeySeedDeep(payload) || keySeedUrl;
  return await decodeMainUrl(best.token, ks);
}

async function probeSize(url) {
  try {
    const h = await fetch(url, { method: 'HEAD' });
    if (h.ok) {
      const n = parseInt(h.headers.get('content-length') || '0', 10);
      if (n) return n;
    }
  } catch (e) {}
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const m = (r.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (m) return parseInt(m[1], 10);
  } catch (e) {}
  return 0;
}

function pickBest(payload) {
  const vi = payload && (payload.video_info || (payload.data && payload.data.video_info)) || payload;
  const data = vi && vi.data && typeof vi.data === 'object' ? vi.data : vi;
  const vl = data && data.video_list;
  const entries = vl && typeof vl === 'object' && Object.keys(vl).length ? Object.values(vl) : [data];
  let best = null;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const token = e.main_url || e.play_url || '';
    if (typeof token !== 'string' || !token.trim()) continue;
    const score = Number(e.bitrate || e.real_bitrate || 0) + Number(e.vwidth || e.width || 0) * Number(e.vheight || e.height || 0);
    if (!best || score > best.score) best = { token: token.trim(), score };
  }
  return best;
}

function findKeySeedDeep(v, depth = 0) {
  if (depth > 10 || v == null) return '';
  if (typeof v === 'string') {
    let m = v.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (m) return decodeURIComponent(m[1]);
    m = v.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
  if (typeof v !== 'object') return '';
  if (typeof v.key_seed === 'string' && v.key_seed.trim()) return v.key_seed.trim();
  for (const it of Object.values(v)) {
    const h = findKeySeedDeep(it, depth + 1);
    if (h) return h;
  }
  return '';
}

function isHttpUrl(s) { return /^https?:\/\//i.test(s || ''); }

function asciiUrlFromBytes(bytes) {
  if (!bytes || !bytes.length) return '';
  for (const b of bytes) {
    if (b !== 9 && b !== 10 && b !== 13 && (b < 32 || b > 126)) return '';
  }
  return new TextDecoder('latin1').decode(bytes);
}

function padB64(t) { return t + '='.repeat((4 - (t.length % 4)) % 4); }

function b64Loose(text) {
  const input = String(text || '').trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, (c) => ({ '$': '_', '@': '/', '#': '.' }[c])),
    input.replace(/[$@#]/g, (c) => ({ '$': '+', '@': '/', '#': '=' }[c]))
  ];
  for (const cand of variants) {
    if (!cand) continue;
    try {
      const norm = padB64(cand).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(norm);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch (e) {}
  }
  return null;
}

async function decodeMainUrl(token, keySeed) {
  if (isHttpUrl(token)) return token;
  const bytes = b64Loose(token);
  if (bytes) {
    const t = asciiUrlFromBytes(bytes);
    if (isHttpUrl(t)) return t;
  }
  if (token.startsWith('qAAB') && keySeed) return await decodeQaabToken(token, keySeed);
  return '';
}

async function decodeQaabToken(token, keySeed) {
  const data = b64Loose(token);
  const seed = b64Loose(keySeed);
  if (!data || !seed) return '';
  const digest1 = await crypto.subtle.digest('SHA-512', seed.slice(0, 32));
  const salt = hexToBytes(QAAB_SALT_HEX);
  const digest2 = new Uint8Array(await crypto.subtle.digest('SHA-512', concatBytes(new Uint8Array(digest1), salt)));
  const key = digest2.slice(0, 16);
  const iv = digest2.slice(16, 32);
  const attempts = [];
  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push({ payload: data.slice(4), key, iv });
    attempts.push({ payload: data.slice(4), key: iv, iv: key });
    if (data.length > 36) {
      attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
      attempts.push({ payload: data.slice(36), key, iv });
    }
  } else {
    attempts.push({ payload: data, key, iv });
  }
  for (const a of attempts) {
    const url = await decryptAesCbcUrl(a.payload, a.key, a.iv);
    if (url) return url;
  }
  return '';
}

async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
  if (!payload.length || payload.length % 16 !== 0) return '';
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, payload));
    const direct = asciiUrlFromBytes(plain);
    if (isHttpUrl(direct)) return direct;
    const stripped = stripPkcs7(plain);
    const url = asciiUrlFromBytes(stripped);
    return isHttpUrl(url) ? url : '';
  } catch (e) {
    return '';
  }
}

function stripPkcs7(bytes) {
  if (!bytes || !bytes.length) return new Uint8Array();
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function concatBytes(a, b) {
  const bytes = new Uint8Array(a.length + b.length);
  bytes.set(a, 0);
  bytes.set(b, a.length);
  return bytes;
}
