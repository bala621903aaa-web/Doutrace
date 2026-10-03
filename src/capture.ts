import type { CaptureBatch, CapturedMessage, EndReason, Run } from './types';
import { endLabels } from './types';
import { ArchiveStore } from './store';
import { mergeBatch, AmbiguousMergeError } from './merge';

export interface PageAdapter {
  prepare?(mode: 'loaded' | 'history'): Promise<void>;
  read(): Promise<CaptureBatch>;
  loadEarlier(): Promise<'progress' | 'end' | 'stalled' | 'changed' | 'unavailable'>;
  recoverOverlap?(): Promise<boolean>;
}
export interface CaptureProgress { key: string; phase: 'reading' | 'loading' | 'saving' | 'done'; count: number; added: number; oldest?: string; newest?: string; reason?: EndReason; detail?: string }
export class CaptureRunner {
  private stopped = false;
  constructor(private store: ArchiveStore, private adapter: PageAdapter, private emit: (p: CaptureProgress) => void,
    private saveMedia: (key: string, attachment: import('./types').Attachment, sourceUrl?: string) => Promise<void> = async () => {}) {}
  stop() { this.stopped = true; }
  async run(mode: 'loaded' | 'history') {
    this.stopped = false;
    await this.adapter.prepare?.(mode);
    let first: CaptureBatch;
    try { first = await this.adapter.read(); } catch (e) { throw e; }
    if (!first.conversationKey) throw new Error('无法识别当前会话，暂未保存。');
    const runId = crypto.randomUUID();
    const prior = await this.store.load(first.conversationKey);
    const now = new Date().toISOString();
    const conversation = prior?.conversation ?? { key: first.conversationKey, title: first.title || '抖音私聊', messages: [], runs: [], warnings: [], updatedAt: now };
    const mutableRun: Run = { id: runId, startedAt: now, mode, batches: 0, added: 0 };
    conversation.runs.push(mutableRun);
    await this.store.save(conversation);
    let end: EndReason = mode === 'loaded' ? 'loaded_only' : 'stalled';
    let addedTotal = 0;
    const seenBatch = new Set<string>();
    let recoveryAttempts = 0;
    let batch: CaptureBatch | undefined = first;
    while (batch) {
      this.emit({ key: conversation.key, phase: 'saving', count: conversation.messages.length, added: addedTotal });
      const digest = JSON.stringify(batch.messages.map(m => [m.platformId, m.senderId || m.sender, m.timestamp || m.timeText, m.kind, m.text]));
      if (seenBatch.has(digest) && mode === 'history') { end = 'stalled'; break; }
      let merged: ReturnType<typeof mergeBatch>;
      try { merged = mergeBatch(conversation, batch); }
      catch (error) {
        if (mode === 'history' && error instanceof AmbiguousMergeError && this.adapter.recoverOverlap && recoveryAttempts < 3) {
          recoveryAttempts++;
          this.emit({ key: conversation.key, phase: 'loading', count: conversation.messages.length, added: addedTotal, detail: `正在重新寻找重叠消息（${recoveryAttempts}/3）` });
          let recovered = false;
          try { recovered = await this.adapter.recoverOverlap(); } catch { recovered = false; }
          if (recovered) {
            try { batch = await this.adapter.read(); continue; } catch { /* fall through to a safe stop */ }
          }
        }
        end = error instanceof AmbiguousMergeError ? 'stalled' : 'error';
        conversation.warnings.push(error instanceof Error ? error.message : '无法安全合并消息批次。');
        break;
      }
      seenBatch.add(digest);
      recoveryAttempts = 0;
      conversation.messages = merged.conversation.messages;
      conversation.warnings = merged.conversation.warnings;
      conversation.title = batch.title || conversation.title;
      mutableRun.batches++;
      mutableRun.added += merged.added;
      addedTotal += merged.added;
      // Persist every observed batch before attempting another scroll or loading step.
      await this.store.save(conversation, merged.attachments);
      for (const attachment of merged.attachments) {
        try { await this.saveMedia(conversation.key, attachment, attachment.sourceUrl); }
        catch { /* preserve the message and leave the attachment's stored status visible */ }
      }
      this.emit({ key: conversation.key, phase: 'reading', count: conversation.messages.length, added: addedTotal,
        oldest: conversation.messages[0]?.timeText, newest: conversation.messages.at(-1)?.timeText });
      if (mode === 'loaded') { end = 'loaded_only'; break; }
      if (this.stopped) { end = 'user_stop'; break; }
      if (batch.historyEnd) { end = 'history_end'; break; }
      this.emit({ key: conversation.key, phase: 'loading', count: conversation.messages.length, added: addedTotal });
      let state: Awaited<ReturnType<PageAdapter['loadEarlier']>>;
      try { state = await this.adapter.loadEarlier(); }
      catch { end = 'stalled'; break; }
      if (state === 'end') { end = 'history_end'; break; }
      if (state === 'changed') { end = 'conversation_changed'; break; }
      if (state === 'unavailable') { end = 'page_unavailable'; break; }
      if (state === 'stalled') { end = 'stalled'; break; }
      if (this.stopped) { end = 'user_stop'; break; }
      try { batch = await this.adapter.read(); }
      catch { end = 'page_unavailable'; break; }
      if (batch.conversationKey !== conversation.key) { end = 'conversation_changed'; batch = undefined; }
    }
    mutableRun.reason = end;
    mutableRun.finishedAt = new Date().toISOString();
    await this.store.save(conversation);
    this.emit({ key: conversation.key, phase: 'done', count: conversation.messages.length, added: addedTotal, oldest: conversation.messages[0]?.timeText, newest: conversation.messages.at(-1)?.timeText, reason: end, detail: endLabels[end] });
    return conversation;
  }
}

export function captured(m: CapturedMessage): CapturedMessage { return m; }
