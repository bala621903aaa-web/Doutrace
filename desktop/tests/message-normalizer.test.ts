import { describe, expect, it } from 'vitest';
import { inspectContentJson, type DecodedHistoryMessage } from '../src/im/protocol.js';
import { normalizeDecodedHistoryMessage } from '../src/core/message-normalizer.js';

function decoded(contentJson: string | null, messageType: bigint | null, overrides: Partial<DecodedHistoryMessage> = {}): DecodedHistoryMessage {
  return {
    conversationId: 'conversation-1', conversationType: 1n, platformMessageId: '9007199254740993',
    indexInConversation: 9007199254740994n, conversationShortId: 7n, messageType, senderUid: 20002n,
    contentJson, content: inspectContentJson(contentJson), extensions: [], timeField10: 1_759_440_000_000n,
    senderSecUid: null, reference: { present: false, targetMessageId: null, snapshotValidJson: false, malformed: false },
    ...overrides
  };
}

describe('normalizeDecodedHistoryMessage', () => {
  it('uses wire types first and keeps a voice transcription as voice', () => {
    const voice = normalizeDecodedHistoryMessage(decoded(JSON.stringify({
      text: 'transcribed words', duration: 2100,
      resource_url: { url_list: ['https://media.invalid/voice.m4a?signature=internal'], skey: 'a'.repeat(64) }
    }), 17n), 'account-1');
    expect(voice.kind).toBe('voice');
    expect(voice.contentStatus).toBe('parsed');
    expect(voice.text).toBe('transcribed words');
    expect(voice.internalMediaAssets).toMatchObject([{ resourceKey: 'resource_url:0', role: 'audio', skey: 'a'.repeat(64) }]);
    expect(voice.internalMediaAssets?.[0].candidates[0]).toMatchObject({ quality: 'preview', sourcePath: 'resource_url:0.url_list' });

    const transcriptOnly = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ text: 'words only' }), 501n), 'account-1');
    expect(transcriptOnly.kind).toBe('voice');
    expect(transcriptOnly.contentStatus).toBe('partial');
    expect(transcriptOnly.contentStatusReason).toBe('voice-resource-missing');
  });

  it('recognizes a wire-only image but marks its missing asset partial', () => {
    const image = normalizeDecodedHistoryMessage(decoded('{}', 2n), 'account-1');
    expect(image.kind).toBe('image');
    expect(image.contentStatus).toBe('partial');
    expect(image.segments).toContainEqual(expect.objectContaining({ kind: 'image', label: '图片资源待补' }));
  });

  it('keeps the confirmed picture, emoji, and encrypted-voice wire variants distinct', () => {
    const storyImage = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ resource_url: { url_list: ['https://media.invalid/story.jpg'] } }), 27n), 'account-1');
    expect(storyImage.kind).toBe('image');
    expect(storyImage.contentStatus).toBe('parsed');

    const emoji = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ aweType: 501, emoji: { url_list: ['https://media.invalid/sticker.webp'] } }), 5n), 'account-1');
    expect(emoji.kind).toBe('emoji');
    expect(emoji.internalMediaAssets?.[0].role).toBe('emoji');

    const encryptedVoice = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ aweType: 501, text: 'transcription' }), 109n), 'account-1');
    expect(encryptedVoice.kind).toBe('voice');
    expect(encryptedVoice.contentStatus).toBe('partial');
    expect(encryptedVoice.text).toBe('transcription');
  });

  it('does not let an aweType hint override a conflicting wire message type', () => {
    const message = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ aweType: 501, emoji: { name: 'wave' } }), 501n), 'account-1');
    expect(message.kind).toBe('voice');
    expect(message.contentStatus).toBe('partial');
    expect(message.contentStatusReason).toBe('wire-content-conflict');
  });

  it('unwraps reference content without inventing target IDs', () => {
    const reference = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ content: { text: 'quoted body' } }), 83n, {
      reference: { present: true, targetMessageId: '9007199254740992', snapshotValidJson: false, malformed: false }
    }), 'account-1');
    expect(reference.kind).toBe('text');
    expect(reference.text).toBe('quoted body');
    expect(reference.replyToPlatformMessageId).toBe('9007199254740992');
    expect(reference.contentStatus).toBe('parsed');

    const absent = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ content: { text: 'quoted body' } }), 83n), 'account-1');
    expect(absent.replyToPlatformMessageId).toBeUndefined();
  });

  it('shows system and call records without forcing them into text or voice', () => {
    const system = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ command_type: 4, push_detail: '对方撤回了一条消息' }), 1n), 'account-1');
    expect(system.kind).toBe('system');
    expect(system.contentStatus).toBe('parsed');
    expect(system.text).toBe('对方撤回了一条消息');

    const call = normalizeDecodedHistoryMessage(decoded('{}', 73n), 'account-1');
    expect(call.kind).toBe('system');
    expect(call.contentStatus).toBe('partial');
    expect(call.contentStatusReason).toBe('system-description-missing');
  });

  it('keeps multiple image assets and their quality variants separate', () => {
    const image = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ resource_url: [
      { origin_url_list: ['https://media.invalid/original-a'], large_url_list: ['https://media.invalid/large-a'], url_list: ['https://media.invalid/preview-a'], skey: 'key-a' },
      { origin_url_list: ['https://media.invalid/original-b'], url_list: ['https://media.invalid/preview-b'], skey: 'key-b' }
    ] }), 2n), 'account-1');
    expect(image.internalMediaAssets?.map(asset => asset.resourceKey)).toEqual(['resource_url:0', 'resource_url:1']);
    expect(image.internalMediaAssets?.[0].candidates.map(candidate => candidate.quality)).toEqual(['original', 'large', 'preview']);
    expect(image.internalMediaAssets?.[1].candidates.map(candidate => candidate.quality)).toEqual(['original', 'preview']);
    expect(image.attachmentCandidates).toHaveLength(5);
    expect(image.contentStatus).toBe('parsed');
  });

  it('does not confuse a video-share poster with a video file', () => {
    const share = normalizeDecodedHistoryMessage(decoded(JSON.stringify({
      itemId: 'aweme-1', poster: { url_list: ['https://media.invalid/poster.jpg'] }
    }), 8n), 'account-1');
    expect(share.kind).toBe('video-share');
    expect(share.internalMediaAssets).toMatchObject([{ role: 'poster' }]);
    expect(share.contentStatus).toBe('parsed');

    const file = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ poster: { url_list: ['https://media.invalid/poster.jpg'] } }), 30n), 'account-1');
    expect(file.kind).toBe('video-file');
    expect(file.contentStatus).toBe('partial');
    expect(file.contentStatusReason).toBe('video-file-missing');
    expect(file.internalMediaAssets).toMatchObject([{ role: 'poster' }]);
  });

  it('stores only bounded whitelisted content and names unsupported fields without their values', () => {
    const raw = JSON.stringify({
      text: 'safe display text',
      private_dynamic_key: 'PRIVATE_DYNAMIC_VALUE',
      authorization: 'PRIVATE_AUTH',
      resource_url: { url_list: ['https://media.invalid/image?signature=LOCAL_ONLY'], skey: 'resource-key', access_token: 'PRIVATE_TOKEN' }
    });
    const normalized = normalizeDecodedHistoryMessage(decoded(raw, 2n), 'account-1');
    const stored = normalized.internalPayload?.contentJson ?? '';
    expect(stored).toContain('safe display text');
    expect(stored).toContain('private_dynamic_key');
    expect(stored).not.toContain('PRIVATE_DYNAMIC_VALUE');
    expect(stored).not.toContain('PRIVATE_AUTH');
    expect(stored).not.toContain('PRIVATE_TOKEN');
    expect(normalized.internalPayload?.payloadStatus).toBe('present');
    expect(normalized.rawPayloadRef).toMatch(/^wire-[a-f0-9]{24}$/);

    const unknown = normalizeDecodedHistoryMessage(decoded(JSON.stringify({ unsupported_object: { value: 'DO_NOT_PERSIST' } }), 999n), 'account-1');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.contentStatus).toBe('unknown');
    expect(unknown.text).toBe('');
    expect(unknown.internalPayload?.contentJson).toContain('unsupported_object');
    expect(unknown.internalPayload?.contentJson).not.toContain('DO_NOT_PERSIST');
    expect(unknown.segments).toContainEqual(expect.objectContaining({ kind: 'unknown', label: '消息类型待解释' }));
  });

  it('marks malformed payloads invalid and preserves exact decimal IDs and time', () => {
    const malformed = normalizeDecodedHistoryMessage(decoded('{not-json', 7n), 'account-1');
    expect(malformed.kind).toBe('text');
    expect(malformed.contentStatus).toBe('partial');
    expect(malformed.internalPayload?.payloadStatus).toBe('invalid');
    expect(malformed.internalPayload?.contentJson).toBeNull();
    expect(malformed.platformMessageId).toBe('9007199254740993');
    expect(malformed.sequence).toBe('9007199254740994');
    expect(malformed.sentAtMs).toBe(1_759_440_000_000);
  });
});
