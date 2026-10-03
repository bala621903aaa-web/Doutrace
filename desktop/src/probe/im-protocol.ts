import { createHmac, randomBytes } from 'node:crypto';

// Candidate mappings and their conflicts are documented in P1-REFERENCE-RESEARCH.md.
// This module observes an exchange. It never sends requests or normalizes messages.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FIELDS = 25_000;
const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MAX = (1n << 63n) - 1n;
type WireField = { number: number; wire: number; value: bigint | Uint8Array };

class ProtocolError extends Error {}

function fields(input: Uint8Array): WireField[] {
  if (input.length > MAX_BYTES) throw new ProtocolError('body-too-large');
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= input.length) throw new ProtocolError('truncated-varint');
      const byte = input[offset++];
      value |= BigInt(byte & 127) << BigInt(7 * i);
      if (value > UINT64_MAX) throw new ProtocolError('varint-overflow');
      if ((byte & 128) === 0) return value;
    }
    throw new ProtocolError('varint-overflow');
  };
  const result: WireField[] = [];
  while (offset < input.length) {
    if (result.length >= MAX_FIELDS) throw new ProtocolError('too-many-fields');
    const tag = readVarint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number < 1 || number > 536_870_911) throw new ProtocolError('invalid-field-number');
    if (wire === 0) {
      result.push({ number, wire, value: readVarint() });
      continue;
    }
    let size: number;
    if (wire === 2) {
      const length = readVarint();
      if (length > BigInt(input.length - offset)) throw new ProtocolError('truncated-bytes');
      size = Number(length);
    } else if (wire === 1 || wire === 5) size = wire === 1 ? 8 : 4;
    else throw new ProtocolError('unsupported-wire-type');
    if (size > input.length - offset) throw new ProtocolError('truncated-fixed-field');
    result.push({ number, wire, value: input.subarray(offset, offset + size) });
    offset += size;
  }
  return result;
}

function one(values: WireField[], number: number, wire: number) {
  const matches = values.filter(field => field.number === number);
  if (matches.length > 1) throw new ProtocolError('duplicate-singular-field');
  if (matches[0] && matches[0].wire !== wire) throw new ProtocolError('unexpected-wire-type');
  return matches[0]?.value;
}

function integer(values: WireField[], number: number) {
  return one(values, number, 0) as bigint | undefined;
}

function bytes(values: WireField[], number: number) {
  return one(values, number, 2) as Uint8Array | undefined;
}

function text(values: WireField[], number: number) {
  const value = bytes(values, number);
  if (!value) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { throw new ProtocolError('invalid-utf8'); }
}

function safeNumber(value: bigint | undefined) {
  if (value === undefined) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError('unsafe-number');
  return Number(value);
}

function id(value: bigint | undefined) {
  return value && value <= INT64_MAX ? value.toString() : null;
}

function nested(values: WireField[], number: number) {
  const value = bytes(values, number);
  if (!value) throw new ProtocolError('missing-history-wrapper');
  return fields(value);
}

function repeatedBytes(values: WireField[], number: number) {
  return values.filter(field => field.number === number).map(field => {
    if (field.wire !== 2) throw new ProtocolError('unexpected-wire-type');
    return field.value as Uint8Array;
  });
}

const CONTENT_KEYS = ['aweType', 'type', 'text', 'richTextInfos', 'resource_url', 'cover_width', 'cover_height', 'voice_wave', 'duration', 'ai_audio_text', 'display_name', 'url', 'itemId', 'item_id', 'video', 'poster', 'command_type', 'read_index'] as const;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function contentEvidence(raw: string | undefined) {
  let content: unknown;
  try { content = raw === undefined ? undefined : JSON.parse(raw); } catch { /* report a count only */ }
  if (!object(content)) return { validJsonObject: false, keys: [] as string[], signals: [] as string[] };
  const keys = CONTENT_KEYS.filter(key => Object.hasOwn(content, key));
  const signals: string[] = [];
  if (typeof content.text === 'string') signals.push('text');
  if (object(content.resource_url) && ('cover_width' in content || 'cover_height' in content)) signals.push('image');
  if ('voice_wave' in content || (object(content.resource_url) && ('duration' in content || 'duration' in content.resource_url))) signals.push('voice');
  if ('itemId' in content || 'item_id' in content) signals.push('video-share');
  if (object(content.video) && typeof content.video.vid === 'string') signals.push('video-file');
  if (object(content.url) && typeof content.display_name === 'string') signals.push('emoji');
  if ('command_type' in content || 'read_index' in content) signals.push('system');
  return { validJsonObject: true, keys, signals };
}

function describeMessage(raw: Uint8Array) {
  const values = fields(raw);
  const extensionTimes: string[] = [];
  for (const value of repeatedBytes(values, 9)) {
    const entry = fields(value);
    if (text(entry, 1) === 's:server_message_create_time') {
      const candidate = text(entry, 2);
      if (candidate && /^[0-9]{1,20}$/.test(candidate)) extensionTimes.push(candidate);
    }
  }
  const reference = bytes(values, 18);
  let referenceId: string | null = null;
  let referenceMalformed = false;
  if (reference) {
    try { referenceId = id(integer(fields(reference), 1)); }
    catch { referenceMalformed = true; }
  }
  return {
    conversationId: text(values, 1) ?? null,
    serverMessageId: id(integer(values, 3)),
    indexCandidate: integer(values, 4)?.toString() ?? null,
    shortId: id(integer(values, 5)),
    messageTypeCandidate: safeNumber(integer(values, 6)),
    senderId: id(integer(values, 7)),
    content: contentEvidence(text(values, 8)),
    timeField10Candidate: integer(values, 10)?.toString() ?? null,
    extensionTimes,
    referencePresent: Boolean(reference),
    referenceId,
    referenceMalformed
  };
}

function digitCounts(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => value !== null).map(value => value.length))].sort((a, b) => a - b);
}

export type HistoryProtocolEvidence =
  | { state: 'rejected'; reason: string; p1Passed: false }
  | { state: 'server-error'; statusCode: string; p1Passed: false }
  | {
    state: 'decoded';
    p1Passed: false;
    request: {
      conversationFingerprint: string;
      shortIdFingerprint: string;
      sequenceIdDigits: number | null;
      cursorFingerprint: string | null;
      cursorDigits: number | null;
      directionCandidate: number | null;
      limit: number;
    };
    response: {
      statusCode: 0;
      hasMore: boolean | null;
      nextCursorFingerprint: string | null;
      nextCursorDigits: number | null;
      cursorChanged: boolean | null;
      explicitEndCandidate: boolean;
    };
    messages: {
      count: number;
      conversationMatches: number;
      shortIdMatches: number;
      platformIdCount: number;
      uniquePlatformIdCount: number;
      platformIdFingerprints: string[];
      senderIdCount: number;
      indexField4DigitCounts: number[];
      timeField10: { count: number; digitCounts: number[]; plausibleAsMilliseconds: number };
      extensionServerTime: { count: number; digitCounts: number[]; equalToField10: number };
      messageTypeField6Counts: Record<string, number>;
      validContentJsonObjects: number;
      recognizedContentKeyCounts: Record<string, number>;
      contentSignalCounts: Record<string, number>;
      references: { field18Count: number; targetIdCount: number; targetsInSamePage: number; malformedCount: number };
    };
  };

// The random key lives only for this probe run. Fingerprints can be compared
// inside one report, but cannot correlate accounts or messages across runs.
export function createHistoryProtocolObserver(nowMs = Date.now()) {
  const key = randomBytes(32);
  const fingerprint = (kind: string, value: string | null) => value === null ? null : createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex');
  return (request: Uint8Array, response: Uint8Array): HistoryProtocolEvidence => {
    try {
      const requestEnvelope = fields(request);
      if (integer(requestEnvelope, 1) !== 301n) throw new ProtocolError('unexpected-request-command');
      const query = nested(nested(requestEnvelope, 8), 301);
      const conversationId = text(query, 1);
      const shortId = id(integer(query, 3));
      const limit = safeNumber(integer(query, 6));
      if (!conversationId || !shortId || limit === null || limit < 1 || limit > 1_000) throw new ProtocolError('incomplete-history-request');
      const requestCursor = integer(query, 5)?.toString() ?? null;

      const responseEnvelope = fields(response);
      if (integer(responseEnvelope, 1) !== 301n) throw new ProtocolError('unexpected-response-command');
      const status = integer(responseEnvelope, 3);
      if (status === undefined) throw new ProtocolError('missing-business-status');
      if (status !== 0n) return { state: 'server-error', statusCode: status.toString(), p1Passed: false };
      const page = nested(nested(responseEnvelope, 6), 301);
      const hasMoreValue = integer(page, 3);
      if (hasMoreValue !== undefined && hasMoreValue !== 0n && hasMoreValue !== 1n) throw new ProtocolError('invalid-has-more');
      const hasMore = hasMoreValue === undefined ? null : hasMoreValue === 1n;
      const nextCursor = integer(page, 2)?.toString() ?? null;
      const messageBytes = repeatedBytes(page, 1);
      if (messageBytes.length > 1_000) throw new ProtocolError('too-many-messages');
      const messages = messageBytes.map(describeMessage);
      const ids = messages.map(message => message.serverMessageId).filter((value): value is string => value !== null);
      const uniqueIds = new Set(ids);
      const contentKeys: Record<string, number> = {};
      const contentSignals: Record<string, number> = {};
      const typeCodes: Record<string, number> = {};
      for (const message of messages) {
        for (const name of message.content.keys) contentKeys[name] = (contentKeys[name] ?? 0) + 1;
        for (const name of message.content.signals) contentSignals[name] = (contentSignals[name] ?? 0) + 1;
        if (message.messageTypeCandidate !== null) {
          const type = String(message.messageTypeCandidate);
          typeCodes[type] = (typeCodes[type] ?? 0) + 1;
        }
      }
      return {
        state: 'decoded', p1Passed: false,
        request: {
          conversationFingerprint: fingerprint('conversation', conversationId)!,
          shortIdFingerprint: fingerprint('short-id', shortId)!,
          sequenceIdDigits: integer(requestEnvelope, 2)?.toString().length ?? null,
          cursorFingerprint: fingerprint('cursor', requestCursor),
          cursorDigits: requestCursor?.length ?? null,
          directionCandidate: safeNumber(integer(query, 4)), limit
        },
        response: {
          statusCode: 0, hasMore,
          nextCursorFingerprint: fingerprint('cursor', nextCursor),
          nextCursorDigits: nextCursor?.length ?? null,
          cursorChanged: requestCursor === null || nextCursor === null ? null : requestCursor !== nextCursor,
          explicitEndCandidate: hasMore === false
        },
        messages: {
          count: messages.length,
          conversationMatches: messages.filter(message => message.conversationId === conversationId).length,
          shortIdMatches: messages.filter(message => message.shortId === shortId).length,
          platformIdCount: ids.length, uniquePlatformIdCount: uniqueIds.size,
          platformIdFingerprints: ids.map(value => fingerprint('message', value)!),
          senderIdCount: messages.filter(message => message.senderId !== null).length,
          indexField4DigitCounts: digitCounts(messages.map(message => message.indexCandidate)),
          timeField10: {
            count: messages.filter(message => message.timeField10Candidate !== null).length,
            digitCounts: digitCounts(messages.map(message => message.timeField10Candidate)),
            plausibleAsMilliseconds: messages.filter(message => {
              if (!message.timeField10Candidate) return false;
              const value = BigInt(message.timeField10Candidate);
              return value >= 1_262_304_000_000n && value <= BigInt(Math.trunc(nowMs + 86_400_000));
            }).length
          },
          extensionServerTime: {
            count: messages.reduce((sum, message) => sum + message.extensionTimes.length, 0),
            digitCounts: digitCounts(messages.flatMap(message => message.extensionTimes)),
            equalToField10: messages.filter(message => message.timeField10Candidate !== null && message.extensionTimes.includes(message.timeField10Candidate)).length
          },
          messageTypeField6Counts: typeCodes,
          validContentJsonObjects: messages.filter(message => message.content.validJsonObject).length,
          recognizedContentKeyCounts: contentKeys, contentSignalCounts: contentSignals,
          references: {
            field18Count: messages.filter(message => message.referencePresent).length,
            targetIdCount: messages.filter(message => message.referenceId !== null).length,
            targetsInSamePage: messages.filter(message => message.referenceId !== null && uniqueIds.has(message.referenceId)).length,
            malformedCount: messages.filter(message => message.referenceMalformed).length
          }
        }
      };
    } catch (error) {
      return { state: 'rejected', reason: error instanceof ProtocolError ? error.message : 'unreadable-protocol', p1Passed: false };
    }
  };
}
