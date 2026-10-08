import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ArchiveDatabase, messagePrimaryKey } from '../src/core/archive-db.js';
import { exportConversation, writeZipAtomically } from '../src/core/archive-export.js';
import type { AccountInfo, CapturedMessage, ConversationInfo, HistoryPage, NormalizedMessage } from '../src/core/contracts.js';

const account: AccountInfo = { accountId: 'export-account', source: 'test' };
const conversation: ConversationInfo = { conversationId: 'export-conversation', title: '导出测试', participantIds: ['export-account', 'other'], source: 'test' };
const message: NormalizedMessage = { accountId: account.accountId, conversationId: conversation.conversationId, platformMessageId: '55', senderId: 'other', sentAtMs: 1_700_000_000_000, sentAtSource: 'test', sentAtPrecision: 'millisecond', sequence: '55', kind: 'text', text: '<文本>', segments: [{ kind: 'text', text: '<文本>' }], attachmentCandidates: [] };

function audioMp4Fixture() {
  const ftyp = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const hdlrPayload = new Uint8Array(25);
  hdlrPayload.set(new TextEncoder().encode('soun'), 8);
  const hdlr = new Uint8Array(8 + hdlrPayload.length);
  new DataView(hdlr.buffer).setUint32(0, hdlr.length, false);
  hdlr.set(new TextEncoder().encode('hdlr'), 4);
  hdlr.set(hdlrPayload, 8);
  const wrap = (type: string, ...parts: Uint8Array[]) => {
    const payload = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { payload.set(part, offset); offset += part.length; }
    const box = new Uint8Array(8 + payload.length);
    new DataView(box.buffer).setUint32(0, box.length, false);
    box.set(new TextEncoder().encode(type), 4);
    box.set(payload, 8);
    return box;
  };
  const drefData = new Uint8Array(8); new DataView(drefData.buffer).setUint32(4, 1, false);
  const stsdData = new Uint8Array(8); new DataView(stsdData.buffer).setUint32(4, 1, false);
  const minf = wrap('minf', wrap('smhd', new Uint8Array(8)), wrap('dinf', wrap('dref', drefData)), wrap('stbl', wrap('stsd', stsdData)));
  const mdia = wrap('mdia', wrap('mdhd', new Uint8Array(24)), hdlr, minf);
  const moov = wrap('moov', wrap('trak', wrap('tkhd', new Uint8Array(84)), mdia));
  const file = new Uint8Array(ftyp.length + moov.length);
  file.set(ftyp, 0); file.set(moov, ftyp.length);
  return file;
}

describe('archive export', () => {
  it('writes a safe offline ZIP with the required files and escaped message text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const runId = database.startRun(account, conversation, 'export-run');
      const completeMessage: CapturedMessage = { ...message, contentStatus: 'parsed', internalPayload: { payloadVersion: 1, wireMessageType: 7, aweType: null, contentJson: JSON.stringify({ text: '<文本>' }), payloadStatus: 'present' } };
      const page: HistoryPage = { accountId: account.accountId, conversationId: conversation.conversationId, messages: [completeMessage], nextCursor: null, hasMore: false, source: 'test' };
      database.savePage({ runId, account, conversation, page, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const mediaPath = join(directory, 'sample.jpg');
      await writeFile(mediaPath, Buffer.from([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]));
      const attachmentId = 'export-image';
      database.ensureAttachment({ attachmentId, messagePk: messagePrimaryKey(completeMessage), kind: 'image', quality: 'original' });
      database.updateAttachment({ attachmentId, status: 'saved', attempts: 1, mime: 'image/jpeg', extension: 'jpg', localPath: mediaPath, size: 6 });
      const output = join(directory, 'archive.zip');
      const result = await exportConversation(database, account.accountId, conversation.conversationId, output);
      expect(result.report.complete).toBe(true);
      expect(result.mediaCount).toBe(1);
      const archive = unzipSync(new Uint8Array(await readFile(output)));
      expect(Object.keys(archive)).toEqual(expect.arrayContaining(['messages.json', 'index.html', 'export-report.json']));
      expect(Object.keys(archive).some(path => /^media\/.+\.jpg$/.test(path))).toBe(true);
      const html = strFromU8(archive['index.html']);
      expect(html).toContain('&lt;文本&gt;');
      expect((html.match(/<article\b/g) ?? []).length).toBe(1);
      expect(JSON.parse(strFromU8(archive['messages.json'])).messages).toHaveLength(1);
      expect(JSON.parse(strFromU8(archive['export-report.json'])).complete).toBe(true);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps verified history scope after a later run fails before saving a page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-scope-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const completed = database.startRun(account, conversation, 'completed');
      database.savePage({ runId: completed, account, conversation, page: {
        accountId: account.accountId, conversationId: conversation.conversationId,
        messages: [{ ...message, contentStatus: 'parsed', internalPayload: { payloadVersion: 1, wireMessageType: 7, aweType: null,
          contentJson: JSON.stringify({ text: message.text }), payloadStatus: 'present' } }],
        nextCursor: null, hasMore: false, source: 'test'
      }, state: 'complete' });
      database.finishRun(completed, 'complete', 'history_end');
      const checkpoint = database.getCheckpoint(account.accountId, conversation.conversationId);
      const failed = database.startRun(account, conversation, 'failed-before-first-page');
      database.finishRun(failed, 'error', 'history-response-timeout');

      expect(database.getCheckpoint(account.accountId, conversation.conversationId)).toEqual(checkpoint);
      const result = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'archive.zip'));
      expect(result.report.historyComplete).toBe(true);
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps HEIC originals in the ZIP without rendering a broken inline image', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-heic-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const image: CapturedMessage = { ...message, kind: 'image', text: '', contentStatus: 'parsed', segments: [{ kind: 'image' }] };
      const runId = database.startRun(account, conversation, 'heic-run');
      database.savePage({ runId, account, conversation, page: {
        accountId: account.accountId, conversationId: conversation.conversationId,
        messages: [image], nextCursor: null, hasMore: false, source: 'test'
      }, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const mediaPath = join(directory, 'sample.heic');
      const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 104, 101, 105, 99, 0, 0, 0, 0]);
      await writeFile(mediaPath, bytes);
      database.ensureAttachment({ attachmentId: 'heic-image', messagePk: messagePrimaryKey(image), kind: 'image', quality: 'original' });
      database.updateAttachment({ attachmentId: 'heic-image', status: 'saved', attempts: 1, mime: 'image/heic', extension: 'heic', localPath: mediaPath, size: bytes.length });

      const result = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'heic.zip'));
      const archive = unzipSync(new Uint8Array(await readFile(result.outputPath)));
      const html = strFromU8(archive['index.html']);
      expect(result.report).toMatchObject({ savedMediaCount: 1, heicWithoutInlinePreviewCount: 1 });
      expect(Object.keys(archive).some(path => path.endsWith('.heic'))).toBe(true);
      expect(html).toContain('HEIC 图片原文件已保存');
      expect(html).toContain('下载原文件</a>');
      expect(html).not.toContain('<img loading="lazy"');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('reports a saved-but-missing media file as incomplete while still exporting text', async () => {
    const directory=await mkdtemp(join(tmpdir(),'douyin-export-missing-'));
    const database=await ArchiveDatabase.open(join(directory,'archive.sqlite3'));
    try {
      const runId=database.startRun(account,conversation,'missing');
      database.savePage({runId,account,conversation,page:{accountId:account.accountId,conversationId:conversation.conversationId,messages:[message],nextCursor:null,hasMore:false,source:'test'},state:'complete'});
      database.finishRun(runId,'complete','history_end');
      database.ensureAttachment({attachmentId:'missing-image',messagePk:messagePrimaryKey(message),kind:'image',quality:'source-unverified'});
      database.updateAttachment({attachmentId:'missing-image',status:'saved',attempts:1,mime:'image/png',extension:'png',localPath:join(directory,'missing.png'),size:32});
      const result=await exportConversation(database,account.accountId,conversation.conversationId,join(directory,'missing.zip'));
      expect(result.report.historyComplete).toBe(true);
      expect(result.report.complete).toBe(false);
      expect(result.report.missingAttachments[0].status).toBe('local-file-unavailable');
      expect(result.mediaCount).toBe(0);
      const archive=unzipSync(new Uint8Array(await readFile(result.outputPath)));
      expect(strFromU8(archive['index.html'])).toContain('附件未保存');
    } finally {database.close();await rm(directory,{recursive:true,force:true});}
  });

  it('exports references as local links and resolves them only within the same account and conversation', async () => {
    const directory=await mkdtemp(join(tmpdir(),'douyin-export-reference-'));
    const database=await ArchiveDatabase.open(join(directory,'archive.sqlite3'));
    try {
      const runId=database.startRun(account,conversation,'reference');
      const reply={...message,platformMessageId:'56',sequence:'56',replyToPlatformMessageId:'55',replySnapshot:{status:'unresolved' as const}};
      database.savePage({runId,account,conversation,page:{accountId:account.accountId,conversationId:conversation.conversationId,messages:[message,reply],nextCursor:null,hasMore:false,source:'test'},state:'complete'});
      database.finishRun(runId,'complete','history_end');
      expect(database.listMessages(account.accountId,conversation.conversationId)[1].replySnapshot?.status).toBe('available');
      const result=await exportConversation(database,account.accountId,conversation.conversationId,join(directory,'reference.zip'));
      const archive=unzipSync(new Uint8Array(await readFile(result.outputPath)));
      const html=strFromU8(archive['index.html']);
      const localTarget = `local-${createHash('sha256').update(messagePrimaryKey(message)).digest('hex').slice(0, 24)}`;
      expect(html).toContain(`href="#${localTarget}"`);
      expect(html).toContain('引用：&lt;文本&gt;');
      const dom = new JSDOM(html, { runScripts: 'dangerously' });
      try {
        const search = dom.window.document.querySelector<HTMLInputElement>('#search')!;
        search.value = 'not found';
        search.dispatchEvent(new dom.window.Event('input'));
        expect(dom.window.document.getElementById(localTarget)?.hasAttribute('hidden')).toBe(true);
        dom.window.document.querySelector<HTMLAnchorElement>('a.reference')!.click();
        expect(search.value).toBe('');
        expect(dom.window.document.getElementById(localTarget)?.hasAttribute('hidden')).toBe(false);
      } finally { dom.window.close(); }
      expect(database.listMessages(account.accountId,conversation.conversationId,'56')).toHaveLength(1);
    } finally {database.close();await rm(directory,{recursive:true,force:true});}
  });

  it('keeps private message payloads, media URLs, keys, and local paths out of every ZIP entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-private-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const privateMessage: CapturedMessage = {
        ...message, contentStatus: 'parsed',
        internalPayload: { payloadVersion: 1, wireMessageType: 7, aweType: null, contentJson: JSON.stringify({ sentinel: 'INTERNAL_PAYLOAD_SENTINEL' }), payloadStatus: 'present' },
        internalMediaAssets: [{ resourceKey: 'resource_url:0', role: 'image', skey: 'PRIVATE_SKEY_SENTINEL', candidates: [{
          url: 'https://media.invalid/image.jpg?token=PRIVATE_URL_SENTINEL', quality: 'original', sourcePath: 'resource_url.0'
        }] }]
      };
      const runId = database.startRun(account, conversation, 'private-export-run');
      database.savePage({ runId, account, conversation, page: { accountId: account.accountId, conversationId: conversation.conversationId, messages: [privateMessage], nextCursor: null, hasMore: false, source: 'test' }, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const output = join(directory, 'private.zip');
      await exportConversation(database, account.accountId, conversation.conversationId, output);
      const archive = unzipSync(new Uint8Array(await readFile(output)));
      const entries = Object.entries(archive).map(([name, bytes]) => `${name}\n${strFromU8(bytes)}`).join('\n');
      for (const secret of ['INTERNAL_PAYLOAD_SENTINEL', 'PRIVATE_SKEY_SENTINEL', 'PRIVATE_URL_SENTINEL', directory]) expect(entries).not.toContain(secret);
      const exported = JSON.parse(strFromU8(archive['messages.json']));
      expect(exported.messages[0]).not.toHaveProperty('internalPayload');
      expect(exported.messages[0].attachments[0]).not.toHaveProperty('localPath');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps history scope separate from content and required video-file media completeness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-video-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const video: CapturedMessage = { ...message, platformMessageId: 'video-1', sequence: 'video-1', kind: 'video-file', contentStatus: 'parsed',
        internalPayload: { payloadVersion: 1, wireMessageType: 30, aweType: null, contentJson: JSON.stringify({ video: true }), payloadStatus: 'present' },
        internalMediaAssets: [{ resourceKey: 'poster:0', role: 'poster', skey: null, candidates: [{ url: 'https://media.invalid/poster.jpg', quality: 'preview', sourcePath: 'poster.url_list' }] }] };
      const runId = database.startRun(account, conversation, 'video-export-run');
      database.savePage({ runId, account, conversation, page: { accountId: account.accountId, conversationId: conversation.conversationId, messages: [video], nextCursor: null, hasMore: false, source: 'test' }, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const result = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'video.zip'));
      expect(result.report.historyComplete).toBe(true);
      expect(result.report.complete).toBe(false);
      expect(result.report.requiredAssetMissing).toContainEqual(expect.objectContaining({ role: 'video', status: 'asset-not-registered' }));
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a saved file whose bytes do not match a supported media signature', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-invalid-media-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const image: CapturedMessage = { ...message, kind: 'image', contentStatus: 'parsed',
        internalPayload: { payloadVersion: 1, wireMessageType: 2, aweType: null, contentJson: JSON.stringify({ image: true }), payloadStatus: 'present' } };
      const runId = database.startRun(account, conversation, 'invalid-media-run');
      database.savePage({ runId, account, conversation, page: { accountId: account.accountId, conversationId: conversation.conversationId, messages: [image], nextCursor: null, hasMore: false, source: 'test' }, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const badPath = join(directory, 'bad.png');
      await writeFile(badPath, new Uint8Array(32).fill(7));
      const attachmentId = 'bad-image';
      database.ensureAttachment({ attachmentId, messagePk: messagePrimaryKey(image), kind: 'image', quality: 'original' });
      database.updateAttachment({ attachmentId, status: 'saved', attempts: 1, mime: 'image/png', extension: 'png', localPath: badPath, size: 32 });
      const result = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'invalid-media.zip'));
      expect(result.report.historyComplete).toBe(true);
      expect(result.report.complete).toBe(false);
      expect(result.report.missingAttachments[0]).toMatchObject({ status: 'invalid', validationStatus: 'invalid', error: 'media-format-unrecognized' });
      expect(result.mediaCount).toBe(0);
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('retains browser verification on export only for the exact saved file hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-media-evidence-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    const mediaPath = join(directory, 'sample.jpg');
    try {
      const image: CapturedMessage = { ...message, kind: 'image' };
      const runId = database.startRun(account, conversation, 'media-evidence-export-run');
      database.savePage({ runId, account, conversation, page: { accountId: account.accountId, conversationId: conversation.conversationId, messages: [image], nextCursor: null, hasMore: false, source: 'test' }, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      database.ensureAttachment({ attachmentId: 'versioned-image', messagePk: messagePrimaryKey(image), kind: 'image', quality: 'original' });
      const firstFile = new Uint8Array([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]);
      await writeFile(mediaPath, firstFile);
      database.updateAttachment({ attachmentId: 'versioned-image', status: 'saved', attempts: 1, mime: 'image/jpeg', extension: 'jpg', localPath: mediaPath, size: firstFile.length });
      const firstVersion = createHash('sha256').update(firstFile).digest('hex');
      database.recordBrowserMediaEvidence('versioned-image', firstVersion, { type: 'image-decoded', naturalWidth: 1, naturalHeight: 1 });
      const first = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'first.zip'));
      const firstZip = unzipSync(new Uint8Array(await readFile(first.outputPath)));
      expect(JSON.parse(strFromU8(firstZip['messages.json'])).messages[0].attachments[0].validationStatus).toBe('browser-verified');

      const replacement = new Uint8Array([0xff, 0xd8, 0xff, 1, 0xff, 0xd9]);
      await writeFile(mediaPath, replacement);
      const second = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'second.zip'));
      const secondZip = unzipSync(new Uint8Array(await readFile(second.outputPath)));
      expect(JSON.parse(strFromU8(secondZip['messages.json'])).messages[0].attachments[0].validationStatus).toBe('signature-valid');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('exports a track-confirmed MP4 voice as audio and keeps its role through ZIP validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-mp4-audio-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const voice: CapturedMessage = { ...message, kind: 'voice', text: '', internalMediaAssets: [{
        resourceKey: 'resource_url:0', role: 'audio', skey: null,
        candidates: [{ url: 'https://media.invalid/voice.mp4', quality: 'original', sourcePath: 'voice.url_list' }]
      }] };
      const runId = database.startRun(account, conversation, 'mp4-audio-export-run');
      database.savePage({ runId, account, conversation, page: { accountId: account.accountId, conversationId: conversation.conversationId, messages: [voice], nextCursor: null, hasMore: false, source: 'test' }, state: 'complete' });
      database.finishRun(runId, 'complete', 'history_end');
      const attachment = database.listAttachments(account.accountId, conversation.conversationId)[0];
      const mediaPath = join(directory, 'voice.m4a');
      const media = audioMp4Fixture();
      await writeFile(mediaPath, media);
      database.updateAttachment({ attachmentId: attachment.id, status: 'saved', attempts: 1, mime: 'audio/mp4', extension: 'm4a', localPath: mediaPath, size: media.length, actualFormat: 'mp4', validationStatus: 'signature-valid' });
      const result = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'voice.zip'));
      expect(result.mediaCount).toBe(1);
      expect(result.report.requiredAssetMissingCount).toBe(0);
      const archive = unzipSync(new Uint8Array(await readFile(result.outputPath)));
      expect(Object.keys(archive).some(path => /^media\/.+\.m4a$/.test(path))).toBe(true);
      expect(JSON.parse(strFromU8(archive['messages.json'])).messages[0].attachments[0]).toMatchObject({ mime: 'audio/mp4', extension: 'm4a', validationStatus: 'signature-valid' });
      expect(strFromU8(archive['index.html'])).toContain('<audio controls');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps superseded attachment history in JSON without showing it as a second playable item', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-superseded-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    try {
      const image: CapturedMessage = { ...message, kind: 'voice', text: '' };
      const runId = database.startRun(account, conversation, 'superseded-run');
      database.savePage({ runId, account, conversation, page: {
        accountId: account.accountId, conversationId: conversation.conversationId,
        messages: [image], nextCursor: 'first', hasMore: true, source: 'test'
      }, state: 'running' });
      const legacyId = `att-${createHash('sha256').update(`${messagePrimaryKey(image)}\0${0}`).digest('hex').slice(0, 32)}`;
      const oldAudioPath = join(directory, 'old-audio.m4a');
      const oldAudio = audioMp4Fixture();
      await writeFile(oldAudioPath, oldAudio);
      database.ensureAttachment({ attachmentId: legacyId, messagePk: messagePrimaryKey(image), kind: 'audio', quality: 'source-unverified' });
      database.updateAttachment({ attachmentId: legacyId, status: 'saved', attempts: 1, mime: 'audio/mp4', extension: 'm4a', localPath: oldAudioPath, size: oldAudio.length });
      const replacement: CapturedMessage = { ...image, internalMediaAssets: [{
        resourceKey: 'resource_url:0', role: 'audio', skey: null,
        candidates: [{ url: 'https://media.invalid/new.m4a', quality: 'original', sourcePath: 'resource_url:0.origin_url_list' }]
      }] };
      database.savePage({ runId, account, conversation, page: {
        accountId: account.accountId, conversationId: conversation.conversationId,
        messages: [replacement], nextCursor: 'second', hasMore: true, source: 'test'
      }, state: 'running' });
      const current = database.listAttachments(account.accountId, conversation.conversationId).find(item => item.assetState === 'current')!;
      const imagePath = join(directory, 'new-audio.m4a');
      const newAudio = audioMp4Fixture();
      await writeFile(imagePath, newAudio);
      database.updateAttachment({ attachmentId: current.id, status: 'saved', attempts: 1, mime: 'audio/mp4', extension: 'm4a', localPath: imagePath, size: newAudio.length });

      const result = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'superseded.zip'));
      const archive = unzipSync(new Uint8Array(await readFile(result.outputPath)));
      const html = strFromU8(archive['index.html']);
      const attachments = JSON.parse(strFromU8(archive['messages.json'])).messages[0].attachments;
      expect(attachments.map((item: { assetState: string }) => item.assetState)).toEqual(expect.arrayContaining(['superseded', 'current']));
      expect(result.mediaCount).toBe(2);
      expect(result.report).toMatchObject({
        version: 3,
        attachmentCount: 1,
        savedMediaCount: 1,
        attachmentStatusCounts: { saved: 1 },
        missingAttachments: [],
        supersededAttachmentCount: 1,
        supersededSavedMediaCount: 1,
        supersededAttachmentStatusCounts: { saved: 1 },
        exportedMediaFileCount: 2
      });
      expect(html).toContain('已保存媒体 1 个');
      expect((html.match(/<audio controls/g) ?? [])).toHaveLength(1);

      await rm(oldAudioPath);
      const withoutOldFile = await exportConversation(database, account.accountId, conversation.conversationId, join(directory, 'superseded-missing.zip'));
      expect(withoutOldFile.report).toMatchObject({
        attachmentCount: 1,
        savedMediaCount: 1,
        missingAttachments: [],
        supersededAttachmentCount: 1,
        supersededSavedMediaCount: 0,
        supersededAttachmentStatusCounts: { unavailable: 1 },
        exportedMediaFileCount: 1
      });
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('leaves an existing output intact when export fails before replacing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-atomic-'));
    const database = await ArchiveDatabase.open(join(directory, 'archive.sqlite3'));
    const output = join(directory, 'existing.zip');
    try {
      await writeFile(output, 'keep-existing-output');
      await expect(exportConversation(database, account.accountId, conversation.conversationId, output)).rejects.toThrow('conversation-not-found');
      expect(await readFile(output, 'utf8')).toBe('keep-existing-output');
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves an existing ZIP and removes the temporary output when atomic replacement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-export-replace-'));
    try {
      const output = join(directory, 'existing.zip');
      await writeFile(output, 'old-zip-bytes');
      await expect(writeZipAtomically(output, new Uint8Array([1, 2, 3]), async () => { throw new Error('replace-failed'); })).rejects.toThrow('replace-failed');
      expect(await readFile(output, 'utf8')).toBe('old-zip-bytes');
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
