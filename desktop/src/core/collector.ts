import { randomUUID } from 'node:crypto';
import type { AccountInfo, ConversationInfo, HistoryAdapter, HistoryPage } from './contracts.js';
import { ArchiveDatabase, type RunState } from './archive-db.js';
import { CollectorCursorEvidence } from './collector-evidence.js';

export type CollectorState = 'idle' | 'ready' | 'collecting' | 'complete' | 'partial' | 'stopped' | 'interrupted' | 'error' | 'auth-required' | 'conversation-changed';

export interface CollectorSnapshot {
  state: CollectorState;
  runId: string | null;
  account: AccountInfo | null;
  conversation: ConversationInfo | null;
  pages: number;
  messages: number;
  nextCursor: string | null;
  hasMore: boolean | null;
  reason: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CollectorHooks {
  onSnapshot?: (snapshot: CollectorSnapshot) => void;
  onPage?: (page: HistoryPage) => void;
}

function stateForRun(state: RunState): CollectorState {
  if (state === 'complete') return 'complete';
  if (state === 'partial') return 'partial';
  if (state === 'stopped') return 'stopped';
  if (state === 'interrupted') return 'interrupted';
  if (state === 'error') return 'error';
  return 'collecting';
}

function isAuthError(error: unknown) {
  return /account-identity|login|auth|unauthorized|登录/i.test(error instanceof Error ? error.message : String(error));
}

export class ArchiveCollector {
  private current: CollectorSnapshot = {
    state: 'idle', runId: null, account: null, conversation: null, pages: 0, messages: 0,
    nextCursor: null, hasMore: null, reason: null, error: null, startedAt: null, finishedAt: null
  };
  private activeController: AbortController | null = null;
  private activePromise: Promise<CollectorSnapshot> | null = null;

  constructor(private readonly adapter: HistoryAdapter, private readonly database: ArchiveDatabase, private readonly hooks: CollectorHooks = {},
    private readonly cursorEvidence?: CollectorCursorEvidence) {}

  snapshot() { return structuredClone(this.current); }

  private publish(patch: Partial<CollectorSnapshot>) {
    this.current = { ...this.current, ...patch };
    this.hooks.onSnapshot?.(this.snapshot());
  }

  async prepare() {
    try {
      const account = await this.adapter.getAccount();
      this.publish({ state: 'ready', account, error: null, reason: null });
      return account;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ state: isAuthError(error) ? 'auth-required' : 'error', error: message });
      throw error;
    }
  }

  async start(input: { conversation: ConversationInfo; resume?: boolean; maxPages?: number; stopAfterPages?: number }) {
    if (this.activePromise) throw new Error('capture-already-running');
    const controller = new AbortController();
    this.activeController = controller;
    this.activePromise = this.run(input, controller.signal).finally(() => {
      this.activeController = null;
      this.activePromise = null;
    });
    return this.activePromise;
  }

  stop() {
    if (!this.activeController) return false;
    this.activeController.abort(new Error('user-stop'));
    return true;
  }

  async stopAndWait() {
    this.stop();
    await this.activePromise?.catch(() => undefined);
  }

  get running() { return this.activePromise !== null; }

  private async run(input: { conversation: ConversationInfo; resume?: boolean; maxPages?: number; stopAfterPages?: number }, signal: AbortSignal) {
    let account: AccountInfo;
    let runId: string | null = null;
    try {
      account = await this.adapter.getAccount();
      const maxPages = Math.max(1, Math.min(Math.floor(input.maxPages ?? 200), 10_000));
      if (!Number.isFinite(maxPages)) throw new Error('page-limit-invalid');
      const stopAfterPages = input.stopAfterPages;
      if (stopAfterPages !== undefined && (!Number.isSafeInteger(stopAfterPages) || stopAfterPages < 1 || stopAfterPages > maxPages)) {
        throw new Error('stop-after-pages-invalid');
      }
      const resumeRequested = input.resume !== false;
      const checkpoint = resumeRequested ? this.database.getCheckpoint(account.accountId, input.conversation.conversationId) : null;
      const checkpointCursor = checkpoint?.nextCursor ?? null;
      const cursor = checkpoint?.state === 'complete' ? null : checkpointCursor;
      runId = this.database.startRun(account, input.conversation, randomUUID());
      const startedAt = new Date().toISOString();
      this.publish({ state: 'collecting', runId, account, conversation: input.conversation, pages: 0, messages: 0, nextCursor: cursor, hasMore: checkpoint?.hasMore ?? null, reason: null, error: null, startedAt, finishedAt: null });
      let currentCursor = cursor;
      let pages = 0;
      let totalMessages = 0;
      while (!signal.aborted && pages < maxPages) {
        const pageIndex = pages + 1;
        const requestEvidence = this.cursorEvidence?.request({
          runId, accountId: account.accountId, conversationId: input.conversation.conversationId, pageIndex,
          checkpoint: { resumeRequested, state: checkpoint?.state ?? null, cursor: checkpointCursor }, inputCursor: currentCursor
        });
        if (requestEvidence) this.database.recordCollectorCursorRequest(requestEvidence);
        const page = await this.adapter.fetchHistory({ conversationId: input.conversation.conversationId, cursor: currentCursor, signal });
        if (signal.aborted) break;
        const uniquePlatformMessageIdCount = this.validatePage(account, input.conversation, page, currentCursor);
        const nextState: RunState = page.hasMore === false ? 'complete' : 'running';
        const cursorEvidence = requestEvidence && this.cursorEvidence ? {
          request: requestEvidence,
          commit: (newMessageCount: number) => this.cursorEvidence!.committed(requestEvidence, {
            accountId: account.accountId, conversationId: input.conversation.conversationId,
            outputCursor: page.nextCursor, pageMessageCount: page.messages.length, newMessageCount,
            uniquePlatformMessageIdCount, hasMore: page.hasMore
          })
        } : undefined;
        const saved = this.database.savePage({ runId, account, conversation: input.conversation, page, state: nextState, cursorEvidence });
        pages++;
        totalMessages = saved.totalMessages;
        this.hooks.onPage?.(page);
        this.publish({ pages, messages: totalMessages, nextCursor: page.nextCursor, hasMore: page.hasMore });
        if (page.hasMore === false) {
          const finishedAt = new Date().toISOString();
          this.publish({ state: 'complete', reason: 'history_end', finishedAt });
          return this.snapshot();
        }
        if (page.hasMore === null) {
          this.database.finishRun(runId, 'partial', 'missing_has_more');
          const finishedAt = new Date().toISOString();
          this.publish({ state: 'partial', reason: 'missing_has_more', finishedAt });
          return this.snapshot();
        }
        if (!page.nextCursor || page.nextCursor === currentCursor) {
          this.database.finishRun(runId, 'partial', 'stalled');
          const finishedAt = new Date().toISOString();
          this.publish({ state: 'partial', reason: 'stalled', finishedAt });
          return this.snapshot();
        }
        if (stopAfterPages !== undefined && pages >= stopAfterPages) {
          this.database.finishRun(runId, 'stopped', 'user_stop');
          const finishedAt = new Date().toISOString();
          this.publish({ state: 'stopped', reason: 'user_stop', finishedAt });
          return this.snapshot();
        }
        currentCursor = page.nextCursor;
      }
      const reason = signal.aborted ? 'user_stop' : 'page_limit';
      this.database.finishRun(runId, signal.aborted ? 'stopped' : 'partial', reason);
      const finishedAt = new Date().toISOString();
      this.publish({ state: signal.aborted ? 'stopped' : 'partial', reason, finishedAt });
      return this.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) {
        if (runId) this.database.finishRun(runId, 'stopped', 'user_stop');
        this.publish({ state: 'stopped', reason: 'user_stop', error: null, finishedAt: new Date().toISOString() });
        return this.snapshot();
      }
      const state: CollectorState = /conversation-changed/i.test(message) ? 'conversation-changed' : isAuthError(error) ? 'auth-required' : 'error';
      if (runId) this.database.finishRun(runId, 'error', message);
      this.publish({ state, reason: state === 'conversation-changed' ? 'conversation_changed' : 'error', error: message, finishedAt: new Date().toISOString() });
      throw error;
    }
  }

  private validatePage(account: AccountInfo, conversation: ConversationInfo, page: HistoryPage, cursor: string | null) {
    if (page.accountId !== account.accountId || page.conversationId !== conversation.conversationId) throw new Error('page-identity-mismatch');
    const ids = new Set<string>();
    for (const message of page.messages) {
      if (message.accountId !== account.accountId || message.conversationId !== conversation.conversationId) throw new Error('message-identity-mismatch');
      if (!message.platformMessageId || !/^\d+$/.test(message.platformMessageId)) throw new Error('message-id-missing');
      ids.add(message.platformMessageId);
      if (message.sentAtMs !== null && !Number.isSafeInteger(message.sentAtMs)) throw new Error('message-time-unsafe');
      if (message.sequence !== undefined) {
        try { BigInt(String(message.sequence)); } catch { throw new Error('message-sequence-invalid'); }
      }
    }
    if (cursor !== null && page.source.length === 0) throw new Error('history-source-missing');
    return ids.size;
  }
}
