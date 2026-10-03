import type { Attachment, CaptureBatch, CapturedMessage, Conversation, Message } from './types';

// No URL (including signed query parameters) is part of the persisted public identity.
export function fingerprint(m: CapturedMessage | Message): string {
  return JSON.stringify([m.senderId || m.sender, m.side, m.timestamp || m.timeText, m.kind, m.text, m.media.length]);
}
function same(a: Message, b: CapturedMessage): boolean {
  if (a.platformId && b.platformId) return a.platformId === b.platformId;
  return a.fingerprint === fingerprint(b);
}
export class AmbiguousMergeError extends Error {
  constructor() { super('无法可靠对齐这批消息：请保留与已保存记录重叠的消息后重试，避免重复或漏采。'); }
}
export function mergeBatch(existing: Conversation, batch: CaptureBatch, uid: () => string = () => crypto.randomUUID()): { conversation: Conversation; attachments: (Attachment & { sourceUrl?: string })[]; added: number } {
  if (existing.key !== batch.conversationKey) throw new Error('会话不一致，拒绝混合记录。');
  const conversation = structuredClone(existing);
  const old = conversation.messages;
  const fresh = batch.messages;
  const now = new Date().toISOString();
  const attachments: (Attachment & { sourceUrl?: string })[] = [];
  const create = (m: CapturedMessage): Message => {
    const ref = `m-${uid()}`;
    const media = m.media.map((a, i) => {
      const id = `${ref}-${i}`;
      attachments.push({ kind: a.kind, quality: a.quality, id, status: a.url ? 'pending' : 'failed', attempts: 0, error: a.url ? undefined : '页面未提供附件地址', sourceUrl: a.url });
      return id;
    });
    return { ...m, ref, media, fingerprint: fingerprint(m), capturedAt: now };
  };
  let added = 0;
  if (!old.length) {
    conversation.messages = fresh.map(create);
    added = fresh.length;
  } else if (fresh.length) {
    // Anchor only on unique platform IDs, or an unambiguous contiguous overlap of >=2 rows.
    // Repeated identical messages are occurrences, never a set of text fingerprints.
    const matches: { i: number; j: number; length: number; strong: boolean }[] = [];
    for (let i = 0; i < old.length; i++) {
      for (let j = 0; j < fresh.length; j++) {
        if (!same(old[i], fresh[j])) continue;
        if (i && j && same(old[i - 1], fresh[j - 1])) continue;
        let length = 0;
        while (i + length < old.length && j + length < fresh.length && same(old[i + length], fresh[j + length])) length++;
        const strong = fresh.slice(j, j + length).some((m, k) => Boolean(m.platformId && m.platformId === old[i + k].platformId));
        if (strong || length >= 2) matches.push({ i, j, length, strong });
      }
    }
    matches.sort((a, b) => Number(b.strong) - Number(a.strong) || b.length - a.length);
    const best = matches[0];
    if (!best || matches.some((m, n) => n > 0 && m.strong === best.strong && m.length === best.length && m.i - m.j !== best.i - best.j)) throw new AmbiguousMergeError();
    const offset = best.i - best.j;
    for (let j = 0; j < fresh.length; j++) {
      const i = offset + j;
      if (i >= 0 && i < old.length && !same(old[i], fresh[j])) throw new AmbiguousMergeError();
    }
    const prefix = fresh.slice(0, Math.max(0, -offset));
    const suffix = fresh.slice(Math.max(0, old.length - offset));
    // Refresh private download URLs for existing attachments without changing references.
    fresh.forEach((m, j) => {
      const saved = old[offset + j];
      if (!saved) return;
      m.media.forEach((a, k) => {
        if (saved.media[k] && a.url) attachments.push({ kind: a.kind, quality: a.quality, id: saved.media[k], status: 'pending', attempts: 0, sourceUrl: a.url });
      });
    });
    conversation.messages = [...prefix.map(create), ...old, ...suffix.map(create)];
    added = prefix.length + suffix.length;
  }
  conversation.updatedAt = now;
  conversation.warnings = [...new Set([...conversation.warnings, ...batch.warnings])];
  return { conversation, attachments, added };
}
