import type { Attachment } from './types';
import { ArchiveStore } from './store';

const signatures: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', test: b => b[0] === 255 && b[1] === 216 && b[2] === 255 },
  { mime: 'image/png', ext: 'png', test: b => b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 },
  { mime: 'image/gif', ext: 'gif', test: b => b[0] === 71 && b[1] === 73 && b[2] === 70 },
  { mime: 'image/webp', ext: 'webp', test: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' },
  { mime: 'audio/mpeg', ext: 'mp3', test: b => ascii(b, 0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224) },
  { mime: 'audio/wav', ext: 'wav', test: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE' },
  { mime: 'audio/ogg', ext: 'ogg', test: b => ascii(b, 0, 4) === 'OggS' },
  { mime: 'audio/mp4', ext: 'm4a', test: b => ascii(b, 4, 4) === 'ftyp' },
  { mime: 'audio/amr', ext: 'amr', test: b => ascii(b, 0, 6) === '#!AMR\n' },
  { mime: 'audio/silk', ext: 'silk', test: b => ascii(b, 0, 9).startsWith('#!SILK_V3') }
];
function ascii(b: Uint8Array, off: number, n: number) { return String.fromCharCode(...b.slice(off, off + n)); }
export function decodeDataImage(url: string) {
  const match = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match || url.length > 56 * 1024 * 1024) throw new Error('页面图片数据不是受支持的格式。');
  const binary = atob(match[2].replace(/\s/g, ''));
  if (!binary.length || binary.length > 40 * 1024 * 1024) throw new Error('图片为空或超过 40 MB。');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes.buffer as ArrayBuffer], { type: match[1].toLowerCase() });
}
export async function saveAttachment(store: ArchiveStore, conversationKey: string, attachment: Attachment, sourceUrl?: string, fetchBlob: (url: string) => Promise<Blob> = async url => {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'strict-origin-when-cross-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}): Promise<Attachment> {
  if (!sourceUrl) {
    const result = { ...attachment, status: 'failed' as const, error: '页面未提供附件地址' };
    await store.putAttachment(conversationKey, result); return result;
  }
  for (let attempt = attachment.attempts; attempt < 3; attempt++) {
    try {
      // Acquisition URL exists only in memory and is discarded after response.
      const url = new URL(sourceUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'blob:' && url.protocol !== 'data:') throw new Error('附件来源地址无效。');
      const blob = url.protocol === 'data:' ? decodeDataImage(sourceUrl) : await fetchBlob(url.href);
      if (!blob.size || blob.size > 40 * 1024 * 1024) throw new Error(blob.size ? '附件超过 40 MB，已跳过。' : '附件为空。');
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const sig = signatures.find(s => s.test(head));
      if (!sig || !sig.mime.startsWith(`${attachment.kind}/`)) throw new Error('附件格式无法识别，保留消息并标记下载失败。');
      const saved: Attachment = { id: attachment.id, kind: attachment.kind, quality: attachment.quality, status: 'saved', attempts: attempt + 1, mime: sig.mime, extension: sig.ext, blob };
      await store.putAttachment(conversationKey, saved); return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : '附件下载失败';
      const failed: Attachment = { id: attachment.id, kind: attachment.kind, quality: attachment.quality, status: 'failed', attempts: attempt + 1, error: message };
      await store.putAttachment(conversationKey, failed);
      if (attempt === 2) return failed;
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  return attachment;
}
export async function retryFailed(store: ArchiveStore, key: string, attachments: Attachment[], resolveSource: (id: string) => Promise<string | undefined>, progress: (done: number, total: number) => void) {
  const failed = attachments.filter(a => a.status === 'failed');
  let done = 0;
  for (const item of failed) { await saveAttachment(store, key, { ...item, status: 'pending' }, await resolveSource(item.id)); progress(++done, failed.length); }
}
