import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveRepair } from '../src/core/archive-repair.js';
import { ArchiveDatabase } from '../src/core/archive-db.js';
import type { AccountInfo, CapturedMessage, ConversationInfo, HistoryAdapter, HistoryPage } from '../src/core/contracts.js';

const account: AccountInfo = { accountId: 'repair-acct', source: 'test' };
const conversation: ConversationInfo = { conversationId: 'repair-conv', title: 'private chat', participantIds: [], source: 'test' };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function archiveMessage(id: string, options: { recovered?: boolean; accountId?: string; conversationId?: string } = {}): CapturedMessage {
  const text = options.recovered ? `recovered ${id}` : '';
  return {
    accountId: options.accountId ?? account.accountId,
    conversationId: options.conversationId ?? conversation.conversationId,
    platformMessageId: id, senderId: 'sender', sentAtMs: 1_700_000_000_000 + Number(id),
    sentAtRaw: String(1_700_000_000_000 + Number(id)), sentAtSource: 'test', sentAtPrecision: 'millisecond', sequence: id,
    kind: options.recovered ? 'text' : 'unknown', contentStatus: options.recovered ? 'parsed' : 'legacy-missing',
    text, segments: text ? [{ kind: 'text', text, source: 'repair-test' }] : [], attachmentCandidates: [],
    internalPayload: options.recovered ? { payloadVersion: 1, wireMessageType: 7, aweType: 0, contentJson: JSON.stringify({ text }), payloadStatus: 'present' } : undefined
  };
}

function page(messages: CapturedMessage[], cursor: string | null, hasMore: boolean | null): HistoryPage {
  return { accountId: account.accountId, conversationId: conversation.conversationId, messages, nextCursor: cursor, hasMore, source: 'repair-test' };
}

class PagesAdapter implements HistoryAdapter {
  readonly cursors: Array<string | null> = [];
  constructor(private readonly pages: Map<string | null, HistoryPage>, private readonly accountInfo = account) {}
  async getAccount() { return this.accountInfo; }
  async listPrivateConversations() { return [conversation]; }
  async fetchHistory(input: { conversationId: string; cursor: string | null; signal: AbortSignal }) {
    this.cursors.push(input.cursor);
    if (input.signal.aborted) throw new Error('capture-cancelled');
    const result = this.pages.get(input.cursor);
    if (!result) throw new Error('repair-page-missing');
    return result;
  }
  async close() {}
}

async function databaseFixture(ids: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'douyin-repair-'));
  roots.push(root);
  const database = await ArchiveDatabase.open(join(root, 'archive.sqlite3'));
  const messages = ids.map(id => archiveMessage(id));
  const runId = database.startRun(account, conversation, 'formal-capture-run');
  database.savePage({ runId, account, conversation, page: page(messages, 'formal-capture-cursor', true), state: 'running' });
  return { root, database, runId };
}

describe('ArchiveRepair', () => {
  it('resumes a bounded private repair cursor and leaves formal runs and checkpoints unchanged', async () => {
    const current = await databaseFixture(['1', '2', '3']);
    const progressRoot = join(current.root, 'repair-progress');
    const before = current.database.getRepairSnapshot(account.accountId, conversation.conversationId);
    const beforeMessages = current.database.listMessages(account.accountId, conversation.conversationId);
    const beforeCheckpoint = current.database.getCheckpoint(account.accountId, conversation.conversationId);
    const beforeRun = current.database.getRun(current.runId);
    const adapter = new PagesAdapter(new Map([
      [null, page([archiveMessage('1', { recovered: true }), archiveMessage('2', { recovered: true }), archiveMessage('999', { recovered: true })], 'repair-cursor-2', true)],
      ['repair-cursor-2', page([archiveMessage('3', { recovered: true })], null, false)]
    ]));
    try {
      const first = await new ArchiveRepair(current.database, adapter, progressRoot).repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId, maxPages: 1 });
      expect(first).toMatchObject({ repaired: 2, matched: 2, remaining: 1, pages: 1, stopReason: 'page-limit', checkpointUnchanged: true, runsUnchanged: true, messageCount: 3 });
      expect(adapter.cursors).toEqual([null]);
      const files = await readdir(progressRoot);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[a-f0-9]{32}\.json$/);

      const resumed = await new ArchiveRepair(current.database, adapter, progressRoot).repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId });
      expect(resumed).toMatchObject({ repaired: 1, matched: 1, remaining: 0, pages: 1, stopReason: 'complete', checkpointUnchanged: true, runsUnchanged: true, messageCount: 3 });
      expect(adapter.cursors).toEqual([null, 'repair-cursor-2']);
      expect(current.database.listMessages(account.accountId, conversation.conversationId)).toHaveLength(3);
      expect(current.database.listMessages(account.accountId, conversation.conversationId).map(row => row.platformMessageId)).toEqual(beforeMessages.map(row => row.platformMessageId));
      expect(current.database.getCheckpoint(account.accountId, conversation.conversationId)).toEqual(beforeCheckpoint);
      expect(current.database.getRun(current.runId)).toEqual(beforeRun);
      const after = current.database.getRepairSnapshot(account.accountId, conversation.conversationId);
      expect(after.messageIdFingerprint).toBe(before.messageIdFingerprint);
      expect(after.contentStatusCounts.parsed).toBe(3);
      expect(after.targetIds).toEqual([]);
    } finally { current.database.close(); }
  });

  it('cancels without committing the in-flight page and resumes from the last saved progress', async () => {
    const current = await databaseFixture(['10', '11']);
    const progressRoot = join(current.root, 'repair-progress');
    let signalSeen!: () => void;
    const started = new Promise<void>(resolve => { signalSeen = resolve; });
    const blocking: HistoryAdapter = {
      async getAccount() { return account; },
      async listPrivateConversations() { return [conversation]; },
      async fetchHistory({ signal }) {
        signalSeen();
        return new Promise<HistoryPage>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('capture-cancelled')), { once: true }));
      },
      async close() {}
    };
    try {
      const service = new ArchiveRepair(current.database, blocking, progressRoot);
      const running = service.repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId });
      await started;
      await service.cancelAndWait();
      const cancelled = await running;
      expect(cancelled).toMatchObject({ repaired: 0, remaining: 2, pages: 0, stopReason: 'cancelled', checkpointUnchanged: true, runsUnchanged: true });
      expect(current.database.getRepairSnapshot(account.accountId, conversation.conversationId).contentStatusCounts['legacy-missing']).toBe(2);

      const adapter = new PagesAdapter(new Map([[null, page([archiveMessage('10', { recovered: true }), archiveMessage('11', { recovered: true })], null, false)]]));
      const resumed = await new ArchiveRepair(current.database, adapter, progressRoot).repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId });
      expect(resumed).toMatchObject({ repaired: 2, remaining: 0, stopReason: 'complete', checkpointUnchanged: true, runsUnchanged: true });
    } finally { current.database.close(); }
  });

  it('starts a new repair scope when formal capture adds an incomplete message', async () => {
    const current = await databaseFixture(['30']);
    const progressRoot = join(current.root, 'repair-progress');
    const adapter = new PagesAdapter(new Map([[null, page([archiveMessage('30', { recovered: true })], null, false)]]));
    try {
      const first = await new ArchiveRepair(current.database, adapter, progressRoot).repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId });
      expect(first).toMatchObject({ repaired: 1, remaining: 0, pages: 1 });
      current.database.finishRun(current.runId, 'partial', 'page_limit');
      const nextRun = current.database.startRun(account, conversation, 'next-formal-capture');
      current.database.savePage({ runId: nextRun, account, conversation, page: page([archiveMessage('31')], 'next-cursor', true), state: 'running' });
      current.database.finishRun(nextRun, 'partial', 'page_limit');

      adapter.cursors.length = 0;
      const newAdapter = new PagesAdapter(new Map([[null, page([archiveMessage('31', { recovered: true })], null, false)]]));
      const second = await new ArchiveRepair(current.database, newAdapter, progressRoot).repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId });
      expect(newAdapter.cursors).toEqual([null]);
      expect(second).toMatchObject({ repaired: 1, matched: 1, remaining: 0, pages: 1, messageCount: 2, checkpointUnchanged: true, runsUnchanged: true });
    } finally { current.database.close(); }
  });

  it('refuses a response from another account or conversation without adding any message', async () => {
    const current = await databaseFixture(['20']);
    const badPage = page([archiveMessage('20', { recovered: true, accountId: 'other-account' })], null, false);
    const adapter = new PagesAdapter(new Map([[null, badPage]]));
    try {
      const before = current.database.getRepairSnapshot(account.accountId, conversation.conversationId);
      const result = await new ArchiveRepair(current.database, adapter, join(current.root, 'repair-progress')).repairConversation({ accountId: account.accountId, conversationId: conversation.conversationId });
      expect(result).toMatchObject({ stopReason: 'identity-changed', repaired: 0, matched: 0, remaining: 1, checkpointUnchanged: true, runsUnchanged: true });
      expect(current.database.getRepairSnapshot(account.accountId, conversation.conversationId).messageIdFingerprint).toBe(before.messageIdFingerprint);
    } finally { current.database.close(); }
  });
});
