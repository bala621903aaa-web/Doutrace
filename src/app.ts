import { ArchiveStore } from './store';
import { downloadArchive } from './export';
import { CaptureRunner, type PageAdapter } from './capture';
import { decodeDataImage, saveAttachment } from './media';
import { mergeBatch } from './merge';
import type { CaptureBatch, EndReason } from './types';
import { endLabels } from './types';

const store = new ArchiveStore();
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = $('#status'), pageState = $('#pageState'), archives = $('#archives');
let sourceTabId: number | undefined;
let runner: CaptureRunner | undefined;

function postToPanel(message: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage({ source: 'douyin-chat-archive', ...message }, '*');
}

const panelHeader = document.querySelector<HTMLElement>('#panelHeader');
let lastPointer: { x: number; y: number } | undefined;
panelHeader?.addEventListener('pointerdown', event => {
  if ((event.target as HTMLElement).closest('button')) return;
  lastPointer = { x: event.clientX, y: event.clientY };
  panelHeader.setPointerCapture(event.pointerId);
  postToPanel({ action: 'drag-start' });
});
panelHeader?.addEventListener('pointermove', event => {
  if (!lastPointer) return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  lastPointer = { x: event.clientX, y: event.clientY };
  postToPanel({ action: 'drag-move', dx, dy });
});
const finishDrag = () => { if (!lastPointer) return; lastPointer = undefined; postToPanel({ action: 'drag-end' }); };
panelHeader?.addEventListener('pointerup', finishDrag);
panelHeader?.addEventListener('pointercancel', finishDrag);
$('#closePanel')?.addEventListener('click', () => postToPanel({ action: 'hide' }));

function invoke(tabId: number, type: 'inspect' | 'read' | 'loadEarlier' | 'recoverOverlap'): Promise<any> {
  return chrome.tabs.sendMessage(tabId, { type }).then(result => {
    if (!result?.ok) throw new Error(result?.error || '无法读取当前页面。');
    return result;
  });
}
async function inject(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}
async function inspect() {
  const saved = await chrome.storage.session.get('sourceTabId');
  sourceTabId = typeof saved.sourceTabId === 'number' ? saved.sourceTabId : undefined;
  if (sourceTabId === undefined) { pageState.textContent = '先在抖音网页打开目标私聊，再点击插件图标。'; return; }
  try {
    await inject(sourceTabId);
    const response = await invoke(sourceTabId, 'inspect');
    const p = response.page as { origin: string; path: string; title: string; counts: Record<string, number> };
    if (!p || p.origin !== 'https://www.douyin.com' || !p.path.startsWith('/chat')) throw new Error('当前标签页不是抖音私聊。');
    pageState.textContent = `当前会话：${p.title.split('\n')[0] || '抖音私聊'} · 已识别 ${p.counts.messageText || 0} 条可见消息行`;
    $('#notice').textContent = '已按当前网页验证消息行与双方方向。页面未提供的平台消息 ID 会使用连续消息重叠去重；未识别消息会保留为占位。';
    $('#start').removeAttribute('disabled');
    status.textContent = `图片节点 ${p.counts.media || 0} 个；语音结构尚未在该私聊中验证。采集时会保留来源时间文字，不推测隐藏的精确时间。`;
  } catch (e) {
    pageState.textContent = e instanceof Error ? e.message : '无法检查当前页面。';
    $('#start').setAttribute('disabled', '');
  }
  await refresh();
}
function fetchBlobOnPage(tabId: number, url: string): Promise<Blob> {
  if (url.startsWith('data:')) return Promise.resolve(decodeDataImage(url));
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: 'archive-media' });
    const parts: ArrayBuffer[] = [];
    let mime = 'application/octet-stream';
    port.onMessage.addListener(message => {
      if (message?.type === 'begin') mime = typeof message.mime === 'string' ? message.mime : mime;
      else if (message?.type === 'chunk') {
        try {
          const binary = atob(message.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          parts.push(bytes.buffer as ArrayBuffer); port.postMessage({ type: 'ack', seq: message.seq });
        } catch { reject(new Error('接收附件数据失败。')); }
      } else if (message?.type === 'done') { port.disconnect(); resolve(new Blob(parts, { type: mime })); }
      else if (message?.type === 'error') { port.disconnect(); reject(new Error(String(message.error || '附件读取失败。'))); }
    });
    port.onDisconnect.addListener(() => { if (parts.length === 0) reject(new Error('抖音页面关闭或附件读取被中断。')); });
    port.postMessage({ type: 'download', url });
  });
}
function adapter(tabId: number): PageAdapter {
  return {
    prepare: async mode => {
      if (mode === 'history') await chrome.tabs.sendMessage(tabId, { type: 'resetToLatest' });
    },
    read: async () => (await invoke(tabId, 'read')).batch as CaptureBatch,
    loadEarlier: async () => (await invoke(tabId, 'loadEarlier')).state as 'progress' | 'end' | 'stalled' | 'changed' | 'unavailable',
    recoverOverlap: async () => Boolean((await invoke(tabId, 'recoverOverlap')).recovered)
  };
}
async function refresh() {
  const conversations = await store.list();
  $('#count').textContent = `${conversations.length} 个会话档案`;
  const failures = (await Promise.all(conversations.map(c => store.load(c.key)))).filter(Boolean).flatMap(a => a!.attachments.filter(x => x.status === 'failed')).length;
  const retry = $('#retry') as HTMLButtonElement; retry.hidden = failures === 0; retry.textContent = failures ? `补试失败附件（${failures}）` : '重试失败附件';
  archives.replaceChildren();
  for (const c of conversations.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const row = document.createElement('div'); row.className = 'archive';
    const info = document.createElement('div'); info.className = 'archive-info';
    const title = document.createElement('b'); title.textContent = c.title;
    const detail = document.createElement('small');
    const r = c.runs.at(-1); detail.textContent = `${c.messages.length} 条消息 · ${r?.reason ? endLabels[r.reason] : '尚未完成'}`;
    info.append(title, detail);
    const exp = document.createElement('button'); exp.textContent = '导出 ZIP'; exp.addEventListener('click', async () => { exp.disabled = true; try { const archive = await store.load(c.key); if (archive) await downloadArchive(archive.conversation, archive.attachments); } catch { status.textContent = '生成 ZIP 失败，请重试。'; } finally { exp.disabled = false; } });
    const del = document.createElement('button'); del.textContent = '删除'; del.className = 'danger'; del.addEventListener('click', async () => { if (!confirm(`删除“${c.title}”的本机档案？此操作无法撤销。`)) return; await store.remove(c.key); await refresh(); });
    row.append(info, exp, del); archives.append(row);
  }
}
$('#start').addEventListener('click', async () => {
  if (sourceTabId === undefined) return;
  const start = $('#start') as HTMLButtonElement, stop = $('#stop') as HTMLButtonElement;
  start.disabled = true; stop.disabled = false;
  $('#meter').style.width = '3%';
  const mode = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value === 'history' ? 'history' : 'loaded';
  runner = new CaptureRunner(store, adapter(sourceTabId), p => {
    const progress = p.phase === 'done' ? 100 : Math.min(94, 8 + p.count / (p.count + 90) * 86);
    $('#meter').style.width = `${progress}%`;
    status.textContent = p.phase === 'done' ? `已保存 ${p.count} 条消息，新增 ${p.added} 条。${p.detail || ''}` : `${p.detail || (p.phase === 'loading' ? '正在向前加载' : p.phase === 'saving' ? '正在保存本批消息' : '已读取消息')}：${p.count} 条${p.oldest ? ` · 较早：${p.oldest}` : ''}`;
  }, async (key, attachment, url) => {
    await saveAttachment(store, key, attachment, url, source => fetchBlobOnPage(sourceTabId!, source));
  });
  try { await runner.run(mode as 'loaded' | 'history'); await refresh(); }
  catch (e) { status.textContent = e instanceof Error ? e.message : '采集失败。'; }
  finally { runner = undefined; start.disabled = false; stop.disabled = true; }
});
$('#stop').addEventListener('click', () => { runner?.stop(); $('#status').textContent = '正在停止并保存当前批次…'; });
$('#retry').addEventListener('click', async () => {
  if (sourceTabId === undefined) return;
  const retry = $('#retry') as HTMLButtonElement; retry.disabled = true;
  try {
    const current = (await invoke(sourceTabId, 'read')).batch as CaptureBatch;
    const archive = await store.load(current.conversationKey);
    if (!archive) throw new Error('当前会话还没有本机档案。');
    const fresh = mergeBatch(archive.conversation, current).attachments;
    const urls = new Map(fresh.filter(a => a.sourceUrl).map(a => [a.id, a.sourceUrl!]));
    const failed = archive.attachments.filter(a => a.status === 'failed');
    let count = 0;
    for (const a of failed) {
      const url = urls.get(a.id); if (!url) continue;
      await saveAttachment(store, current.conversationKey, a, url, source => fetchBlobOnPage(sourceTabId!, source)); count++;
    }
    status.textContent = count ? `已补试当前加载范围内的 ${count} 个附件；其余可在滚动到原消息后再次补试。` : '当前页面没有这些失败附件的新地址；回到相关图片消息附近再补试。';
    await refresh();
  } catch (e) { status.textContent = e instanceof Error ? e.message : '附件补试失败。'; }
  finally { retry.disabled = false; }
});
$('#help').addEventListener('click', () => { status.textContent = '登录抖音网页版并打开单人私聊，点击扩展图标。数据保存在本机；ZIP 可以断网打开。'; });
void store.recover().then(inspect).catch(() => { pageState.textContent = '本机档案数据库无法打开。'; });
