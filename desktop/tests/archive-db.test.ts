import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveDatabase } from '../src/core/archive-db.js';
import type { AccountInfo, CapturedMessage, ConversationInfo, HistoryPage, NormalizedMessage } from '../src/core/contracts.js';

const require = createRequire(import.meta.url);
const RawDatabase = require('better-sqlite3') as new (path: string) => {
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): { get<T = Record<string, unknown>>(...params: unknown[]): T | undefined };
  close(): void;
};

const account: AccountInfo = { accountId: '10001', source: 'test' };
const conversation: ConversationInfo = { conversationId: 'conv-1', title: '测试会话', participantIds: ['10001', '20002'], source: 'test' };

function message(id: string, sequence: string, text: string): NormalizedMessage {
  return {
    accountId: account.accountId, conversationId: conversation.conversationId, platformMessageId: id, senderId: '20002', sentAtMs: 1_759_440_000_000 + Number(sequence) * 60_000,
    sentAtRaw: String(1_759_440_000_000 + Number(sequence) * 60_000), sentAtSource: 'wire.message.field10', sentAtPrecision: 'millisecond', sequence,
    kind: 'text', text, segments: [{ kind: 'text', text, source: 'test' }], attachmentCandidates: []
  };
}

function page(messages: NormalizedMessage[], cursor: string | null, nextCursor: string | null, hasMore: boolean | null): HistoryPage {
  return { accountId: account.accountId, conversationId: conversation.conversationId, messages, nextCursor, hasMore, source: 'test' };
}

describe('ArchiveDatabase', () => {
  it('commits messages and checkpoint together and preserves exact sequence strings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-db-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'run-1');
      database.savePage({ runId, account, conversation, page: page([message('9007199254740993', '9007199254740994', 'first')], null, '1234567890123456', true), state: 'running' });
      database.savePage({ runId, account, conversation, page: page([message('9007199254740994', '9007199254740995', 'second')], '1234567890123456', null, false), state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const checkpoint = database.getCheckpoint(account.accountId, conversation.conversationId);
      expect(checkpoint?.state).toBe('complete');
      expect(checkpoint?.nextCursor).toBeNull();
      const messages = database.listMessages(account.accountId, conversation.conversationId);
      expect(messages.map(item => item.platformMessageId)).toEqual(['9007199254740993', '9007199254740994']);
      expect(messages.map(item => item.sequence)).toEqual(['9007199254740994', '9007199254740995']);
      expect(database.listRuns(account.accountId, conversation.conversationId)[0].reason).toBe('history_end');
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('marks unfinished runs interrupted on startup without advancing the cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-db-'));
    const path = join(directory, 'archive.sqlite3');
    const first = await ArchiveDatabase.open(path);
    const runId = first.startRun(account, conversation, 'run-interrupted');
    first.savePage({ runId, account, conversation, page: page([message('1', '1', 'saved')], null, '88', true), state: 'running' });
    first.close();
    const second = await ArchiveDatabase.open(path);
    try {
      second.recoverInterruptedRuns();
      expect(second.getRun(runId)?.state).toBe('interrupted');
      expect(second.getCheckpoint(account.accountId, conversation.conversationId)?.nextCursor).toBe('88');
    } finally {
      second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a committed history endpoint complete after reopening without a separate finish call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-endpoint-'));
    const path = join(directory, 'archive.sqlite3');
    const first = await ArchiveDatabase.open(path);
    const runId = first.startRun(account, conversation, 'endpoint-run');
    first.savePage({ runId, account, conversation, page: page([message('2', '2', 'final')], null, null, false), state: 'complete' });
    first.close();
    const reopened = await ArchiveDatabase.open(path);
    try {
      reopened.recoverInterruptedRuns();
      expect(reopened.getRun(runId)).toMatchObject({ state: 'complete', reason: 'history_end', pages: 1 });
      expect(reopened.getCheckpoint(account.accountId, conversation.conversationId)).toMatchObject({ state: 'complete', hasMore: false });
    } finally { reopened.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rolls back the whole batch and cursor when a message belongs to another conversation', async () => {
    const directory=await mkdtemp(join(tmpdir(),'douyin-archive-rollback-'));
    const database=await ArchiveDatabase.open(join(directory,'archive.sqlite3'));
    try {
      const runId=database.startRun(account,conversation,'rollback');
      database.savePage({runId,account,conversation,page:page([message('1','9','saved')],null,'88',true),state:'running'});
      expect(()=>database.savePage({runId,account,conversation,page:page([message('2','10','must roll back'),{...message('3','11','wrong'),conversationId:'other'}],'88','77',true),state:'running'})).toThrow('message-identity-mismatch');
      expect(database.listMessages(account.accountId,conversation.conversationId).map(item=>item.platformMessageId)).toEqual(['1']);
      expect(database.getCheckpoint(account.accountId,conversation.conversationId)?.nextCursor).toBe('88');
      expect(database.getRun(runId)?.pages).toBe(1);
    } finally {database.close();await rm(directory,{recursive:true,force:true});}
  });

  it('keeps the last committed cursor if a fresh run ends before its first page commits', async () => {
    const directory=await mkdtemp(join(tmpdir(),'douyin-archive-fresh-'));
    const path=join(directory,'archive.sqlite3');
    let database=await ArchiveDatabase.open(path);
    try {
      const first=database.startRun(account,conversation,'old');
      database.savePage({runId:first,account,conversation,page:page([message('1','9','saved')],null,'88',true),state:'running'});
      database.finishRun(first,'partial','page_limit');
      const committed=database.getCheckpoint(account.accountId,conversation.conversationId);
      database.startRun(account,conversation,'fresh');
      expect(database.getCheckpoint(account.accountId,conversation.conversationId)).toEqual(committed);
      database.close();
      database=await ArchiveDatabase.open(path);
      database.recoverInterruptedRuns();
      expect(database.getRun('fresh')?.state).toBe('interrupted');
      expect(database.getCheckpoint(account.accountId,conversation.conversationId)).toEqual(committed);
      expect(database.listMessages(account.accountId,conversation.conversationId)).toHaveLength(1);
    } finally {database.close();await rm(directory,{recursive:true,force:true});}
  });

  it('migrates a version-zero archive without changing messages, references, attachments, runs, or its checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-migrate-'));
    const path = join(directory, 'archive.sqlite3');
    const original = await ArchiveDatabase.open(path);
    let messagePk = '';
    let originalCheckpoint: ReturnType<typeof original.getCheckpoint>;
    let originalRunCount = 0;
    try {
      const runId = original.startRun(account, conversation, 'legacy-run');
      const legacyMessage: NormalizedMessage = {
        ...message('9007199254740993', '9007199254740994', 'legacy text'),
        replyToPlatformMessageId: '9007199254740992',
        replySnapshot: { status: 'available', text: 'legacy quote', kind: 'text', senderId: '20002' }
      };
      original.savePage({ runId, account, conversation, page: page([legacyMessage], null, 'legacy-cursor', true), state: 'running' });
      const saved = original.listMessages(account.accountId, conversation.conversationId)[0];
      messagePk = saved.messagePk;
      original.ensureAttachment({ attachmentId: 'legacy-asset-0', messagePk, kind: 'image', quality: 'original' });
      originalCheckpoint = original.getCheckpoint(account.accountId, conversation.conversationId);
      originalRunCount = original.listRuns(account.accountId, conversation.conversationId).length;
    } finally {
      original.close();
    }

    const legacyDb = new RawDatabase(path);
    legacyDb.exec(`DROP TABLE IF EXISTS collector_cursor_evidence;
      DROP TABLE IF EXISTS attachment_browser_evidence;
      DROP INDEX attachments_message_resource;
      ALTER TABLE attachments DROP COLUMN actual_format;
      ALTER TABLE attachments DROP COLUMN validation_status;
      ALTER TABLE attachments DROP COLUMN replaced_by;
      ALTER TABLE attachments DROP COLUMN asset_state;
      ALTER TABLE attachments DROP COLUMN resource_json;
      ALTER TABLE attachments DROP COLUMN resource_key;
      DROP TABLE message_payloads;
      ALTER TABLE messages DROP COLUMN content_status_reason;
      ALTER TABLE messages DROP COLUMN content_status;`);
    legacyDb.pragma('user_version = 0');
    legacyDb.close();

    const migrated = await ArchiveDatabase.open(path);
    try {
      const saved = migrated.listMessages(account.accountId, conversation.conversationId)[0];
      expect(saved).toMatchObject({ platformMessageId: '9007199254740993', sequence: '9007199254740994', text: 'legacy text', replyToPlatformMessageId: '9007199254740992' });
      expect(saved.replySnapshot).toMatchObject({ status: 'missing', text: 'legacy quote' });
      expect(migrated.getInternalMessagePayload(messagePk)).toEqual({
        payloadVersion: 1, wireMessageType: null, aweType: null, contentJson: null, payloadStatus: 'legacy-missing'
      });
      expect(migrated.listAttachments(account.accountId, conversation.conversationId)).toHaveLength(1);
      expect(migrated.getCheckpoint(account.accountId, conversation.conversationId)).toEqual(originalCheckpoint);
      expect(migrated.listRuns(account.accountId, conversation.conversationId)).toHaveLength(originalRunCount);
      expect(saved).not.toHaveProperty('internalPayload');
      expect(saved).not.toHaveProperty('contentJson');
      migrated.close();

      const reopened = await ArchiveDatabase.open(path);
      try {
        expect(reopened.getInternalMessagePayload(messagePk)?.payloadStatus).toBe('legacy-missing');
        expect(reopened.getCheckpoint(account.accountId, conversation.conversationId)).toEqual(originalCheckpoint);
      } finally {
        reopened.close();
      }
      const versionCheck = new RawDatabase(path);
      try { expect(versionCheck.pragma('user_version', { simple: true })).toBe(5); } finally { versionCheck.close(); }
    } finally {
      try { migrated.close(); } catch { /* closed before the idempotence reopen */ }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stores a valid internal payload and does not replace it with a payload-less reread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-payload-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'payload-run');
      const withPayload = {
        ...message('501', '21', 'visible projection'),
        contentStatus: 'parsed' as const,
        internalPayload: {
          payloadVersion: 1 as const, wireMessageType: 7, aweType: 0,
          contentJson: JSON.stringify({ text: 'offline source text' }), payloadStatus: 'present' as const
        }
      };
      database.savePage({ runId, account, conversation, page: page([withPayload], null, 'payload-cursor', true), state: 'running' });
      database.savePage({ runId, account, conversation, page: page([{
        ...message('501', '21', ''), contentStatus: 'legacy-missing' as const
      }], 'payload-cursor', 'next-cursor', true), state: 'running' });
      const saved = database.listMessages(account.accountId, conversation.conversationId)[0];
      expect(database.getInternalMessagePayload(saved.messagePk)).toEqual(withPayload.internalPayload);
      expect(saved).toMatchObject({ text: 'visible projection', contentStatus: 'parsed', contentStatusReason: undefined });
      expect(saved).not.toHaveProperty('internalPayload');
      expect(saved).not.toHaveProperty('contentJson');
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a page and cursor when its internal payload is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-payload-rollback-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'payload-rollback');
      const oversized = {
        ...message('700', '31', 'must roll back'),
        internalPayload: {
          payloadVersion: 1 as const, wireMessageType: 7, aweType: null,
          contentJson: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }), payloadStatus: 'present' as const
        }
      };
      expect(() => database.savePage({ runId, account, conversation, page: page([oversized], null, 'never-committed', true), state: 'running' })).toThrow('message-payload-too-large');
      expect(database.listMessages(account.accountId, conversation.conversationId)).toHaveLength(0);
      expect(database.getCheckpoint(account.accountId, conversation.conversationId)).toBeNull();
      expect(database.getRun(runId)?.pages).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('repairs only allowlisted existing messages and preserves checkpoint, run, ID, time, and sequence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-repair-db-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const existing = { ...message('601', '41', ''), contentStatus: 'legacy-missing' as const };
      const runId = database.startRun(account, conversation, 'repair-preserve-run');
      database.savePage({ runId, account, conversation, page: page([existing], null, 'repair-original-cursor', true), state: 'running' });
      const beforeCheckpoint = database.getCheckpoint(account.accountId, conversation.conversationId);
      const beforeRun = database.getRun(runId);
      const before = database.listMessages(account.accountId, conversation.conversationId)[0];
      const repair: CapturedMessage = {
        ...existing, kind: 'text', contentStatus: 'parsed', text: 'recovered text',
        internalPayload: { payloadVersion: 1, wireMessageType: 7, aweType: 0, contentJson: JSON.stringify({ text: 'recovered text' }), payloadStatus: 'present' }
      };
      const newMessage: CapturedMessage = { ...repair, platformMessageId: '602', sequence: '42', text: 'must not insert' };
      const result = database.repairExistingMessages({ accountId: account.accountId, conversationId: conversation.conversationId, targetIds: ['601'], messages: [repair, newMessage] });
      const after = database.listMessages(account.accountId, conversation.conversationId);
      expect(result).toEqual({ matchedIds: ['601'], improvedIds: ['601'] });
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ messagePk: before.messagePk, platformMessageId: '601', sequence: '41', sentAtMs: before.sentAtMs, contentStatus: 'parsed', text: 'recovered text' });
      expect(database.getInternalMessagePayload(before.messagePk)?.payloadStatus).toBe('present');
      expect(database.getCheckpoint(account.accountId, conversation.conversationId)).toEqual(beforeCheckpoint);
      expect(database.getRun(runId)).toEqual(beforeRun);
      expect(database.getRepairSnapshot(account.accountId, conversation.conversationId).targetIds).toHaveLength(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not let low-quality repair data overwrite existing text, segments, or payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-repair-quality-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'repair-quality-run');
      const original = {
        ...message('701', '51', 'verified text'), contentStatus: 'parsed' as const,
        internalPayload: { payloadVersion: 1 as const, wireMessageType: 7, aweType: null, contentJson: JSON.stringify({ text: 'verified text' }), payloadStatus: 'present' as const }
      };
      database.savePage({ runId, account, conversation, page: page([original], null, 'repair-quality-cursor', true), state: 'running' });
      const row = database.listMessages(account.accountId, conversation.conversationId)[0];
      const lowQuality: CapturedMessage = { ...original, kind: 'unknown', text: '', contentStatus: 'legacy-missing', segments: [], internalPayload: undefined };
      database.repairExistingMessages({ accountId: account.accountId, conversationId: conversation.conversationId, targetIds: ['701'], messages: [lowQuality] });
      expect(database.listMessages(account.accountId, conversation.conversationId)[0]).toMatchObject({ messagePk: row.messagePk, kind: 'text', text: 'verified text', contentStatus: 'parsed' });
      expect(database.getInternalMessagePayload(row.messagePk)).toEqual(original.internalPayload);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('registers stable media descriptions in the same page transaction and keeps them out of public rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-assets-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'asset-run');
      const withAsset = {
        ...message('801', '41', 'picture'),
        internalMediaAssets: [{
          resourceKey: 'resource_url:0', role: 'image' as const, skey: 'a'.repeat(64),
          candidates: [
            { url: 'https://media.invalid/original.jpg?sig=private', quality: 'original' as const, sourcePath: 'resource_url:0.origin_url_list' },
            { url: 'https://media.invalid/preview.jpg', quality: 'preview' as const, sourcePath: 'resource_url:0.url_list' }
          ]
        }]
      };
      database.savePage({ runId, account, conversation, page: page([withAsset], null, 'asset-cursor', true), state: 'running' });
      const publicMessage = database.listMessages(account.accountId, conversation.conversationId)[0];
      const publicAttachment = database.listAttachments(account.accountId, conversation.conversationId)[0];
      const internal = database.getInternalAttachment(publicAttachment.id);
      expect(publicAttachment).toMatchObject({ status: 'pending', assetState: 'current', validationStatus: 'unverified' });
      expect(publicAttachment.canRetry).toBe(true);
      expect(publicAttachment).not.toHaveProperty('resourceJson');
      expect(publicAttachment).not.toHaveProperty('resourceKey');
      expect(publicMessage).not.toHaveProperty('internalMediaAssets');
      expect(internal?.resourceKey).toBe('resource_url:0');
      expect(internal?.resourceJson).toContain('a'.repeat(64));
      expect(internal?.resourceJson).toContain('https://media.invalid/original.jpg?sig=private');
      expect(database.listRetryableAttachments(account.accountId, conversation.conversationId).map(item => item.id)).toEqual([publicAttachment.id]);

      database.savePage({ runId, account, conversation, page: page([withAsset], 'asset-cursor', 'next-cursor', true), state: 'running' });
      expect(database.listAttachments(account.accountId, conversation.conversationId)).toHaveLength(1);
      expect(database.listAttachments(account.accountId, conversation.conversationId)[0].id).toBe(publicAttachment.id);
      database.updateAttachment({ attachmentId: publicAttachment.id, status: 'saved', attempts: 1, mime: 'image/png', extension: 'png', localPath: 'saved.png', size: 64, validationStatus: 'signature-valid', actualFormat: 'png' });
      database.savePage({ runId, account, conversation, page: page([withAsset], 'next-cursor', 'third-cursor', true), state: 'running' });
      expect(database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'saved', attempts: 1, localPath: 'saved.png', validationStatus: 'signature-valid', actualFormat: 'png' });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back all messages, asset descriptors, run counters, and cursor when media registration fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-asset-rollback-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'asset-rollback-run');
      const valid = { ...message('811', '61', 'valid first'), internalMediaAssets: [{ resourceKey: 'resource_url:0', role: 'image' as const, skey: null,
        candidates: [{ url: 'https://media.invalid/valid.jpg', quality: 'original' as const, sourcePath: 'resource_url:0.origin_url_list' }] }] };
      const invalid = { ...message('812', '62', 'invalid second'), internalMediaAssets: [{ resourceKey: 'resource_url:0', role: 'image' as const, skey: null,
        candidates: [{ url: 'file:///private/local.jpg', quality: 'original' as const, sourcePath: 'resource_url:0.origin_url_list' }] }] };
      expect(() => database.savePage({ runId, account, conversation, page: page([valid, invalid], null, 'uncommitted-asset-cursor', true), state: 'running' })).toThrow('attachment-resource-url-invalid');
      expect(database.listMessages(account.accountId, conversation.conversationId)).toHaveLength(0);
      expect(database.listAttachments(account.accountId, conversation.conversationId)).toHaveLength(0);
      expect(database.getCheckpoint(account.accountId, conversation.conversationId)).toBeNull();
      expect(database.getRun(runId)?.pages).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reuses a compatible legacy primary attachment and retains an incompatible one as superseded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-legacy-asset-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'legacy-asset-run');
      const original = message('901', '51', 'picture');
      database.savePage({ runId, account, conversation, page: page([original], null, 'legacy-asset-cursor', true), state: 'running' });
      const messagePk = database.listMessages(account.accountId, conversation.conversationId)[0].messagePk;
      const legacyId = `att-${createHash('sha256').update(`${messagePk}\0${0}`).digest('hex').slice(0, 32)}`;
      database.ensureAttachment({ attachmentId: legacyId, messagePk, kind: 'image', quality: 'source-unverified' });
      database.updateAttachment({ attachmentId: legacyId, status: 'saved', attempts: 1, mime: 'image/jpeg', extension: 'jpg', localPath: 'old-image.jpg', size: 123 });
      const image = {
        ...original,
        internalMediaAssets: [{ resourceKey: 'resource_url:0', role: 'image' as const, skey: null,
          candidates: [{ url: 'https://media.invalid/new.jpg', quality: 'original' as const, sourcePath: 'resource_url:0.origin_url_list' }] }]
      };
      database.savePage({ runId, account, conversation, page: page([image], 'legacy-asset-cursor', 'next', true), state: 'running' });
      expect(database.listAttachments(account.accountId, conversation.conversationId)).toMatchObject([
        { id: legacyId, status: 'saved', assetState: 'current', validationStatus: 'unverified' }
      ]);

      const secondOriginal = message('902', '52', 'second picture');
      database.savePage({ runId, account, conversation, page: page([secondOriginal], 'next', 'wrong-asset-cursor', true), state: 'running' });
      const secondMessagePk = database.listMessages(account.accountId, conversation.conversationId).find(item => item.platformMessageId === '902')!.messagePk;
      const audioLegacyId = `att-${createHash('sha256').update(`${secondMessagePk}\0${0}`).digest('hex').slice(0, 32)}`;
      database.ensureAttachment({ attachmentId: audioLegacyId, messagePk: secondMessagePk, kind: 'audio', quality: 'source-unverified' });
      database.updateAttachment({ attachmentId: audioLegacyId, status: 'saved', attempts: 1, mime: 'audio/mp4', extension: 'm4a', localPath: 'old-audio.m4a', size: 321 });
      const imageAgain = {
        ...secondOriginal,
        internalMediaAssets: [{ resourceKey: 'resource_url:0', role: 'image' as const, skey: null,
          candidates: [{ url: 'https://media.invalid/second.jpg', quality: 'original' as const, sourcePath: 'resource_url:0.origin_url_list' }] }]
      };
      database.savePage({ runId, account, conversation, page: page([imageAgain], 'wrong-asset-cursor', 'after-next', true), state: 'running' });
      expect(database.listAttachments(account.accountId, conversation.conversationId)).toContainEqual(expect.objectContaining({
        id: audioLegacyId, status: 'saved', assetState: 'superseded', validationStatus: 'unverified'
      }));
      const rows = database.listAttachments(account.accountId, conversation.conversationId);
      expect(rows.filter(item => item.assetState === 'current')).toHaveLength(2);
      expect(rows.find(item => item.id === audioLegacyId)?.replacedBy).toBeTruthy();
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('migrates an existing v3 archive to file-versioned browser evidence without changing archive state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-v3-evidence-'));
    const path = join(directory, 'archive.sqlite3');
    const original = await ArchiveDatabase.open(path);
    let runId = '';
    try {
      runId = original.startRun(account, conversation, 'v3-preserve-run');
      original.savePage({ runId, account, conversation, page: page([message('v3-message', '71', 'kept')], null, 'v3-cursor', true), state: 'running' });
      const messagePk = original.listMessages(account.accountId, conversation.conversationId)[0].messagePk;
      original.ensureAttachment({ attachmentId: 'v3-attachment', messagePk, kind: 'image', quality: 'original' });
      original.updateAttachment({ attachmentId: 'v3-attachment', status: 'saved', attempts: 1, mime: 'image/png', extension: 'png', localPath: 'kept.png', size: 45 });
    } finally { original.close(); }

    const v3 = new RawDatabase(path);
    v3.exec('DROP TABLE IF EXISTS collector_cursor_evidence; DROP TABLE IF EXISTS attachment_browser_evidence;');
    v3.pragma('user_version = 3');
    v3.close();
    const migrated = await ArchiveDatabase.open(path);
    try {
      const raw = new RawDatabase(path);
      try {
        expect(raw.pragma('user_version', { simple: true })).toBe(5);
        expect(raw.prepare('SELECT count(*) AS count FROM attachment_browser_evidence').get<{ count: number }>()?.count).toBe(0);
        expect(raw.prepare('SELECT count(*) AS count FROM collector_cursor_evidence').get<{ count: number }>()?.count).toBe(0);
      } finally { raw.close(); }
      expect(migrated.listMessages(account.accountId, conversation.conversationId).map(row => row.platformMessageId)).toEqual(['v3-message']);
      expect(migrated.listAttachments(account.accountId, conversation.conversationId)).toMatchObject([{ id: 'v3-attachment', status: 'saved', localPath: 'kept.png' }]);
      expect(migrated.getCheckpoint(account.accountId, conversation.conversationId)?.nextCursor).toBe('v3-cursor');
      expect(migrated.listRuns(account.accountId, conversation.conversationId).map(run => run.runId)).toEqual([runId]);
    } finally { migrated.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('stores idempotent browser evidence per media hash and keeps audio metadata separate from playback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-archive-browser-evidence-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'media-evidence-run');
      const image = message('image-evidence', '81', 'image');
      const voice = { ...message('voice-evidence', '82', 'voice'), kind: 'voice' as const };
      database.savePage({ runId, account, conversation, page: page([image, voice], null, 'next', true), state: 'running' });
      const imagePk = database.listMessages(account.accountId, conversation.conversationId).find(row => row.platformMessageId === 'image-evidence')!.messagePk;
      const voicePk = database.listMessages(account.accountId, conversation.conversationId).find(row => row.platformMessageId === 'voice-evidence')!.messagePk;
      database.ensureAttachment({ attachmentId: 'image-evidence', messagePk: imagePk, kind: 'image', quality: 'original' });
      database.ensureAttachment({ attachmentId: 'voice-evidence', messagePk: voicePk, kind: 'audio', quality: 'original' });
      database.updateAttachment({ attachmentId: 'image-evidence', status: 'saved', attempts: 1, mime: 'image/png', localPath: 'image.png', size: 45 });
      database.updateAttachment({ attachmentId: 'voice-evidence', status: 'saved', attempts: 1, mime: 'audio/mpeg', localPath: 'voice.mp3', size: 45 });

      const imageHash = createHash('sha256').update('image-v1').digest('hex');
      const firstImage = database.recordBrowserMediaEvidence('image-evidence', imageHash, { type: 'image-decoded', naturalWidth: 240, naturalHeight: 180 });
      expect(firstImage.recorded).toBe(true);
      expect(database.recordBrowserMediaEvidence('image-evidence', imageHash, { type: 'image-decoded', naturalWidth: 240, naturalHeight: 180 }).recorded).toBe(false);
      expect(database.listAttachments(account.accountId, conversation.conversationId).find(row => row.id === 'image-evidence')?.validationStatus).toBe('browser-verified');
      expect(database.getBrowserMediaEvidence('image-evidence', createHash('sha256').update('image-v2').digest('hex')).imageDecoded).toBeNull();

      const voiceHash = createHash('sha256').update('voice-v1').digest('hex');
      database.recordBrowserMediaEvidence('voice-evidence', voiceHash, { type: 'audio-metadata', durationSeconds: 2.5 });
      expect(database.listAttachments(account.accountId, conversation.conversationId).find(row => row.id === 'voice-evidence')?.validationStatus).toBe('unverified');
      expect(() => database.recordBrowserMediaEvidence('voice-evidence', voiceHash, { type: 'audio-ended' })).toThrow('media-audio-ended-without-progress');
      database.recordBrowserMediaEvidence('voice-evidence', voiceHash, { type: 'audio-playback', advancedSeconds: 0.3 });
      database.recordBrowserMediaEvidence('voice-evidence', voiceHash, { type: 'audio-ended' });
      expect(database.getBrowserMediaEvidence('voice-evidence', voiceHash)).toMatchObject({ audioMetadata: { durationSeconds: 2.5 }, audioPlayback: { advancedSeconds: 0.3 }, audioEnded: expect.objectContaining({ recordedAt: expect.any(String) }) });
      expect(database.listAttachments(account.accountId, conversation.conversationId).find(row => row.id === 'voice-evidence')?.validationStatus).toBe('browser-verified');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
