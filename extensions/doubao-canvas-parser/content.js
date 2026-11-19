// 豆包画布视频解析器 - content script（浮动按钮 + 结果面板）
(function () {
  if (window.__doubaoCanvasParser) return;
  window.__doubaoCanvasParser = true;

  const fab = document.createElement('div');
  fab.id = 'dcp-fab';
  fab.textContent = '🎬 解析画布视频';
  document.documentElement.appendChild(fab);

  const toast = document.createElement('div');
  toast.id = 'dcp-toast';
  document.documentElement.appendChild(toast);
  let toastTimer;
  const downloadTimers = new Set();
  function setStatus(text, sticky) {
    if (!window.__doubaoCanvasParser || !fab.isConnected) return;
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 8000);
  }

  fab.addEventListener('click', () => {
    setStatus('正在解析…（请保持当前标签页打开）', true);
    try { chrome.runtime.sendMessage({ type: 'PARSE' }); } catch (e) { setStatus('扩展连接失败，请刷新页面'); }
  });

  const onMessage = (msg) => {
    if (!window.__doubaoCanvasParser || !fab.isConnected) return;
    if (msg.type === 'DO_PARSE') {
      setStatus('正在解析…（请保持当前标签页打开）', true);
      try { chrome.runtime.sendMessage({ type: 'PARSE' }); } catch (e) {}
    } else if (msg.type === 'STATUS') {
      setStatus(msg.text, false);
    } else if (msg.type === 'OPEN_CANVAS') {
      openCanvas();
    } else if (msg.type === 'PARSE_RESULT') {
      showResults(msg.results || []);
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__doubaoCanvasParserCleanup = () => {
    window.__doubaoCanvasParser = false;
    chrome.runtime.onMessage.removeListener?.(onMessage);
    clearTimeout(toastTimer);
    downloadTimers.forEach(clearTimeout);
    downloadTimers.clear();
    fab.remove();
    toast.remove();
    document.getElementById('dcp-panel')?.remove();
  };

  function openCanvas() {
    const cards = Array.from(document.querySelectorAll('button[class*="card-"]'));
    const vis = cards.find((el) => el.offsetParent !== null) || cards[0];
    if (vis) vis.click();
  }

  function fmtSize(n) { return n ? (n / 1024 / 1024).toFixed(1) + ' MB' : ''; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function showResults(results) {
    let panel = document.getElementById('dcp-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'dcp-panel';
      document.documentElement.appendChild(panel);
    }
    const ok = results.filter((r) => r && r.url);
    let html = '<div class="dcp-head"><b>原始高清视频 ' + ok.length + '/' + results.length + ' 个</b><span id="dcp-close">✕</span></div>';
    html += '<div class="dcp-tip">无水印原始码流 · 链接带签名有时效，请尽快下载</div>';
    if (ok.length) {
      html += '<button id="dcp-all">⬇ 全部下载</button>';
    } else {
      html += '<div class="dcp-tip">未解析到视频地址（该画布可能没有视频，或需要重新点开画布）</div>';
    }
    results.forEach((r, i) => {
      let exp = '';
      if (r.expires) {
        try { exp = ' · ' + new Date(r.expires * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '前有效'; } catch (e) {}
      }
      const meta = [fmtSize(r.size), exp].filter(Boolean).join('');
      html += '<div class="dcp-item"><div class="dcp-idx">' + (i + 1) + '. ' + (meta || '视频') + '</div>';
      if (r.url) {
        html += '<div class="dcp-btns"><button class="dcp-copy" data-u="' + esc(r.url) + '">复制</button>' +
          '<button class="dcp-dl" data-u="' + esc(r.url) + '" data-n="doubao-video-' + (i + 1) + '.mp4">下载</button></div>';
      } else {
        html += '<div class="dcp-fail">解析失败' + (r.error ? ': ' + esc(r.error) : '') + '</div>';
      }
      html += '</div>';
    });
    panel.innerHTML = html;
    panel.style.display = 'block';

    panel.querySelector('#dcp-close').onclick = () => { panel.style.display = 'none'; };
    const all = panel.querySelector('#dcp-all');
    if (all) {
      all.onclick = () => {
        ok.forEach((r, i) => {
          const timer = setTimeout(() => {
            downloadTimers.delete(timer);
            if (!window.__doubaoCanvasParser || !fab.isConnected) return;
            try { chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: r.url, name: 'doubao-video-' + (results.indexOf(r) + 1) + '.mp4' }); } catch (e) {}
          }, i * 1500);
          downloadTimers.add(timer);
        });
        all.textContent = '已开始下载…';
      };
    }
    panel.querySelectorAll('.dcp-copy').forEach((b) => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.u).then(() => {
          b.textContent = '已复制';
          setTimeout(() => { b.textContent = '复制'; }, 1200);
        });
      };
    });
    panel.querySelectorAll('.dcp-dl').forEach((b) => {
      b.onclick = () => {
        try { chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: b.dataset.u, name: b.dataset.n }); } catch (e) {}
      };
    });
    setStatus(ok.length ? '解析成功，共 ' + ok.length + ' 个视频' : '未解析到视频地址', false);
  }
})();
