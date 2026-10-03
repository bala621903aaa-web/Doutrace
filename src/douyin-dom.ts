import type { CaptureBatch, CapturedMessage, MediaCandidate } from './types';

const MESSAGE_ROWS = '.messageMessageBoxmessageBox';
const PLAIN_TEXT = '.TextMessageTextpureText';
const IMAGE = '.MessageItemImageImageBox img';
const AUDIO = 'audio[src]';
const ACTIVE_CONVERSATION = '[data-e2e="conversation-item"].conversationConversationItemcurConversation';
const HEADER = '.RightPanelHeaderinfoContainer';
function localTimestamp(label: string): string | null {
  const now = new Date();
  let m = label.match(/^(今天|昨天)\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (m[1] === '昨天' ? 1 : 0), Number(m[2]), Number(m[3]));
    return date.toISOString();
  }
  m = label.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).toISOString();
  return null;
}
function text(el: Element | null | undefined) { return (el?.textContent || '').replace(/\u200b/g, '').trim(); }
function keyFor(origin: string, title: string) {
  // FNV-1a over the visible one-to-one conversation title; no page URL or auth data is retained.
  let h = 2166136261;
  for (const c of `${origin}\0${title.normalize('NFC')}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return `douyin-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
function messageFromRow(row: Element, title: string, pageUrl: string): CapturedMessage | null {
  const content = row.querySelector<HTMLElement>('.messageMessageBoxcontentBox');
  if (!content) return null;
  const timeText = text(row.querySelector('.MessageBoxTimetimeLayout'));
  const body = text(content.querySelector(PLAIN_TEXT));
  const imgs = [...content.querySelectorAll<HTMLImageElement>(IMAGE)];
  const media: MediaCandidate[] = imgs.flatMap(img => {
    const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || img.src || '';
    if (!raw) return [];
    let url: string;
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(raw) && raw.length <= 56 * 1024 * 1024) url = raw;
    else try { const parsed = new URL(raw, pageUrl); if (parsed.protocol !== 'https:') return []; url = parsed.href; } catch { return []; }
    return [{ kind: 'image' as const, url, quality: 'displayed' as const }];
  });
  const audio = [...content.querySelectorAll<HTMLAudioElement>(AUDIO)].flatMap(el => {
    const raw = el.currentSrc || el.src || '';
    try { const parsed = new URL(raw, pageUrl); if (!['https:', 'blob:'].includes(parsed.protocol)) return []; return [{ kind: 'audio' as const, url: parsed.href, quality: 'original' as const }]; }
    catch { return []; }
  });
  media.push(...audio);
  const side = content.classList.contains('messageMessageBoxisFromMe') ? 'self' : 'other';
  const hasPlainText = Boolean(content.querySelector(PLAIN_TEXT));
  const kind = audio.length ? 'audio' : imgs.length ? 'image' : hasPlainText ? 'text' : 'unsupported';
  // No message ID is present on the inspected DOM rows. Keep unresolved stickers/cards as explicit placeholders.
  const inner = body || (kind === 'image' ? '[图片]' : kind === 'unsupported' ? '[页面暂不支持的消息类型]' : '');
  return { sender: side === 'self' ? '我' : title, side, timestamp: timeText ? localTimestamp(timeText) : null,
    timeText, kind, text: inner, media };
}
export function readDouyinChat(doc: Document, pageUrl: string): CaptureBatch {
  const url = new URL(pageUrl);
  if (url.origin !== 'https://www.douyin.com' || !url.pathname.startsWith('/chat')) throw new Error('请在抖音网页版的私聊页面启动导出。');
  const heading = doc.querySelector(HEADER);
  const title = text(heading?.firstElementChild) || text(heading) || text(doc.querySelector(`${ACTIVE_CONVERSATION} .conversationConversationItemtitle`));
  if (!title) throw new Error('找不到当前私聊对象标题，请先点开一个单人私聊。');
  const rows = [...doc.querySelectorAll(MESSAGE_ROWS)];
  if (!rows.length) throw new Error('当前页面没有已加载的消息行。');
  // The inspected Douyin list is reverse chronological in DOM order; render and archive oldest first.
  const messages = rows.map(row => messageFromRow(row, title, pageUrl)).filter((m): m is CapturedMessage => Boolean(m)).reverse();
  const unsupported = messages.filter(m => m.kind === 'unsupported').length;
  const warnings = unsupported ? [`${unsupported} 条消息类型尚未识别，已保留占位记录。当前页面尚未提供可验证的语音数据。`] : [];
  return { conversationKey: keyFor(url.origin, title), title, messages, historyEnd: hasHistoryEnd(doc), warnings };
}
export function oldestVisibleToken(doc: Document) {
  const row = [...doc.querySelectorAll(MESSAGE_ROWS)].at(-1);
  if (!row) return '';
  const content = row.querySelector('.messageMessageBoxcontentBox');
  const txt = text(content?.querySelector(PLAIN_TEXT));
  const media = [...row.querySelectorAll(IMAGE)].length;
  return `${content?.classList.contains('messageMessageBoxisFromMe') ? 'self' : 'other'}|${text(row.querySelector('.MessageBoxTimetimeLayout'))}|${txt}|${media}`;
}
function rowToken(row: Element) {
  const content = row.querySelector('.messageMessageBoxcontentBox');
  const txt = text(content?.querySelector(PLAIN_TEXT));
  const media = row.querySelectorAll(IMAGE).length;
  const side = content?.classList.contains('messageMessageBoxisFromMe') ? 'self' : 'other';
  return `${side}|${text(row.querySelector('.MessageBoxTimetimeLayout'))}|${txt}|${media}`;
}
export function visibleWindowToken(doc: Document) {
  const rows = [...doc.querySelectorAll(MESSAGE_ROWS)];
  if (!rows.length) return '';
  // Keep both ends of the virtualized window. Looking at only one row can
  // report a false stall when Douyin reuses that row during a fetch.
  const sample = [...rows.slice(0, 3), ...rows.slice(-3)];
  return sample.map(rowToken).join('\n');
}
export function hasHistoryEnd(doc: Document) {
  // No dedicated, verified history-end marker exists in the inspected page DOM.
  // A phrase typed in chat must never be mistaken for UI state.
  return false;
}
