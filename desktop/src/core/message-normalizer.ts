import { createHash } from 'node:crypto';
import type { DecodedHistoryMessage } from '../im/protocol.js';
import type {
  CapturedMessage, ContentSegment, InternalMediaAssetDescription, InternalMediaCandidate,
  InternalMediaQuality, InternalMediaRole, InternalMessagePayload, MessageKind
} from './contracts.js';

const MAX_FILTERED_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_ENTRIES = 64;
const MAX_STRING_LENGTH = 16_384;
const MAX_ASSETS = 16;
const MAX_CANDIDATES_PER_ASSET = 20;

const WIRE_KINDS: Readonly<Record<number, MessageKind | 'reference'>> = {
  1: 'system', 2: 'image', 5: 'emoji', 7: 'text', 8: 'video-share',
  17: 'voice', 27: 'image', 30: 'video-file', 73: 'system', 83: 'reference',
  109: 'voice', 501: 'voice'
};

const ROOT_FIELDS = new Set([
  'aweType', 'type', 'text', 'richTextInfos', 'resource_url', 'cover_width', 'cover_height',
  'voice_wave', 'duration', 'ai_audio_text', 'display_name', 'itemId', 'item_id', 'aweme_id',
  'video', 'poster', 'emoji', 'sticker', 'sticker_id', 'audio', 'audio_url', 'command_type',
  'read_index', 'description', 'push_detail', 'title', 'image', 'image_url', 'content',
  'call_type', 'call_status', 'call_duration', 'start_time', 'end_time', 'status', 'cover', 'cover_url'
]);
const NESTED_TEXT_FIELDS = new Set([
  'text', 'type', 'name', 'title', 'description', 'display_name', 'push_detail', 'richTextInfos',
  'children', 'spans', 'items', 'value', 'content', 'emoji', 'sticker', 'sticker_id', 'itemId',
  'item_id', 'aweme_id', 'duration', 'width', 'height', 'cover_width', 'cover_height',
  'command_type', 'read_index', 'status', 'call_status', 'call_type', 'call_duration', 'start_time', 'end_time'
]);
const MEDIA_FIELDS = new Set([
  'url', 'uri', 'url_list', 'origin_url_list', 'large_url_list', 'skey', 'resource_url',
  'poster', 'cover', 'cover_url', 'image', 'image_url', 'video', 'audio', 'audio_url',
  'emoji', 'sticker', 'sticker_id', 'width', 'height', 'cover_width', 'cover_height',
  'mime_type', 'format', 'codec', 'type', 'duration', 'name', 'display_name', 'title'
]);
const MEDIA_ROOT_FIELDS = new Set(['resource_url', 'poster', 'cover', 'cover_url', 'image', 'image_url', 'video', 'audio', 'audio_url', 'emoji', 'sticker', 'url']);
const SENSITIVE_KEY = /(?:authorization|cookie|token|signature|secret|password|request|response|header|csrf|credential|session)/i;
const URL_FIELDS = new Set(['url', 'uri', 'url_list', 'origin_url_list', 'large_url_list', 'cover_url', 'image_url', 'audio_url']);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown, max = MAX_STRING_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\u0000/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function safeMediaUrl(value: unknown): string | null {
  const candidate = stringValue(value, 8_192);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

function safeSkey(value: unknown): string | null {
  const candidate = stringValue(value, 256);
  return candidate;
}

function mediaChildContext(parentMedia: boolean, key: string, kind: MessageKind): boolean {
  if (parentMedia) return true;
  if (!MEDIA_ROOT_FIELDS.has(key)) return false;
  if (key === 'url') return kind === 'emoji';
  if (key === 'image' || key === 'image_url') return kind === 'image' || kind === 'video-share' || kind === 'emoji';
  if (key === 'audio' || key === 'audio_url') return kind === 'voice';
  if (key === 'video') return kind === 'video-file' || kind === 'video-share';
  if (key === 'poster' || key === 'cover' || key === 'cover_url') return kind === 'video-share' || kind === 'video-file';
  if (key === 'emoji' || key === 'sticker') return kind === 'emoji';
  return key === 'resource_url';
}

function sanitizeValue(
  value: unknown,
  key: string,
  kind: MessageKind,
  mediaContext: boolean,
  depth: number,
  unsupported: Set<string>
): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (SENSITIVE_KEY.test(key) && !(key.toLowerCase() === 'skey' && mediaContext)) return undefined;
  const childMedia = mediaChildContext(mediaContext, key, kind);
  if (key.toLowerCase() === 'skey') {
    if (!mediaContext && kind !== 'voice') return undefined;
    return safeSkey(value) ?? undefined;
  }
  if (URL_FIELDS.has(key) && !mediaContext) return undefined;
  if (typeof value === 'string') {
    if (URL_FIELDS.has(key)) return childMedia ? safeMediaUrl(value) ?? undefined : undefined;
    return stringValue(value) ?? undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeValue(item, key, kind, childMedia, depth + 1, unsupported)).filter(item => item !== undefined);
  }
  if (!isObject(value)) return undefined;
  const result: JsonObject = {};
  const entries = Object.entries(value);
  for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_ENTRIES)) {
    if (SENSITIVE_KEY.test(childKey)) continue;
    const allowed = depth === 0 ? ROOT_FIELDS.has(childKey) || (childKey === 'skey' && kind === 'voice') || (childKey === 'url' && kind === 'emoji')
      : childMedia ? MEDIA_FIELDS.has(childKey) || NESTED_TEXT_FIELDS.has(childKey)
        : NESTED_TEXT_FIELDS.has(childKey);
    if (!allowed) {
      if (childKey.length > 0 && childKey.length <= 80 && unsupported.size < 80) unsupported.add(childKey);
      continue;
    }
    const safe = sanitizeValue(childValue, childKey, kind, childMedia, depth + 1, unsupported);
    if (safe !== undefined) result[childKey] = safe;
  }
  if (entries.length > MAX_OBJECT_ENTRIES) unsupported.add('additional-fields-truncated');
  return result;
}

function wireKind(message: DecodedHistoryMessage): MessageKind | 'reference' | null {
  if (message.messageType === null || message.messageType < 0n || message.messageType > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return WIRE_KINDS[Number(message.messageType)] ?? null;
}

function nonEmptyObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length > 0;
}

function hasUrlShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!isObject(value)) return typeof value === 'string';
  return ['url_list', 'origin_url_list', 'large_url_list', 'url', 'uri'].some(key => Object.hasOwn(value, key));
}

function structuralKind(content: JsonObject): MessageKind | null {
  if (nonEmptyObject(content.video)) return 'video-file';
  if (['itemId', 'item_id', 'aweme_id'].some(key => Object.hasOwn(content, key))) return 'video-share';
  if (Object.hasOwn(content, 'voice_wave') || Object.hasOwn(content, 'audio') || Object.hasOwn(content, 'audio_url') ||
      (Object.hasOwn(content, 'duration') && hasUrlShape(content.resource_url) && !Object.hasOwn(content, 'cover_width') && !Object.hasOwn(content, 'cover_height'))) return 'voice';
  if (Object.hasOwn(content, 'image') || Object.hasOwn(content, 'image_url') ||
      (hasUrlShape(content.resource_url) && (Object.hasOwn(content, 'cover_width') || Object.hasOwn(content, 'cover_height')))) return 'image';
  if (Object.hasOwn(content, 'emoji') || Object.hasOwn(content, 'sticker') || Object.hasOwn(content, 'sticker_id')) return 'emoji';
  if (Object.hasOwn(content, 'command_type') || Object.hasOwn(content, 'read_index') || Object.hasOwn(content, 'call_status') || Object.hasOwn(content, 'call_type')) return 'system';
  if (typeof content.text === 'string' || typeof content.description === 'string' || typeof content.push_detail === 'string') return 'text';
  return null;
}

function nestedStructureKind(content: JsonObject, depth = 0): MessageKind | null {
  if (depth > 3) return null;
  const direct = structuralKind(content);
  if (direct) return direct;
  for (const key of ['content', 'message', 'message_content', 'ref_message']) {
    if (isObject(content[key])) {
      const nested = nestedStructureKind(content[key] as JsonObject, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function referenceBody(content: JsonObject, depth = 0): JsonObject {
  if (depth > 3) return content;
  for (const key of ['content', 'message', 'message_content', 'ref_message']) {
    if (isObject(content[key])) return referenceBody(content[key] as JsonObject, depth + 1);
  }
  return content;
}

function signalKind(message: DecodedHistoryMessage): MessageKind | null {
  const signals = message.content.signals;
  if (signals.includes('video-file')) return 'video-file';
  if (signals.includes('video-share')) return 'video-share';
  if (signals.includes('voice')) return 'voice';
  if (signals.includes('image')) return 'image';
  if (signals.includes('emoji')) return 'emoji';
  if (signals.includes('system')) return 'system';
  if (signals.includes('text')) return 'text';
  return null;
}

function mediaEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.slice(0, MAX_ASSETS);
  return value === null || value === undefined ? [] : [value];
}

function urlValues(value: unknown): unknown[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.slice(0, MAX_CANDIDATES_PER_ASSET);
  if (isObject(value)) {
    if (typeof value.url === 'string') return [value.url];
    if (typeof value.uri === 'string') return [value.uri];
  }
  return [];
}

function addMediaField(
  assets: InternalMediaAssetDescription[],
  root: JsonObject,
  field: string,
  role: InternalMediaRole,
  topLevelSkey: string | null = null
) {
  for (const [index, item] of mediaEntries(root[field]).entries()) {
    if (assets.length >= MAX_ASSETS) return;
    const resourceKey = `${field}:${index}`;
    const candidates: InternalMediaCandidate[] = [];
    const seen = new Set<string>();
    const addCandidates = (value: unknown, quality: InternalMediaQuality, sourcePath: string) => {
      for (const rawUrl of urlValues(value)) {
        const url = safeMediaUrl(rawUrl);
        if (!url || seen.has(`${quality}\0${url}`) || candidates.length >= MAX_CANDIDATES_PER_ASSET) continue;
        seen.add(`${quality}\0${url}`);
        candidates.push({ url, quality, sourcePath });
      }
    };
    if (typeof item === 'string') {
      addCandidates(item, 'unknown', `${resourceKey}.url`);
    } else if (isObject(item)) {
      const variants: Array<[string, InternalMediaQuality]> = [
        ['origin_url_list', 'original'], ['large_url_list', 'large'], ['url_list', 'preview']
      ];
      for (const [variant, quality] of variants) addCandidates(item[variant], quality, `${resourceKey}.${variant}`);
      if (!candidates.length) addCandidates(item.url ?? item.uri, 'unknown', `${resourceKey}.url`);
    }
    if (!candidates.length) continue;
    const skey = safeSkey(isObject(item) ? item.skey : null) ?? (role === 'audio' ? topLevelSkey : null);
    assets.push({ resourceKey, role, skey, candidates });
  }
}

function mediaAssets(content: JsonObject, kind: MessageKind): InternalMediaAssetDescription[] {
  const assets: InternalMediaAssetDescription[] = [];
  const topLevelSkey = kind === 'voice' ? safeSkey(content.skey) : null;
  const addFirstAvailable = (fields: Array<[string, InternalMediaRole]>) => {
    for (const [field, fieldRole] of fields) {
      const before = assets.length;
      addMediaField(assets, content, field, fieldRole, topLevelSkey);
      if (assets.length > before) return;
    }
  };
  if (kind === 'image') addFirstAvailable([['resource_url', 'image'], ['image', 'image'], ['image_url', 'image']]);
  else if (kind === 'voice') addFirstAvailable([['resource_url', 'audio'], ['audio', 'audio'], ['audio_url', 'audio']]);
  else if (kind === 'video-file') {
    addFirstAvailable([['video', 'video']]);
    addMediaField(assets, content, 'poster', 'poster');
  } else if (kind === 'video-share') {
    addFirstAvailable([['poster', 'poster'], ['cover', 'poster'], ['cover_url', 'poster'], ['resource_url', 'poster']]);
  } else if (kind === 'emoji') addFirstAvailable([['emoji', 'emoji'], ['sticker', 'emoji'], ['url', 'emoji']]);
  return assets;
}

function nestedText(value: unknown, result: string[], depth = 0) {
  if (depth > 5 || result.length >= 24) return;
  if (typeof value === 'string') {
    const text = stringValue(value, 8_000);
    if (text && !result.includes(text)) result.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 24).forEach(item => nestedText(item, result, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value).slice(0, 32)) {
    if (SENSITIVE_KEY.test(key) || URL_FIELDS.has(key) || key.toLowerCase() === 'skey') continue;
    if (['text', 'content', 'description', 'name', 'title', 'display_name', 'push_detail', 'value', 'children', 'spans', 'richTextInfos'].includes(key)) {
      nestedText(child, result, depth + 1);
    }
  }
}

function messageText(content: JsonObject, kind: MessageKind): string {
  const values: string[] = [];
  const keys = kind === 'voice'
    ? ['text', 'ai_audio_text', 'description', 'display_name']
    : ['text', 'description', 'display_name', 'push_detail', 'title'];
  for (const key of keys) {
    const value = content[key];
    if (typeof value === 'string') nestedText(value, values);
  }
  nestedText(content.richTextInfos, values);
  return values.join('\n').slice(0, 32_000);
}

function segmentFor(kind: MessageKind, text: string, assets: InternalMediaAssetDescription[]): ContentSegment[] {
  const segments: ContentSegment[] = [];
  if (text) segments.push({ kind: 'text', text, source: 'message-content' });
  for (const asset of assets) {
    segments.push({
      kind: asset.role === 'image' ? 'image' : asset.role === 'emoji' ? 'emoji' : 'unknown',
      label: asset.role === 'poster' ? '封面' : asset.role === 'video' ? '视频文件' : asset.role === 'audio' ? '语音' : undefined,
      source: asset.resourceKey
    });
  }
  if (kind === 'system') segments.push({ kind: 'unknown', label: '系统或通话记录', source: 'wire-message-type' });
  else if (kind === 'voice' && !assets.some(asset => asset.role === 'audio')) segments.push({ kind: 'unknown', label: '语音资源待补', source: 'wire-message-type' });
  else if (kind === 'video-file' && !assets.some(asset => asset.role === 'video')) segments.push({ kind: 'unknown', label: '视频文件待补', source: 'wire-message-type' });
  else if (kind === 'video-share' && !assets.some(asset => asset.role === 'poster')) segments.push({ kind: 'unknown', label: '视频分享卡片', source: 'wire-message-type' });
  else if (kind === 'image' && !assets.some(asset => asset.role === 'image')) segments.push({ kind: 'image', label: '图片资源待补', source: 'wire-message-type' });
  else if (kind === 'emoji' && !assets.some(asset => asset.role === 'emoji') && !text) segments.push({ kind: 'emoji', label: '表情消息', source: 'wire-message-type' });
  else if (kind === 'unknown') segments.push({ kind: 'unknown', label: '消息类型待解释', source: 'unrecognized-content' });
  else if (kind === 'text' && !text) segments.push({ kind: 'unknown', label: '文本内容待补', source: 'wire-message-type' });
  return segments;
}

function statusFor(
  kind: MessageKind,
  content: JsonObject | null,
  assets: InternalMediaAssetDescription[],
  text: string,
  unsupported: string[],
  wire: MessageKind | 'reference' | null,
  structure: MessageKind | null,
  payloadStatus: InternalMessagePayload['payloadStatus']
): { status: NonNullable<CapturedMessage['contentStatus']>; reason?: string } {
  if (payloadStatus === 'invalid') return { status: kind === 'unknown' ? 'unknown' : 'partial', reason: 'payload-invalid' };
  if (kind === 'unknown') return { status: 'unknown', reason: wire === null ? 'message-type-unsupported' : 'message-type-unsupported' };
  if (wire && wire !== 'reference' && structure && structure !== 'text' && structure !== wire) {
    return { status: 'partial', reason: 'wire-content-conflict' };
  }
  if (!content) return { status: 'partial', reason: 'payload-content-missing' };
  if (kind === 'text') return text ? { status: 'parsed' } : { status: 'partial', reason: 'text-content-missing' };
  if (kind === 'image') return assets.some(asset => asset.role === 'image') ? { status: 'parsed' } : { status: 'partial', reason: 'image-resource-missing' };
  if (kind === 'voice') return assets.some(asset => asset.role === 'audio') ? { status: 'parsed' } : { status: 'partial', reason: 'voice-resource-missing' };
  if (kind === 'video-file') return assets.some(asset => asset.role === 'video') ? { status: 'parsed' } : { status: 'partial', reason: 'video-file-missing' };
  if (kind === 'video-share') {
    const card = ['itemId', 'item_id', 'aweme_id'].some(key => content[key] !== undefined) || Boolean(text);
    return card ? { status: 'parsed' } : { status: 'partial', reason: 'video-share-card-missing' };
  }
  if (kind === 'emoji') return assets.some(asset => asset.role === 'emoji') || Boolean(text) ? { status: 'parsed' } : { status: 'partial', reason: 'emoji-content-missing' };
  if (kind === 'system') return Boolean(text) || ['command_type', 'read_index', 'call_status', 'call_type'].some(key => content[key] !== undefined)
    ? { status: unsupported.length ? 'partial' : 'parsed', reason: unsupported.length ? 'system-fields-partially-unknown' : undefined }
    : { status: 'partial', reason: 'system-description-missing' };
  return { status: 'partial', reason: structure ? 'content-partially-interpreted' : 'content-keys-unrecognized' };
}

function safePayload(
  raw: string | null,
  decoded: DecodedHistoryMessage,
  kind: MessageKind
): { payload: InternalMessagePayload; content: JsonObject | null; unsupported: string[] } {
  const wireMessageType = decoded.messageType !== null && decoded.messageType >= 0n && decoded.messageType <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(decoded.messageType) : null;
  if (raw === null) return {
    payload: { payloadVersion: 1, wireMessageType, aweType: null, contentJson: null, payloadStatus: 'invalid' },
    content: null, unsupported: []
  };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { payload: { payloadVersion: 1, wireMessageType, aweType: null, contentJson: null, payloadStatus: 'invalid' }, content: null, unsupported: [] };
  }
  if (!isObject(parsed)) return { payload: { payloadVersion: 1, wireMessageType, aweType: null, contentJson: null, payloadStatus: 'invalid' }, content: null, unsupported: [] };
  const unsupportedSet = new Set<string>();
  const filtered = sanitizeValue(parsed, '', kind, false, 0, unsupportedSet);
  if (!isObject(filtered)) return { payload: { payloadVersion: 1, wireMessageType, aweType: null, contentJson: null, payloadStatus: 'invalid' }, content: null, unsupported: [] };
  const unsupported = [...unsupportedSet].sort().slice(0, 80);
  if (unsupported.length) filtered._unsupportedKeys = unsupported;
  const contentJson = JSON.stringify(filtered);
  if (Buffer.byteLength(contentJson, 'utf8') > MAX_FILTERED_BYTES) {
    return { payload: { payloadVersion: 1, wireMessageType, aweType: null, contentJson: null, payloadStatus: 'invalid' }, content: null, unsupported };
  }
  const rawAweType = parsed.aweType;
  const aweType = typeof rawAweType === 'string' ? stringValue(rawAweType, 80)
    : typeof rawAweType === 'number' && Number.isFinite(rawAweType) ? rawAweType : null;
  return {
    payload: { payloadVersion: 1, wireMessageType, aweType, contentJson, payloadStatus: 'present' },
    content: filtered, unsupported
  };
}

export function normalizeDecodedHistoryMessage(message: DecodedHistoryMessage, accountId: string): CapturedMessage {
  const wire = wireKind(message);
  const rawContent: JsonObject | null = (() => {
    if (!message.contentJson) return null;
    try { const value: unknown = JSON.parse(message.contentJson); return isObject(value) ? value : null; } catch { return null; }
  })();
  const structure = rawContent ? (wire === 'reference' ? nestedStructureKind(rawContent) : structuralKind(rawContent)) : null;
  const inferredKind = structure ?? signalKind(message) ?? 'unknown';
  const kind = wire && wire !== 'reference' ? wire : inferredKind;
  const filtered = safePayload(message.contentJson, message, kind);
  const safeContent = filtered.content ? (wire === 'reference' ? referenceBody(filtered.content) : filtered.content) : null;
  const text = safeContent ? messageText(safeContent, kind) : '';
  const assets = safeContent ? mediaAssets(safeContent, kind) : [];
  const status = statusFor(kind, safeContent, assets, text, filtered.unsupported, wire, structure, filtered.payload.payloadStatus);
  const platformMessageId = message.platformMessageId ? BigInt(message.platformMessageId).toString() : undefined;
  const timeRaw = message.timeField10?.toString();
  const sentAtMs = message.timeField10 !== null && message.timeField10 <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(message.timeField10) : null;
  const target = message.reference.targetMessageId;
  const replySnapshot = message.reference.present ? {
    status: target ? 'unresolved' as const : message.reference.malformed ? 'unresolved' as const : 'missing' as const
  } : undefined;
  const attachmentCandidates = assets.flatMap(asset => asset.candidates.map(candidate => candidate.url));
  const segments = segmentFor(kind, text, assets);
  return {
    accountId,
    conversationId: message.conversationId ?? '',
    platformMessageId,
    senderId: message.senderUid?.toString(),
    senderName: undefined,
    sentAtMs,
    sentAtRaw: timeRaw,
    sentAtSource: sentAtMs === null ? 'wire.field10.unavailable' : 'wire.message.field10',
    sentAtPrecision: sentAtMs === null ? 'unknown' : 'millisecond',
    sequence: message.indexInConversation?.toString(),
    kind,
    contentStatus: status.status,
    contentStatusReason: status.reason,
    text,
    segments,
    replyToPlatformMessageId: target ?? undefined,
    replySnapshot,
    attachmentCandidates,
    rawPayloadRef: message.contentJson ? `wire-${createHash('sha256').update(message.contentJson).digest('hex').slice(0, 24)}` : undefined,
    internalPayload: filtered.payload,
    internalMediaAssets: assets
  };
}
