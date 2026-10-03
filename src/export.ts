import { strToU8, zipSync } from 'fflate';
import type { Attachment, Conversation, Message } from './types';
import { endLabels } from './types';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function offlineHtml(c: Conversation, files: Map<string, { path: string; mime: string }>) {
  const rows = c.messages.map(m => {
    const attachments = m.media.map(id => {
      const f = files.get(id);
      return f ? (f.mime.startsWith('image/') ? `<img loading="lazy" src="${f.path}" alt="聊天图片">` : `<audio controls preload="none" src="${f.path}"></audio><a href="${f.path}" download>下载音频</a>`) : `<span class="missing">附件未保存</span>`;
    }).join('');
    return `<article id="${esc(m.ref)}" data-text="${esc((m.sender + ' ' + m.text + ' ' + m.ref).toLocaleLowerCase())}"><header><b>${esc(m.sender || '未知发送者')}</b><time>${esc(m.timeText || '时间未知')}</time><code>${esc(m.ref)}</code></header><p>${esc(m.text || (m.kind === 'image' ? '[图片]' : m.kind === 'audio' ? '[语音]' : '[非文本消息]'))}</p><div class="media">${attachments}</div></article>`;
  }).join('\n');
  const timeline = c.messages.map(m => m.timestamp).filter(Boolean).sort();
  const range = timeline.length ? `${esc(new Date(timeline[0]!).toLocaleString())} — ${esc(new Date(timeline.at(-1)!).toLocaleString())}` : '时间未知';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'none'"><title>${esc(c.title)} · 私聊档案</title><style>body{font:15px/1.65 system-ui,sans-serif;background:#f5f6f8;color:#20232a;max-width:850px;margin:36px auto;padding:0 18px}h1{font-size:24px}article{background:white;border:1px solid #e6e8ec;border-radius:12px;padding:14px 18px;margin:12px 0}header{display:flex;align-items:center;gap:14px;color:#67707e;font-size:13px}header b{color:#303744}header code{margin-left:auto;color:#7b8390}p{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:min(100%,460px);max-height:520px;border-radius:8px}audio{display:block;width:min(100%,440px);margin:8px 0}.toolbar{position:sticky;top:0;background:#f5f6f8ed;padding:12px 0;display:flex;gap:10px}input{flex:1;padding:10px;border:1px solid #d4d8e0;border-radius:8px}.missing{color:#a43b3b}.meta{color:#707887;font-size:13px}</style><h1>${esc(c.title)}</h1><div class="meta">${c.messages.length} 条消息 · 时间范围：${range}</div><div class="toolbar"><input id="q" type="search" placeholder="搜索消息"><input id="ref" placeholder="跳转到消息编号" style="flex:0 1 220px"><button id="go">定位</button></div><main>${rows}</main><script>const q=document.querySelector('#q');q.addEventListener('input',()=>{const v=q.value.trim().toLocaleLowerCase();document.querySelectorAll('article').forEach(x=>x.hidden=!x.dataset.text.includes(v)&&!x.textContent.toLocaleLowerCase().includes(v))});document.querySelector('#go').addEventListener('click',()=>{const id=document.querySelector('#ref').value.trim();document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'center'})});</script></html>`;
}
function safeMessage(m: Message) {
  return { ref: m.ref, platformId: m.platformId, sender: m.sender, senderId: m.senderId, side: m.side, timestamp: m.timestamp, timeText: m.timeText, kind: m.kind, text: m.text, media: m.media };
}
export function makeArchive(c: Conversation, attachments: Attachment[]) {
  const files: Record<string, Uint8Array> = {};
  const paths = new Map<string, { path: string; mime: string }>();
  const byId = new Map(attachments.map(a => [a.id, a]));
  for (const id of c.messages.flatMap(m => m.media)) {
    const a = byId.get(id);
    if (!a || a.status !== 'saved' || !a.blob || !a.extension || !a.mime) continue;
    const path = `media/${esc(a.id).replace(/[^a-zA-Z0-9_-]/g, '')}.${a.extension}`;
    files[path] = new Uint8Array();
    paths.set(id, { path, mime: a.mime });
  }
  // Blobs are converted asynchronously outside the UI-facing serialization step.
  return { files, paths, async zip() {
    for (const [id, target] of paths) {
      const a = byId.get(id)!;
      target.path && (files[target.path] = new Uint8Array(await a.blob!.arrayBuffer()));
    }
    const failed = [...byId.values()].filter(a => a.status !== 'saved').map(a => ({ id: a.id, kind: a.kind, status: a.status, attempts: a.attempts, error: a.error }));
    const report = { formatVersion: 1, conversation: c.title, exportedAt: new Date().toISOString(), messageCount: c.messages.length, oldest: c.messages[0]?.timeText ?? null, newest: c.messages.at(-1)?.timeText ?? null, runs: c.runs.map(r => ({ startedAt: r.startedAt, finishedAt: r.finishedAt, mode: r.mode, batches: r.batches, added: r.added, reason: r.reason, reasonText: r.reason ? endLabels[r.reason] : undefined })), attachmentCount: attachments.length, attachmentSaved: attachments.length - failed.length, attachmentFailures: failed, warnings: c.warnings };
    const messages = { formatVersion: 1, conversation: { key: c.key, title: c.title }, messages: c.messages.map(safeMessage) };
    files['messages.json'] = strToU8(JSON.stringify(messages, null, 2));
    files['export-report.json'] = strToU8(JSON.stringify(report, null, 2));
    files['index.html'] = strToU8(offlineHtml(c, paths));
    return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
  }};
}
export function downloadArchive(c: Conversation, attachments: Attachment[]) {
  return makeArchive(c, attachments).zip().then(blob => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `抖音私聊档案-${c.title.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').slice(0, 60) || '聊天'}-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });
}
