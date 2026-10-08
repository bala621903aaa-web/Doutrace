import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveDatabase } from '../src/core/archive-db.js';
import { ArchiveCollector } from '../src/core/collector.js';
import { CollectorCursorEvidence } from '../src/core/collector-evidence.js';
import type { AccountInfo, ConversationInfo, HistoryAdapter, HistoryPage, NormalizedMessage } from '../src/core/contracts.js';

const account: AccountInfo = { accountId: 'a', source: 'fake' };
const conversation: ConversationInfo = { conversationId: 'c', title: '私聊', participantIds: ['a', 'b'], source: 'fake' };
function message(id: string, sequence: string): NormalizedMessage {
  return { accountId: 'a', conversationId: 'c', platformMessageId: id, senderId: 'b', sentAtMs: 1_700_000_000_000, sentAtSource: 'test', sentAtPrecision: 'millisecond', sequence, kind: 'text', text: id, segments: [{ kind: 'text', text: id }], attachmentCandidates: [] };
}
class FakeAdapter implements HistoryAdapter {
  private index = 0;
  async getAccount() { return account; }
  async listPrivateConversations() { return [conversation]; }
  async fetchHistory(input: { conversationId: string; cursor: string | null; signal: AbortSignal }): Promise<HistoryPage> {
    if (input.conversationId !== 'c') throw new Error('conversation-changed');
    const pages = [
      { messages: [message('1', '1'), message('2', '2')], nextCursor: '9223372036854775807', hasMore: true },
      { messages: [message('2', '2'), message('3', '3')], nextCursor: null, hasMore: false }
    ];
    const result = input.cursor === null ? pages[0] : pages[1];
    return { ...result, accountId: 'a', conversationId: 'c', source: 'fake' };
  }
  async close() {}
}

describe('ArchiveCollector', () => {
  it('serially saves pages, deduplicates at the database boundary, and completes only on explicit end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-collector-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const collector = new ArchiveCollector(new FakeAdapter(), database);
      const result = await collector.start({ conversation, resume: false, maxPages: 4 });
      expect(result.state).toBe('complete');
      expect(result.reason).toBe('history_end');
      expect(result.pages).toBe(2);
      expect(database.listMessages('a', 'c').map(item => item.platformMessageId)).toEqual(['1', '2', '3']);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resumes the durable cursor in a new collector and a reopened database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-collector-resume-'));
    const path = join(directory, 'archive.sqlite3');
    let database = await ArchiveDatabase.open(path);
    try {
      const evidenceKey = Buffer.alloc(32, 0x5a);
      const firstEvidence = new CollectorCursorEvidence(evidenceKey);
      const first = await new ArchiveCollector(new FakeAdapter(), database, {}, firstEvidence).start({ conversation, resume: false, maxPages: 1 });
      expect(first.state).toBe('partial');
      expect(first.reason).toBe('page_limit');
      database.close();
      database = await ArchiveDatabase.open(path);
      const adapter = new FakeAdapter();
      const cursors: Array<string | null> = [];
      const fetch = adapter.fetchHistory.bind(adapter);
      adapter.fetchHistory = input => { cursors.push(input.cursor); return fetch(input); };
      const resumedEvidence = new CollectorCursorEvidence(evidenceKey);
      const resumed = await new ArchiveCollector(adapter, database, {}, resumedEvidence).start({ conversation, resume: true });
      expect(cursors).toEqual(['9223372036854775807']);
      expect(resumed.state).toBe('complete');
      expect(database.listMessages('a','c')).toHaveLength(3);
      const evidence = database.listCollectorCursorEvidence();
      const firstCommit = evidence.find(row => row.phase === 'committed' && row.processFingerprint !== evidence.find(item => item.resumeRequested)?.processFingerprint);
      const resumedRequest = evidence.find(row => row.phase === 'requested' && row.resumeRequested);
      const resumedCommit = evidence.find(row => row.phase === 'committed' && row.processFingerprint === resumedRequest?.processFingerprint);
      expect(evidence.map(row => row.phase)).toEqual(['requested', 'committed', 'requested', 'committed']);
      expect(resumedRequest).toMatchObject({ resumeRequested: true, checkpointState: 'partial', checkpointCursorPresent: true, inputMatchesCheckpoint: true });
      expect(resumedRequest?.inputCursorFingerprint).toBe(firstCommit?.outputCursorFingerprint);
      expect(resumedRequest?.processFingerprint).not.toBe(firstCommit?.processFingerprint);
      expect(resumedCommit).toMatchObject({ pageMessageCount: 2, newMessageCount: 1, uniquePlatformMessageIdCount: 2, identityValidated: true, hasMore: false, checkpointCommitted: true });
      expect(JSON.stringify(evidence)).not.toContain('9223372036854775807');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('stops after committing the selected page so the stop boundary does not depend on click speed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-collector-stop-after-page-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      let fetchCount = 0;
      const adapter = new FakeAdapter();
      const fetch = adapter.fetchHistory.bind(adapter);
      adapter.fetchHistory = input => { fetchCount++; return fetch(input); };
      const evidence = new CollectorCursorEvidence(Buffer.alloc(32, 0x41));
      const collector = new ArchiveCollector(adapter, database, {}, evidence);
      const result = await collector.start({ conversation, resume: false, maxPages: 2, stopAfterPages: 1 });

      expect(result).toMatchObject({ state: 'stopped', reason: 'user_stop', pages: 1 });
      expect(fetchCount).toBe(1);
      expect(database.listMessages('a', 'c')).toHaveLength(2);
      expect(database.getCheckpoint('a', 'c')?.nextCursor).toBe('9223372036854775807');
      expect(database.getCheckpoint('a', 'c')?.state).toBe('stopped');
      expect(database.listRuns('a', 'c')[0]).toMatchObject({ state: 'stopped', reason: 'user_stop', pages: 1 });
      expect(database.listCollectorCursorEvidence().map(row => row.phase)).toEqual(['requested', 'committed']);
      expect(database.listCollectorCursorEvidence()[1]).toMatchObject({ identityValidated: true, checkpointCommitted: true, hasMore: true });
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('treats an abort during fetch as stopped and keeps the last committed cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-collector-stop-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      let notify: () => void = () => {};
      const waiting = new Promise<void>(resolve => { notify = resolve; });
      const adapter = new FakeAdapter();
      const fetch = adapter.fetchHistory.bind(adapter);
      adapter.fetchHistory = input => input.cursor === null ? fetch(input) : new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('transport-aborted')), {once:true});
        notify();
      });
      const collector = new ArchiveCollector(adapter, database);
      const run = collector.start({conversation, resume:false});
      await waiting;
      await collector.stopAndWait();
      expect((await run).state).toBe('stopped');
      expect(collector.snapshot().error).toBeNull();
      expect(database.getCheckpoint('a','c')?.nextCursor).toBe('9223372036854775807');
      expect(database.listMessages('a','c')).toHaveLength(2);
    } finally { database.close(); await rm(directory, {recursive:true,force:true}); }
  });
});
