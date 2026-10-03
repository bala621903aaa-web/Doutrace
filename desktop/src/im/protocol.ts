import {
  bytesField,
  decodeUtf8,
  encodeWireFields,
  fieldValues,
  readWireFields,
  repeatedWireBytes,
  replaceNestedWireField,
  replaceSingularWireField,
  requiredWireBytes,
  requiredWireField,
  requiredWireText,
  requiredWireVarint,
  type WireField,
  type WireValue,
  wireBytes,
  wireText,
  wireVarint,
  WireError
} from './wire.js';

export const HISTORY_COMMAND = 301n;
export const HISTORY_ENDPOINT_PATH = '/v1/message/get_by_conversation';
const MAX_MESSAGES = 1_000;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export class ProtocolDecodeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ProtocolDecodeError';
    this.code = code;
  }
}

function protocolError(error: unknown): ProtocolDecodeError {
  if (error instanceof ProtocolDecodeError) return error;
  if (error instanceof WireError) return new ProtocolDecodeError(error.code);
  return new ProtocolDecodeError('unreadable-protocol');
}

function parse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw protocolError(error);
  }
}

function nested(fields: readonly WireField[], number: number): WireField[] {
  const bytes = requiredWireBytes(fields, number);
  return readWireFields(bytes, { maxBytes: MAX_CONTENT_BYTES, maxNestedBytes: MAX_CONTENT_BYTES });
}

function integerAsNumber(value: bigint | undefined, code: string): number | null {
  if (value === undefined) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolDecodeError(code);
  return Number(value);
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const CONTENT_KEYS = [
  'aweType', 'type', 'text', 'richTextInfos', 'resource_url', 'cover_width', 'cover_height',
  'voice_wave', 'duration', 'ai_audio_text', 'display_name', 'url', 'itemId', 'item_id',
  'aweme_id', 'video', 'poster', 'emoji', 'sticker', 'sticker_id', 'audio', 'audio_url',
  'command_type', 'read_index'
] as const;

export interface ContentEvidence {
  validJsonObject: boolean;
  keys: string[];
  signals: string[];
  text: string | null;
  attachmentUrls: string[];
}

function stringValues(value: unknown, result: string[] = []): string[] {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) result.push(value);
  else if (Array.isArray(value)) value.slice(0, 20).forEach(item => stringValues(item, result));
  else if (jsonObject(value)) Object.values(value).slice(0, 40).forEach(item => stringValues(item, result));
  return result;
}

export function inspectContentJson(raw: string | null): ContentEvidence {
  if (raw === null || raw.length > MAX_CONTENT_BYTES) return { validJsonObject: false, keys: [], signals: [], text: null, attachmentUrls: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { validJsonObject: false, keys: [], signals: [], text: null, attachmentUrls: [] };
  }
  if (!jsonObject(parsed)) return { validJsonObject: false, keys: [], signals: [], text: null, attachmentUrls: [] };
  const keys = CONTENT_KEYS.filter(key => Object.hasOwn(parsed, key));
  const signals: string[] = [];
  const resource = parsed.resource_url;
  const resourceObject = jsonObject(resource);
  const resourceHasImageShape = resourceObject && (
    Object.hasOwn(parsed, 'cover_width') || Object.hasOwn(parsed, 'cover_height') ||
    Object.hasOwn(resource, 'cover_width') || Object.hasOwn(resource, 'cover_height')
  );
  if (typeof parsed.text === 'string') signals.push('text');
  if (resourceHasImageShape || Object.hasOwn(parsed, 'image') || Object.hasOwn(parsed, 'image_url')) signals.push('image');
  if (Object.hasOwn(parsed, 'voice_wave') || Object.hasOwn(parsed, 'audio') || Object.hasOwn(parsed, 'audio_url') ||
      (Object.hasOwn(parsed, 'duration') && (resourceObject || parsed.aweType === 0))) signals.push('voice');
  if (Object.hasOwn(parsed, 'itemId') || Object.hasOwn(parsed, 'item_id') || Object.hasOwn(parsed, 'aweme_id')) signals.push('video-share');
  if (jsonObject(parsed.video)) signals.push('video-file');
  if (Object.hasOwn(parsed, 'emoji') || Object.hasOwn(parsed, 'sticker') || Object.hasOwn(parsed, 'sticker_id') ||
      (typeof parsed.display_name === 'string' && Object.hasOwn(parsed, 'url'))) signals.push('emoji');
  if (Object.hasOwn(parsed, 'command_type') || Object.hasOwn(parsed, 'read_index')) signals.push('system');
  return {
    validJsonObject: true,
    keys: [...keys],
    signals: [...new Set(signals)],
    text: typeof parsed.text === 'string' ? parsed.text : null,
    attachmentUrls: stringValues(parsed).slice(0, 40)
  };
}

export interface HistoryRequest {
  command: bigint;
  sequenceId: bigint | null;
  conversationId: string;
  conversationShortId: bigint;
  direction: bigint | null;
  cursor: bigint | null;
  limit: number;
  raw: Uint8Array;
}

export interface HistoryRequestUpdate {
  cursor: bigint | null;
  sequenceId?: bigint | null;
}

export function decodeHistoryRequest(raw: Uint8Array): HistoryRequest {
  return parse(() => {
    const envelope = readWireFields(raw);
    const command = requiredWireVarint(envelope, 1);
    if (command !== HISTORY_COMMAND) throw new ProtocolDecodeError('unexpected-request-command');
    const body = nested(envelope, 8);
    const query = nested(body, 301);
    const conversationId = requiredWireText(query, 1);
    const shortId = requiredWireVarint(query, 3);
    const limit = integerAsNumber(requiredWireVarint(query, 6), 'unsafe-limit');
    if (!conversationId || limit === null || limit < 1 || limit > 1_000) throw new ProtocolDecodeError('incomplete-history-request');
    return {
      command,
      sequenceId: wireVarint(envelope, 2) ?? null,
      conversationId,
      conversationShortId: shortId,
      direction: wireVarint(query, 4) ?? null,
      cursor: wireVarint(query, 5) ?? null,
      limit,
      raw: new Uint8Array(raw)
    };
  });
}

export function updateHistoryRequest(raw: Uint8Array, update: HistoryRequestUpdate): Uint8Array {
  return parse(() => {
    const envelope = readWireFields(raw);
    const body = nested(envelope, 8);
    const query = nested(body, 301);
    const queryWithCursor = update.cursor === null
      ? fieldValues(query, 5).length > 1
        ? (() => { throw new ProtocolDecodeError('duplicate-singular-field'); })()
        : query.filter(field => field.number !== 5)
      : replaceSingularWireField(query, 5, { number: 5, wireType: 0, value: update.cursor });
    const updatedBody = replaceNestedWireField(body, 301, encodeWireFields(queryWithCursor));
    const updatedEnvelope = replaceNestedWireField(envelope, 8, encodeWireFields(updatedBody));
    if (update.sequenceId === undefined) return encodeWireFields(updatedEnvelope);
    if (update.sequenceId === null) {
      const withoutSequence = fieldValues(updatedEnvelope, 2).length > 1
        ? (() => { throw new ProtocolDecodeError('duplicate-singular-field'); })()
        : updatedEnvelope.filter(field => field.number !== 2);
      return encodeWireFields(withoutSequence);
    }
    return encodeWireFields(replaceSingularWireField(updatedEnvelope, 2, { number: 2, wireType: 0, value: update.sequenceId }));
  });
}

export interface HistoryExtension {
  key: string | null;
  value: string | null;
}

export interface HistoryReference {
  present: boolean;
  targetMessageId: string | null;
  snapshotValidJson: boolean;
  malformed: boolean;
}

export interface DecodedHistoryMessage {
  conversationId: string | null;
  conversationType: bigint | null;
  platformMessageId: string | null;
  indexInConversation: bigint | null;
  conversationShortId: bigint | null;
  messageType: bigint | null;
  senderUid: bigint | null;
  contentJson: string | null;
  content: ContentEvidence;
  extensions: HistoryExtension[];
  timeField10: bigint | null;
  senderSecUid: string | null;
  reference: HistoryReference;
}

function decodeReference(raw: Uint8Array): HistoryReference {
  try {
    const fields = readWireFields(raw, { maxBytes: MAX_CONTENT_BYTES, maxNestedBytes: MAX_CONTENT_BYTES });
    const target = wireVarint(fields, 1);
    const snapshot = wireBytes(fields, 2);
    let snapshotValidJson = false;
    if (snapshot) {
      try { snapshotValidJson = jsonObject(JSON.parse(decodeUtf8(snapshot))); } catch { /* keep false */ }
    }
    return { present: true, targetMessageId: target?.toString() ?? null, snapshotValidJson, malformed: false };
  } catch {
    return { present: true, targetMessageId: null, snapshotValidJson: false, malformed: true };
  }
}

export function decodeMessage(raw: Uint8Array): DecodedHistoryMessage {
  const fields = readWireFields(raw, { maxBytes: MAX_CONTENT_BYTES, maxNestedBytes: MAX_CONTENT_BYTES });
  const contentBytes = wireBytes(fields, 8);
  const contentJson = contentBytes === undefined ? null : decodeUtf8(contentBytes);
  const extensions = repeatedWireBytes(fields, 9).map(value => {
    const entry = readWireFields(value, { maxBytes: MAX_CONTENT_BYTES, maxNestedBytes: MAX_CONTENT_BYTES });
    return { key: wireText(entry, 1) ?? null, value: wireText(entry, 2) ?? null };
  });
  const referenceBytes = wireBytes(fields, 18);
  return {
    conversationId: wireText(fields, 1) ?? null,
    conversationType: wireVarint(fields, 2) ?? null,
    platformMessageId: wireVarint(fields, 3)?.toString() ?? null,
    indexInConversation: wireVarint(fields, 4) ?? null,
    conversationShortId: wireVarint(fields, 5) ?? null,
    messageType: wireVarint(fields, 6) ?? null,
    senderUid: wireVarint(fields, 7) ?? null,
    contentJson,
    content: inspectContentJson(contentJson),
    extensions,
    timeField10: wireVarint(fields, 10) ?? null,
    senderSecUid: wireText(fields, 14) ?? null,
    reference: referenceBytes ? decodeReference(referenceBytes) : { present: false, targetMessageId: null, snapshotValidJson: false, malformed: false }
  };
}

export type DecodedHistoryResponse = {
  state: 'decoded';
  command: bigint;
  statusCode: bigint;
  sequenceId: bigint | null;
  hasMore: boolean | null;
  nextCursor: bigint | null;
  messages: DecodedHistoryMessage[];
  raw: Uint8Array;
} | {
  state: 'server-error';
  command: bigint;
  statusCode: bigint;
  sequenceId: bigint | null;
  raw: Uint8Array;
};

export function decodeHistoryResponse(raw: Uint8Array): DecodedHistoryResponse {
  return parse(() => {
    const envelope = readWireFields(raw);
    const command = requiredWireVarint(envelope, 1);
    if (command !== HISTORY_COMMAND) throw new ProtocolDecodeError('unexpected-response-command');
    const statusCode = requiredWireVarint(envelope, 3);
    const sequenceId = wireVarint(envelope, 2) ?? null;
    if (statusCode !== 0n) return { state: 'server-error', command, statusCode, sequenceId, raw: new Uint8Array(raw) };
    const body = nested(envelope, 6);
    const page = nested(body, 301);
    const hasMoreRaw = wireVarint(page, 3);
    if (hasMoreRaw !== undefined && hasMoreRaw !== 0n && hasMoreRaw !== 1n) throw new ProtocolDecodeError('invalid-has-more');
    const messageBytes = repeatedWireBytes(page, 1);
    if (messageBytes.length > MAX_MESSAGES) throw new ProtocolDecodeError('too-many-messages');
    return {
      state: 'decoded',
      command,
      statusCode,
      sequenceId,
      hasMore: hasMoreRaw === undefined ? null : hasMoreRaw === 1n,
      nextCursor: wireVarint(page, 2) ?? null,
      messages: messageBytes.map(decodeMessage),
      raw: new Uint8Array(raw)
    };
  });
}

export function extensionTimeCandidates(message: DecodedHistoryMessage): string[] {
  return message.extensions
    .filter(extension => extension.key === 's:server_message_create_time' && extension.value !== null && /^\d{1,20}$/.test(extension.value))
    .map(extension => extension.value!);
}

export function wireValueToString(value: WireValue | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'bigint' ? value.toString() : null;
}
