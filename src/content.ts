import { readDouyinChat, visibleWindowToken, hasHistoryEnd } from './douyin-dom';
type PageRequest = { type: 'inspect' | 'read' | 'loadEarlier' | 'recoverOverlap' | 'resetToLatest' | 'togglePanel' | 'openPanel' | 'closePanel' };
const PANEL_HOST_ID = 'douyin-chat-archive-panel-host';

function ensurePanel() {
  let host = document.getElementById(PANEL_HOST_ID) as HTMLDivElement | null;
  if (host) return host;
  host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.hidden = true;
  Object.assign(host.style, {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    top: '16px',
    right: '16px',
    width: '396px',
    height: 'min(760px, calc(100vh - 32px))',
    minHeight: '460px',
    maxWidth: 'calc(100vw - 32px)',
    zIndex: '2147483647',
    borderRadius: '18px',
    overflow: 'hidden',
    boxShadow: '0 22px 60px rgba(21, 31, 48, 0.25), 0 4px 14px rgba(21, 31, 48, 0.14)',
    background: '#f5f7fa'
  });
  const frame = document.createElement('iframe');
  frame.title = '私聊档案';
  frame.src = chrome.runtime.getURL('app.html?panel=1');
  Object.assign(frame.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    border: '0',
    borderRadius: '18px',
    background: '#f5f7fa'
  });
  host.append(frame);
  document.documentElement.append(host);
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || !event.data || event.data.source !== 'douyin-chat-archive') return;
    const message = event.data as { action?: string; dx?: number; dy?: number };
    if (message.action === 'hide') {
      host!.hidden = true;
      return;
    }
    if (message.action === 'drag-start') {
      host!.style.right = 'auto';
      host!.style.bottom = 'auto';
      host!.dataset.dragging = '1';
      return;
    }
    if (message.action === 'drag-move' && host!.dataset.dragging === '1') {
      const rect = host!.getBoundingClientRect();
      const dx = Number(message.dx) || 0;
      const dy = Number(message.dy) || 0;
      const nextLeft = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left + dx));
      const nextTop = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top + dy));
      host!.style.left = `${nextLeft}px`;
      host!.style.top = `${nextTop}px`;
      return;
    }
    if (message.action === 'drag-end') delete host!.dataset.dragging;
  });
  return host;
}

function setPanelVisibility(visible: boolean) {
  const panel = ensurePanel();
  panel.hidden = !visible;
  if (visible) panel.querySelector('iframe')?.focus();
}

if (document.documentElement.dataset.douyinArchiveReady !== '1') {
document.documentElement.dataset.douyinArchiveReady = '1';
chrome.runtime.onMessage.addListener((message: PageRequest, _sender, sendResponse) => {
  if (!['inspect', 'read', 'loadEarlier', 'recoverOverlap', 'resetToLatest', 'togglePanel', 'openPanel', 'closePanel'].includes(message?.type)) return;
  if (message.type === 'togglePanel') {
    const panel = ensurePanel();
    setPanelVisibility(panel.hidden);
    sendResponse({ ok: true, visible: !panel.hidden });
    return true;
  }
  if (message.type === 'openPanel') {
    setPanelVisibility(true);
    sendResponse({ ok: true, visible: true });
    return true;
  }
  if (message.type === 'closePanel') {
    setPanelVisibility(false);
    sendResponse({ ok: true, visible: false });
    return true;
  }
  if (message.type === 'read') {
    try { sendResponse({ ok: true, batch: readDouyinChat(document, location.href) }); }
    catch (e) { sendResponse({ ok: false, error: e instanceof Error ? e.message : '读取页面失败' }); }
    return true;
  }
  if (message.type === 'loadEarlier') {
    void (async () => {
      const list = document.querySelector<HTMLElement>('.messageMessageListlist');
      if (!list) return sendResponse({ ok: true, state: 'unavailable' });
      const reverse = getComputedStyle(list).flexDirection === 'column-reverse';
      const step = Math.max(96, Math.min(180, Math.floor(list.clientHeight * 0.22) || 140));
      const signedStep = reverse ? -step : step;
      const startToken = visibleWindowToken(document);
      const startTop = list.scrollTop;
      let changed = false;
      // Small, repeated moves keep an overlap between virtualized windows.
      // Douyin may need more than one animation/network turn before rows update.
      for (let attempt = 0; attempt < 2 && !changed; attempt++) {
        list.scrollBy({ top: signedStep, behavior: 'auto' });
        list.dispatchEvent(new Event('scroll', { bubbles: true }));
        const deadline = Date.now() + 1800;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 220));
          if (visibleWindowToken(document) !== startToken) { changed = true; break; }
        }
      }
      if (location.origin !== 'https://www.douyin.com' || !location.pathname.startsWith('/chat')) return sendResponse({ ok: true, state: 'unavailable' });
      if (hasHistoryEnd(document)) return sendResponse({ ok: true, state: 'end' });
      const moved = Math.abs(list.scrollTop - startTop) > 2;
      sendResponse({ ok: true, state: changed || moved ? 'progress' : 'stalled' });
    })();
    return true;
  }
  if (message.type === 'recoverOverlap') {
    void (async () => {
      const list = document.querySelector<HTMLElement>('.messageMessageListlist');
      if (!list) return sendResponse({ ok: true, recovered: false });
      const reverse = getComputedStyle(list).flexDirection === 'column-reverse';
      const step = Math.max(96, Math.min(180, Math.floor(list.clientHeight * 0.22) || 140));
      const signedStep = reverse ? -step : step;
      const before = visibleWindowToken(document);
      list.scrollBy({ top: -signedStep * 2, behavior: 'auto' });
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 220));
        if (visibleWindowToken(document) !== before) return sendResponse({ ok: true, recovered: true });
      }
      sendResponse({ ok: true, recovered: Math.abs(list.scrollTop) > 2 });
    })();
    return true;
  }
  if (message.type === 'resetToLatest') {
    const list = document.querySelector<HTMLElement>('.messageMessageListlist');
    if (!list) { sendResponse({ ok: false, error: '找不到私聊消息滚动区域。' }); return true; }
    list.scrollTop = 0;
    setTimeout(() => sendResponse({ ok: true }), 400);
    return true;
  }
  const counts: Record<string, number> = {};
  const candidates: Record<string, string> = {
    testId: '[data-testid]', testE2e: '[data-e2e]', messageText: '.messageMessageBoxmessageBox',
    ariaMessage: '.TextMessageTextpureText', media: '.MessageItemImageImageBox img, audio, [class*="audio" i],[class*="voice" i]',
    scrollArea: '*'
  };
  for (const [key, selector] of Object.entries(candidates)) {
    if (key === 'scrollArea') counts[key] = [...document.querySelectorAll<HTMLElement>(selector)].filter(el => el.scrollHeight > el.clientHeight + 80 && getComputedStyle(el).overflowY !== 'visible').length;
    else counts[key] = document.querySelectorAll(selector).length;
  }
  const active = document.querySelector('.RightPanelHeaderinfoContainer');
  const page = { origin: location.origin, path: location.pathname, title: active?.textContent?.trim() || document.title, counts, inspectedAt: new Date().toISOString() };
  sendResponse({ ok: true, page });
  return true;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'archive-media') return;
  let seq = 0;
  let ack: ((id: number) => void) | undefined;
  port.onMessage.addListener(message => { if (message?.type === 'ack') ack?.(message.seq); });
  port.onMessage.addListener(message => {
    if (message?.type !== 'download') return;
    void (async () => {
      try {
        const url = new URL(message.url);
        const samePageBlob = url.protocol === 'blob:' && url.origin === location.origin;
        if ((!samePageBlob && url.protocol !== 'https:') || (url.protocol === 'https:' && url.origin !== location.origin && !url.hostname.endsWith('.douyinpic.com'))) throw new Error('该附件来源站点尚未验证。');
        const response = await fetch(url.href, { credentials: url.origin === location.origin ? 'include' : 'omit', cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size || blob.size > 40 * 1024 * 1024) throw new Error(blob.size ? '附件超过 40 MB，已跳过。' : '附件为空。');
        port.postMessage({ type: 'begin', mime: blob.type, size: blob.size });
        const reader = blob.stream().getReader();
        let sent = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (let at = 0; at < value.length; at += 96 * 1024) {
            const part = value.subarray(at, at + 96 * 1024);
            let binary = '';
            for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
            const id = ++seq;
            const accepted = new Promise<number>(resolve => { ack = resolve; });
            port.postMessage({ type: 'chunk', seq: id, data: btoa(binary) });
            await accepted;
            sent += part.length;
            if (sent > 40 * 1024 * 1024) throw new Error('附件超过 40 MB，已跳过。');
          }
        }
        port.postMessage({ type: 'done' });
      } catch (e) { port.postMessage({ type: 'error', error: e instanceof Error ? e.message : '附件读取失败' }); }
      finally { port.disconnect(); }
    })();
  });
});
}
