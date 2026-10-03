import { describe, expect, it } from 'vitest';
import { createHistoryProtocolObserver } from '../src/probe/im-protocol.js';

// Invented wire fixtures exercise decoding and privacy, and are never supplied
// to the desktop UI or presented as real P1 evidence.
const conv = 'private-conversation';
const shortId = 7_600_000_000_000_000_123n;
const messageId = 7_650_000_000_000_000_321n;
const cursor = 1_770_000_000_000_000n;
const timeMs = 1_770_000_000_123n;
const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => [...part]));
function varint(value: bigint): Uint8Array {
  const result: number[] = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    result.push(byte | (value ? 128 : 0));
  } while (value);
  return new Uint8Array(result);
}
function numberField(number: number, value: bigint) { return join(varint(BigInt(number) << 3n), varint(value)); }
function byteField(number: number, value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return join(varint((BigInt(number) << 3n) | 2n), varint(BigInt(bytes.length)), bytes);
}
function request(pageCursor = cursor, customShortId = shortId) {
  return join(numberField(1, 301n), numberField(2, 12345n), byteField(4, 'PRIVATE_TOKEN'),
    byteField(8, byteField(301, join(byteField(1, conv), numberField(2, 1n), numberField(3, customShortId), numberField(4, 1n), numberField(5, pageCursor), numberField(6, 50n)))),
    byteField(15, join(byteField(1, 'identity_security_token'), byteField(2, 'PRIVATE_AUTH_HEADER'))));
}
function message(overrides: { id?: bigint; conv?: string; shortId?: bigint; content?: string; reference?: Uint8Array } = {}) {
  return join(byteField(1, overrides.conv ?? conv), numberField(2, 1n), numberField(3, overrides.id ?? messageId), numberField(4, cursor),
    numberField(5, overrides.shortId ?? shortId), numberField(6, 7n), numberField(7, 3_000_000_000_000_001n),
    byteField(8, overrides.content ?? JSON.stringify({ text: 'PRIVATE_CHAT_BODY', private_dynamic_key: 'PRIVATE_DYNAMIC_VALUE' })),
    byteField(9, join(byteField(1, 's:server_message_create_time'), byteField(2, String(timeMs)))), numberField(10, timeMs),
    ...(overrides.reference ? [byteField(18, overrides.reference)] : []));
}
function response(messages = [message()], flag: bigint | null = 1n, options: { status?: bigint; wrapper?: boolean; next?: bigint | null } = {}) {
  const next = options.next === undefined ? cursor - 1n : options.next;
  const page = join(...messages.map(value => byteField(1, value)), ...(next === null ? [] : [numberField(2, next)]), ...(flag === null ? [] : [numberField(3, flag)]));
  return join(numberField(1, 301n), numberField(3, options.status ?? 0n), byteField(4, 'PRIVATE_SERVER_DESCRIPTION'),
    ...(options.wrapper === false ? [] : [byteField(6, byteField(301, page))]));
}
const observe = () => createHistoryProtocolObserver(1_790_000_000_000);

describe('candidate IM protocol evidence', () => {
  it('preserves large IDs without losing identity through Number conversion', () => {
    const result = observe()(request(), response([message(), message({ id: messageId + 1n })]));
    expect(result.state).toBe('decoded');
    if (result.state !== 'decoded') return;
    expect(result.messages.uniquePlatformIdCount).toBe(2);
    expect(new Set(result.messages.platformIdFingerprints).size).toBe(2);
    expect(result.messages.shortIdMatches).toBe(2);
  });

  it('correlates next-page cursors within a run while keeping the short ID fixed', () => {
    const observer = observe();
    const first = observer(request(), response());
    const second = observer(request(cursor - 1n), response([], 0n));
    if (first.state !== 'decoded' || second.state !== 'decoded') throw new Error('fixture not decoded');
    expect(first.response.nextCursorFingerprint).toBe(second.request.cursorFingerprint);
    expect(first.request.shortIdFingerprint).toBe(second.request.shortIdFingerprint);
    expect(first.request.cursorFingerprint).not.toBe(second.request.cursorFingerprint);
    expect(second.response.explicitEndCandidate).toBe(true);
    expect(second.p1Passed).toBe(false);
  });

  it('keeps missing has_more unknown and never treats a missing wrapper as an empty history', () => {
    const missingFlag = observe()(request(), response([], null));
    if (missingFlag.state !== 'decoded') throw new Error('fixture not decoded');
    expect(missingFlag.response.hasMore).toBeNull();
    expect(missingFlag.response.explicitEndCandidate).toBe(false);
    expect(observe()(request(), response([], 0n, { wrapper: false }))).toMatchObject({ state: 'rejected', reason: 'missing-history-wrapper' });
  });

  it('checks the business status instead of assuming HTTP 200 means success', () => {
    expect(observe()(request(), response([], 0n, { status: 4n }))).toEqual({ state: 'server-error', statusCode: '4', p1Passed: false });
    expect(observe()(request(), response([], 2n))).toMatchObject({ state: 'rejected', reason: 'invalid-has-more' });
  });

  it('reports mismatched conversations and duplicate message IDs', () => {
    const result = observe()(request(), response([message(), message({ conv: 'other-conversation', shortId: shortId + 1n })]));
    if (result.state !== 'decoded') throw new Error('fixture not decoded');
    expect(result.messages.conversationMatches).toBe(1);
    expect(result.messages.shortIdMatches).toBe(1);
    expect(result.messages.platformIdCount).toBe(2);
    expect(result.messages.uniquePlatformIdCount).toBe(1);
  });

  it('reports time candidates and exact extension equality without declaring a time unit', () => {
    const result = observe()(request(), response());
    if (result.state !== 'decoded') throw new Error('fixture not decoded');
    expect(result.messages.indexField4DigitCounts).toEqual([16]);
    expect(result.messages.timeField10).toEqual({ count: 1, digitCounts: [13], plausibleAsMilliseconds: 1 });
    expect(result.messages.extensionServerTime.equalToField10).toBe(1);
    expect(result.p1Passed).toBe(false);
  });

  it('records voice and text signals independently, even when aweType is zero', () => {
    const content = JSON.stringify({ aweType: 0, text: 'PRIVATE_VOICE_TRANSCRIPT', resource_url: { url_list: ['https://private.invalid/audio?secret=1'] }, duration: 1000 });
    const result = observe()(request(), response([message({ content })]));
    if (result.state !== 'decoded') throw new Error('fixture not decoded');
    expect(result.messages.contentSignalCounts).toEqual({ text: 1, voice: 1 });
    expect(result.messages.recognizedContentKeyCounts.resource_url).toBe(1);
  });

  it('correlates an explicit field18 target while keeping its snapshot private', () => {
    const ref = join(numberField(1, messageId), byteField(2, JSON.stringify({ content: 'PRIVATE_REF_SNAPSHOT', nickname: 'PRIVATE_REF_NICKNAME' })));
    const result = observe()(request(), response([message(), message({ id: messageId + 1n, reference: ref })]));
    if (result.state !== 'decoded') throw new Error('fixture not decoded');
    expect(result.messages.references).toEqual({ field18Count: 1, targetIdCount: 1, targetsInSamePage: 1, malformedCount: 0 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REF');
  });

  it('rejects truncated bytes, overflowing varints and ambiguous singular fields', () => {
    expect(observe()(new Uint8Array([10, 5, 1]), response())).toMatchObject({ state: 'rejected', reason: 'truncated-bytes' });
    expect(observe()(join(new Uint8Array([8]), new Uint8Array(10).fill(255)), response())).toMatchObject({ state: 'rejected', reason: 'varint-overflow' });
    expect(observe()(join(request(), numberField(1, 301n)), response())).toMatchObject({ state: 'rejected', reason: 'duplicate-singular-field' });
    expect(observe()(new Uint8Array([8, 128]), response())).toMatchObject({ state: 'rejected', reason: 'truncated-varint' });
  });

  it('omits credentials, chat content, raw IDs, dynamic keys and server descriptions', () => {
    const result = observe()(request(), response());
    const saved = JSON.stringify(result);
    for (const privateValue of ['PRIVATE_', conv, String(shortId), String(messageId), String(cursor), String(timeMs), 'private_dynamic_key', 'identity_security_token']) {
      expect(saved).not.toContain(privateValue);
    }
    expect(observe()(request(), response())).not.toEqual(result);
  });
});
