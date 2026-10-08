import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentService, type AttachmentFetcher } from '../src/core/attachment-service.js';
import { ArchiveDatabase } from '../src/core/archive-db.js';
import type { AccountInfo, CapturedMessage, ConversationInfo, HistoryPage } from '../src/core/contracts.js';

const account: AccountInfo = { accountId: 'acct-test', source: 'test' };
const conversation: ConversationInfo = { conversationId: 'conversation-test', title: 'fixture', participantIds: [], source: 'test' };
const openDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function pngFixture(): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0], 16);
  bytes.set([0, 0, 0, 0], 29);
  bytes.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 33);
  return bytes;
}

function mp4Fixture(): Uint8Array {
  return new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
}

function mp4Box(type: string, ...parts: Uint8Array[]) {
  const payload = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) { payload.set(part, position); position += part.length; }
  const result = new Uint8Array(8 + payload.length);
  new DataView(result.buffer).setUint32(0, result.length, false);
  result.set(new TextEncoder().encode(type), 4);
  result.set(payload, 8);
  return result;
}

function mp4WithTrack(handler: 'soun' | 'vide') {
  const handlerData = new Uint8Array(25);
  handlerData.set(new TextEncoder().encode(handler), 8);
  const drefData = new Uint8Array(8); new DataView(drefData.buffer).setUint32(4, 1, false);
  const stsdData = new Uint8Array(8); new DataView(stsdData.buffer).setUint32(4, 1, false);
  const minf = mp4Box('minf', mp4Box(handler === 'soun' ? 'smhd' : 'vmhd', new Uint8Array(handler === 'soun' ? 8 : 12)),
    mp4Box('dinf', mp4Box('dref', drefData)), mp4Box('stbl', mp4Box('stsd', stsdData)));
  const mdia = mp4Box('mdia', mp4Box('mdhd', new Uint8Array(24)), mp4Box('hdlr', handlerData), minf);
  const ftypAndMoov = [mp4Fixture(), mp4Box('moov', mp4Box('trak', mp4Box('tkhd', new Uint8Array(84)), mdia))];
  const result = new Uint8Array(ftypAndMoov.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of ftypAndMoov) { result.set(part, position); position += part.length; }
  return result;
}

function encrypted(bytes: Uint8Array, keyHex: string) {
  const iv = new Uint8Array(12).fill(9);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  return new Uint8Array(Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]));
}

async function fixture(options: { role?: 'image' | 'audio' | 'video'; skey?: string | null; candidates?: string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-attachments-'));
  openDirectories.push(directory);
  const path = join(directory, 'archive.sqlite3');
  const mediaRoot = join(directory, 'media');
  const database = await ArchiveDatabase.open(path);
  const message: CapturedMessage = {
    accountId: account.accountId, conversationId: conversation.conversationId, platformMessageId: 'message-1',
    senderId: 'sender', sentAtMs: 1, sentAtSource: 'test', sentAtPrecision: 'millisecond', sequence: '1',
    kind: options.role === 'audio' ? 'voice' : options.role === 'video' ? 'video-file' : 'image', text: '', segments: [], attachmentCandidates: [],
    internalMediaAssets: [{ resourceKey: 'resource_url:0', role: options.role ?? 'image', skey: options.skey ?? null,
      candidates: (options.candidates ?? ['https://cdn.douyinpic.com/original']).map((url, index) => ({
        url, quality: index === 0 ? 'original' as const : 'preview' as const, sourcePath: `fixture.candidate.${index}`
      })) }]
  };
  const page: HistoryPage = { accountId: account.accountId, conversationId: conversation.conversationId, messages: [message], nextCursor: '1', hasMore: true, source: 'test' };
  const runId = database.startRun(account, conversation, 'attachment-test-run');
  database.savePage({ runId, account, conversation, page, state: 'running' });
  const id = database.listAttachments(account.accountId, conversation.conversationId)[0].id;
  return { directory, path, mediaRoot, database, id };
}

function fetcher(handler: (url: string, signal?: AbortSignal) => Promise<Uint8Array>): AttachmentFetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async downloadAttachment(url, signal) { urls.push(url); return { bytes: await handler(url, signal), mime: 'application/octet-stream' }; }
  };
}

function anotherImage(url: string): CapturedMessage {
  return {
    accountId: account.accountId, conversationId: conversation.conversationId, platformMessageId: 'message-2',
    senderId: 'sender', sentAtMs: 2, sentAtSource: 'test', sentAtPrecision: 'millisecond', sequence: '2',
    kind: 'image', text: '', segments: [], attachmentCandidates: [],
    internalMediaAssets: [{ resourceKey: 'resource_url:0', role: 'image', skey: null,
      candidates: [{ url, quality: 'original', sourcePath: 'fixture.second' }] }]
  };
}

describe('AttachmentService', () => {
  it('recovers persisted pending assets after closing and reopening the archive', async () => {
    const first = await fixture();
    first.database.close();
    const database = await ArchiveDatabase.open(first.path);
    try {
      const service = new AttachmentService(database, first.mediaRoot, fetcher(async () => pngFixture()));
      await service.wake(account.accountId, conversation.conversationId);
      const saved = database.listAttachments(account.accountId, conversation.conversationId)[0];
      expect(saved).toMatchObject({ status: 'saved', mime: 'image/png', extension: 'png', validationStatus: 'signature-valid', actualFormat: 'png', attempts: 1 });
      expect(new Uint8Array(await readFile(saved.localPath!))).toEqual(pngFixture());
      expect(database.listRetryableAttachments(account.accountId, conversation.conversationId)).toHaveLength(0);
    } finally { database.close(); }
  });

  it('uses quality order, retries a failed source, and never stores source URLs in errors', async () => {
    const current = await fixture({ candidates: ['https://cdn.douyinpic.com/private-original?secret=hidden', 'https://cdn.douyinpic.com/preview'] });
    const downloader = fetcher(async url => {
      if (url.includes('private-original')) throw new Error('request failed https://cdn.douyinpic.com/private-original?secret=hidden');
      return pngFixture();
    });
    try {
      const service = new AttachmentService(current.database, current.mediaRoot, downloader);
      await service.wake(account.accountId, conversation.conversationId);
      expect(downloader.urls).toEqual(['https://cdn.douyinpic.com/private-original?secret=hidden', 'https://cdn.douyinpic.com/preview']);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'saved', attempts: 2, quality: 'preview', validationStatus: 'signature-valid', error: null });
    } finally { current.database.close(); }
  });

  it('does not download attachment URLs on hosts outside the Douyin media allowlist', async () => {
    const current = await fixture({ candidates: ['https://attacker.example/collect?token=private'] });
    const downloader = fetcher(async () => pngFixture());
    try {
      await new AttachmentService(current.database, current.mediaRoot, downloader).wake(account.accountId, conversation.conversationId);
      expect(downloader.urls).toEqual([]);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({
        status: 'unavailable', error: 'resource-source-invalid', validationStatus: 'invalid'
      });
    } finally { current.database.close(); }
  });

  it('continues to the next asset after one source fails and redacts the failure detail', async () => {
    const current = await fixture();
    try {
      const second = anotherImage('https://cdn.douyinpic.com/second');
      current.database.savePage({ runId: 'attachment-test-run', account, conversation,
        page: { accountId: account.accountId, conversationId: conversation.conversationId, messages: [second], nextCursor: '2', hasMore: true, source: 'test' }, state: 'running' });
      const downloader = fetcher(async url => {
        if (url.endsWith('/original')) throw new Error('request failed https://cdn.douyinpic.com/private?token=secret');
        return pngFixture();
      });
      await new AttachmentService(current.database, current.mediaRoot, downloader).wake(account.accountId, conversation.conversationId);
      const rows = current.database.listAttachments(account.accountId, conversation.conversationId);
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.quality === 'original')).toMatchObject({ status: 'failed', attempts: 1, error: 'attachment-download-failed' });
      expect(rows.find(row => row.id !== current.id)).toMatchObject({ status: 'saved', attempts: 1, actualFormat: 'png' });
      expect(rows.some(row => row.error?.includes('token=secret'))).toBe(false);
    } finally { current.database.close(); }
  });

  it('does not save bytes whose detected format conflicts with the declared media role', async () => {
    const current = await fixture({ role: 'audio' });
    try {
      const service = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => pngFixture()));
      await service.wake(account.accountId, conversation.conversationId);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'failed', attempts: 1, validationStatus: 'role-mismatch', actualFormat: 'png' });
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0].localPath).toBeNull();
    } finally { current.database.close(); }
  });

  it('records ambiguous MP4 containers without calling them audio or video', async () => {
    const current = await fixture({ role: 'audio' });
    try {
      const service = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => mp4Fixture()));
      await service.wake(account.accountId, conversation.conversationId);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'saved', mime: 'video/mp4', extension: 'mp4', validationStatus: 'role-ambiguous', actualFormat: 'mp4' });
    } finally { current.database.close(); }
  });

  it('saves MP4 audio tracks as voice media and rejects video tracks declared as voice', async () => {
    const audio = await fixture({ role: 'audio' });
    const video = await fixture({ role: 'audio' });
    try {
      await new AttachmentService(audio.database, audio.mediaRoot, fetcher(async () => mp4WithTrack('soun'))).wake(account.accountId, conversation.conversationId);
      expect(audio.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'saved', mime: 'audio/mp4', extension: 'm4a', validationStatus: 'signature-valid', actualFormat: 'mp4' });
      await new AttachmentService(video.database, video.mediaRoot, fetcher(async () => mp4WithTrack('vide'))).wake(account.accountId, conversation.conversationId);
      expect(video.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'failed', validationStatus: 'role-mismatch', error: 'media-role-mismatch' });
    } finally { audio.database.close(); video.database.close(); }
  });

  it('rejects bad AES-GCM authentication and caps retries across service restarts', async () => {
    const current = await fixture({ skey: 'ab'.repeat(32) });
    try {
      for (let index = 1; index <= 3; index++) {
        const service = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => pngFixture()));
        await service.wake(account.accountId, conversation.conversationId);
        expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'failed', attempts: index, validationStatus: 'invalid', error: 'media-authentication-failed' });
      }
      const noMoreAttempts = fetcher(async () => pngFixture());
      await new AttachmentService(current.database, current.mediaRoot, noMoreAttempts).wake(account.accountId, conversation.conversationId);
      expect(noMoreAttempts.urls).toHaveLength(0);
    } finally { current.database.close(); }
  });

  it('keeps a cancelled item pending and resumes it with a fresh service', async () => {
    const current = await fixture();
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const blocked = fetcher((_url, signal) => new Promise<Uint8Array>((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(new Error('attachment-cancelled')), { once: true });
    }));
    try {
      const firstService = new AttachmentService(current.database, current.mediaRoot, blocked);
      const queued = firstService.wake(account.accountId, conversation.conversationId);
      await began;
      await firstService.cancelAndWait();
      await queued.catch(() => undefined);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'pending', attempts: 0 });
      const resumed = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => pngFixture()));
      await resumed.wake(account.accountId, conversation.conversationId);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'saved', attempts: 1 });
    } finally { current.database.close(); }
  });

  it('retries a missing saved file when the persistent queue wakes', async () => {
    const current = await fixture();
    try {
      const firstService = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => pngFixture()));
      await firstService.wake(account.accountId, conversation.conversationId);
      const saved = current.database.listAttachments(account.accountId, conversation.conversationId)[0];
      await rm(saved.localPath!, { force: true });
      const downloader = fetcher(async () => pngFixture());
      await new AttachmentService(current.database, current.mediaRoot, downloader).wake(account.accountId, conversation.conversationId);
      expect(downloader.urls).toHaveLength(1);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0]).toMatchObject({ status: 'saved', attempts: 1, validationStatus: 'signature-valid' });
    } finally { current.database.close(); }
  });

  it('decrypts the authenticated payload before writing the media object', async () => {
    const key = 'cd'.repeat(32);
    const current = await fixture({ skey: key });
    try {
      const service = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => encrypted(pngFixture(), key)));
      await service.wake(account.accountId, conversation.conversationId);
      const saved = current.database.listAttachments(account.accountId, conversation.conversationId)[0];
      expect(new Uint8Array(await readFile(saved.localPath!))).toEqual(pngFixture());
      expect(saved).toMatchObject({ status: 'saved', actualFormat: 'png', validationStatus: 'signature-valid' });
    } finally { current.database.close(); }
  });

  it('binds browser verification to the current file hash and rejects stale renderer events', async () => {
    const current = await fixture();
    try {
      const service = new AttachmentService(current.database, current.mediaRoot, fetcher(async () => pngFixture()));
      await service.wake(account.accountId, conversation.conversationId);
      const saved = current.database.listAttachments(account.accountId, conversation.conversationId)[0];
      const source = await service.resolveBrowserMediaSource(current.id);
      expect(source.fileVersion).toBe(createHash('sha256').update(await readFile(saved.localPath!)).digest('hex'));
      const event = { type: 'image-decoded' as const, naturalWidth: 640, naturalHeight: 480 };
      expect((await service.recordBrowserMediaEvent({ attachmentId: current.id, fileVersion: source.fileVersion, event })).recorded).toBe(true);
      expect((await service.recordBrowserMediaEvent({ attachmentId: current.id, fileVersion: source.fileVersion, event })).recorded).toBe(false);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0].validationStatus).toBe('browser-verified');

      const replacement = pngFixture();
      replacement[28] ^= 1;
      await writeFile(saved.localPath!, replacement);
      const changed = await service.resolveBrowserMediaSource(current.id);
      expect(changed.fileVersion).not.toBe(source.fileVersion);
      expect(changed.evidence.imageDecoded).toBeNull();
      await expect(service.recordBrowserMediaEvent({ attachmentId: current.id, fileVersion: source.fileVersion, event })).rejects.toThrow('media-file-version-changed');
      await service.wake(account.accountId, conversation.conversationId);
      expect(current.database.listAttachments(account.accountId, conversation.conversationId)[0].validationStatus).toBe('signature-valid');
    } finally { current.database.close(); }
  });
});
