import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryAdapter, HistoryPage } from './contracts.js';
import { ArchiveDatabase, type RepairSnapshot } from './archive-db.js';

type RepairStopReason = 'complete' | 'history-end' | 'page-limit' | 'cancelled' | 'stalled' | 'identity-changed';

interface PersistedRepairProgress {
  version: 1;
  accountId: string;
  conversationId: string;
  targetIds: string[];
  remainingIds: string[];
  targetFingerprint: string;
  baselineMessageCount: number;
  baselineMessageIdFingerprint: string;
  baselineCheckpointFingerprint: string;
  baselineRunFingerprint: string;
  baselineContentStatusCounts: RepairSnapshot['contentStatusCounts'];
  baselineSourcePayloadMissing: number;
  nextRepairCursor: string | null;
  updatedAt: string;
}

export interface RepairConversationResult {
  repaired: number;
  matched: number;
  remaining: number;
  stillIncomplete: number;
  pages: number;
  stopReason: RepairStopReason;
  beforeMessageCount: number;
  messageCount: number;
  beforeMessageIdFingerprint: string;
  messageIdFingerprint: string;
  checkpointUnchanged: boolean;
  runsUnchanged: boolean;
  beforeContentStatusCounts: RepairSnapshot['contentStatusCounts'];
  afterContentStatusCounts: RepairSnapshot['contentStatusCounts'];
  sourcePayloadMissingBefore: number;
  sourcePayloadMissingAfter: number;
}

function fingerprintIds(ids: readonly string[]) {
  return createHash('sha256').update([...ids].sort().map(id => `${id}\0`).join('')).digest('hex');
}

function safeProgress(value: unknown, accountId: string, conversationId: string): PersistedRepairProgress | null {
  if (!value || typeof value !== 'object') return null;
  const progress = value as Partial<PersistedRepairProgress>;
  if (progress.version !== 1 || progress.accountId !== accountId || progress.conversationId !== conversationId ||
      !Array.isArray(progress.targetIds) || !Array.isArray(progress.remainingIds) ||
      progress.targetIds.length > 100_000 || progress.remainingIds.length > 100_000 ||
      !progress.targetIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512) ||
      !progress.remainingIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512) ||
      typeof progress.targetFingerprint !== 'string' || progress.targetFingerprint !== fingerprintIds(progress.targetIds) ||
      !Number.isSafeInteger(progress.baselineMessageCount) || typeof progress.baselineMessageIdFingerprint !== 'string' ||
      typeof progress.baselineCheckpointFingerprint !== 'string' || typeof progress.baselineRunFingerprint !== 'string' ||
      !Number.isSafeInteger(progress.baselineSourcePayloadMissing) || !progress.baselineContentStatusCounts ||
      !['parsed', 'partial', 'unknown', 'legacy-missing'].every(key => Number.isSafeInteger(progress.baselineContentStatusCounts?.[key as keyof RepairSnapshot['contentStatusCounts']] ?? -1)) ||
      (progress.nextRepairCursor !== null && typeof progress.nextRepairCursor !== 'string') ||
      typeof progress.updatedAt !== 'string') return null;
  const targets = new Set(progress.targetIds);
  if (progress.remainingIds.some(id => !targets.has(id))) return null;
  return progress as PersistedRepairProgress;
}

export class ArchiveRepair {
  private controller: AbortController | null = null;
  private active: Promise<RepairConversationResult> | null = null;

  constructor(private readonly database: ArchiveDatabase, private readonly adapter: HistoryAdapter, private readonly progressRoot: string) {}

  repairConversation(input: { accountId: string; conversationId: string; maxPages?: number }): Promise<RepairConversationResult> {
    if (this.active) throw new Error('repair-already-running');
    const maxPages = input.maxPages === undefined ? 6 : Math.max(1, Math.min(6, Math.floor(input.maxPages)));
    if (!Number.isFinite(maxPages)) throw new Error('repair-page-limit-invalid');
    const controller = new AbortController();
    this.controller = controller;
    const active = this.run(input.accountId, input.conversationId, maxPages, controller.signal);
    this.active = active;
    void active.finally(() => {
      if (this.active === active) this.active = null;
      if (this.controller === controller) this.controller = null;
    }).catch(() => undefined);
    return active;
  }

  async cancelAndWait() {
    this.controller?.abort();
    await this.active?.catch(() => undefined);
  }

  async whenIdle() {
    await this.active?.catch(() => undefined);
  }

  private progressPath(accountId: string, conversationId: string) {
    const identityHash = createHash('sha256').update(`${accountId}\0${conversationId}`).digest('hex').slice(0, 32);
    return join(this.progressRoot, `${identityHash}.json`);
  }

  private async readProgress(path: string, accountId: string, conversationId: string) {
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > 8 * 1024 * 1024) return null;
      return safeProgress(JSON.parse(bytes.toString('utf8')) as unknown, accountId, conversationId);
    } catch { return null; }
  }

  private async writeProgress(path: string, progress: PersistedRepairProgress) {
    await mkdir(this.progressRoot, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(progress), { flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async run(accountId: string, conversationId: string, maxPages: number, signal: AbortSignal): Promise<RepairConversationResult> {
    const before = this.database.getRepairSnapshot(accountId, conversationId);
    const path = this.progressPath(accountId, conversationId);
    const previous = await this.readProgress(path, accountId, conversationId);
    const saved = previous && previous.baselineMessageCount === before.messageCount &&
      previous.baselineMessageIdFingerprint === before.messageIdFingerprint &&
      previous.baselineCheckpointFingerprint === before.checkpointFingerprint &&
      previous.baselineRunFingerprint === before.runFingerprint ? previous : null;
    const targetIds = saved?.targetIds ?? before.targetIds;
    let progress: PersistedRepairProgress = saved ?? {
      version: 1, accountId, conversationId, targetIds, remainingIds: [...targetIds], targetFingerprint: fingerprintIds(targetIds),
      baselineMessageCount: before.messageCount, baselineMessageIdFingerprint: before.messageIdFingerprint,
      baselineCheckpointFingerprint: before.checkpointFingerprint, baselineRunFingerprint: before.runFingerprint,
      baselineContentStatusCounts: before.contentStatusCounts, baselineSourcePayloadMissing: before.sourcePayloadMissing,
      nextRepairCursor: null, updatedAt: new Date().toISOString()
    };
    if (!saved) await this.writeProgress(path, progress);

    let pages = 0;
    let repaired = 0;
    let matched = 0;
    let stopReason: RepairStopReason = 'complete';
    if (progress.remainingIds.length) {
      while (pages < maxPages && progress.remainingIds.length && !signal.aborted) {
        let currentAccount;
        try { currentAccount = await this.adapter.getAccount(); }
        catch (error) {
          if (signal.aborted) { stopReason = 'cancelled'; break; }
          throw error;
        }
        if (currentAccount.accountId !== accountId) { stopReason = 'identity-changed'; break; }
        const cursor = progress.nextRepairCursor;
        let page: HistoryPage;
        try { page = await this.adapter.fetchHistory({ conversationId, cursor, signal }); }
        catch (error) {
          if (signal.aborted) { stopReason = 'cancelled'; break; }
          if (error instanceof Error && error.message === 'conversation-changed') { stopReason = 'identity-changed'; break; }
          throw error;
        }
        if (signal.aborted) { stopReason = 'cancelled'; break; }
        if (page.accountId !== accountId || page.conversationId !== conversationId ||
            page.messages.some(message => message.accountId !== accountId || message.conversationId !== conversationId)) {
          stopReason = 'identity-changed';
          break;
        }
        const remaining = new Set(progress.remainingIds);
        const batch = this.database.repairExistingMessages({ accountId, conversationId, targetIds: progress.targetIds, messages: page.messages });
        const found = batch.matchedIds.filter(id => remaining.has(id));
        matched += found.length;
        repaired += batch.improvedIds.filter(id => remaining.has(id)).length;
        found.forEach(id => remaining.delete(id));
        pages++;
        progress = {
          ...progress, remainingIds: [...remaining], nextRepairCursor: page.nextCursor,
          updatedAt: new Date().toISOString()
        };
        await this.writeProgress(path, progress);
        if (!progress.remainingIds.length) { stopReason = 'complete'; break; }
        if (page.hasMore === false) { stopReason = 'history-end'; break; }
        if (!page.nextCursor || page.nextCursor === cursor) { stopReason = 'stalled'; break; }
      }
      if (signal.aborted) stopReason = 'cancelled';
      else if (pages >= maxPages && progress.remainingIds.length && stopReason === 'complete') stopReason = 'page-limit';
    }

    const after = this.database.getRepairSnapshot(accountId, conversationId);
    return {
      repaired, matched, remaining: progress.remainingIds.length, stillIncomplete: after.incompleteMessageCount, pages, stopReason,
      beforeMessageCount: progress.baselineMessageCount, messageCount: after.messageCount,
      beforeMessageIdFingerprint: progress.baselineMessageIdFingerprint, messageIdFingerprint: after.messageIdFingerprint,
      checkpointUnchanged: progress.baselineCheckpointFingerprint === after.checkpointFingerprint,
      runsUnchanged: progress.baselineRunFingerprint === after.runFingerprint,
      beforeContentStatusCounts: progress.baselineContentStatusCounts, afterContentStatusCounts: after.contentStatusCounts,
      sourcePayloadMissingBefore: progress.baselineSourcePayloadMissing, sourcePayloadMissingAfter: after.sourcePayloadMissing
    };
  }
}
