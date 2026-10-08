import type { ArchiveMessageRow } from './archive-db.js';
import type { MessageKind } from './contracts.js';

const MESSAGE_KINDS: ReadonlySet<string> = new Set([
  'text', 'image', 'voice', 'video-file', 'video-share', 'emoji', 'system', 'unknown'
]);

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export interface SenderMessageCount {
  senderId: string | null;
  senderName: string | null;
  count: number;
}

export interface ConversationStats {
  /** Number of object rows summarized; malformed non-object array entries are excluded. */
  totalMessages: number;
  /** Non-object entries skipped from the input array. */
  invalidMessageCount: number;
  /** Identified senders, excluding the unknown-sender bucket. */
  distinctSenderCount: number;
  /** Sender buckets keyed by senderId, or by senderName when senderId is unavailable. */
  senderCounts: SenderMessageCount[];
  unknownSenderMessageCount: number;
  kindCounts: Record<MessageKind, number>;
  /** Message counts keyed by YYYY-MM-DD in Asia/Shanghai. */
  dailyCounts: Record<string, number>;
  /** Rows with a null or missing sentAtMs value. */
  unknownTimestampCount: number;
  /** Rows with a non-number, non-finite, out-of-range, or unformattable sentAtMs value. */
  invalidTimestampCount: number;
}

function emptyKindCounts(): Record<MessageKind, number> {
  return {
    text: 0,
    image: 0,
    voice: 0,
    'video-file': 0,
    'video-share': 0,
    emoji: 0,
    system: 0,
    unknown: 0
  };
}

function emptyStats(): ConversationStats {
  return {
    totalMessages: 0,
    invalidMessageCount: 0,
    distinctSenderCount: 0,
    senderCounts: [],
    unknownSenderMessageCount: 0,
    kindCounts: emptyKindCounts(),
    dailyCounts: {},
    unknownTimestampCount: 0,
    invalidTimestampCount: 0
  };
}

function isMessageRow(value: unknown): value is Partial<ArchiveMessageRow> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeKind(value: unknown): MessageKind {
  return typeof value === 'string' && MESSAGE_KINDS.has(value) ? value as MessageKind : 'unknown';
}

function shanghaiDay(timestamp: unknown): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;

  try {
    const parts = shanghaiDateFormatter.formatToParts(date);
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;
    const day = parts.find(part => part.type === 'day')?.value;
    if (!year || !month || !day) return null;
    return `${year.padStart(4, '0')}-${month}-${day}`;
  } catch {
    return null;
  }
}

/**
 * Summarize only the supplied archive rows, without inferring history completeness or
 * accessing message text, segments, or payload fields.
 * Sender identity uses senderId when present and falls back to senderName; rows without
 * either are grouped as unknown and excluded from distinctSenderCount.
 */
export function summarizeConversationStats(messages: readonly ArchiveMessageRow[]): ConversationStats {
  const result = emptyStats();
  if (!Array.isArray(messages)) return result;

  const senderCounts = new Map<string, SenderMessageCount>();
  let hasUnknownSender = false;

  for (const candidate of messages as readonly unknown[]) {
    if (!isMessageRow(candidate)) {
      result.invalidMessageCount += 1;
      continue;
    }

    result.totalMessages += 1;

    const senderId = normalizedString(candidate.senderId);
    const senderName = normalizedString(candidate.senderName);
    if (senderId === null && senderName === null) result.unknownSenderMessageCount += 1;
    const senderKey = senderId !== null ? `id:${senderId}` : senderName !== null ? `name:${senderName}` : 'unknown';
    let senderCount = senderCounts.get(senderKey);
    if (senderCount) {
      if (senderCount.senderName === null && senderName !== null) senderCount.senderName = senderName;
    } else {
      senderCount = { senderId, senderName, count: 0 };
      senderCounts.set(senderKey, senderCount);
    }
    senderCount.count += 1;
    if (senderKey === 'unknown') hasUnknownSender = true;

    result.kindCounts[normalizeKind(candidate.kind)] += 1;

    const timestamp = candidate.sentAtMs;
    if (timestamp === null || timestamp === undefined) {
      result.unknownTimestampCount += 1;
      continue;
    }
    const day = shanghaiDay(timestamp);
    if (day === null) {
      result.invalidTimestampCount += 1;
      continue;
    }
    result.dailyCounts[day] = (result.dailyCounts[day] ?? 0) + 1;
  }

  result.senderCounts = [...senderCounts.values()];
  result.distinctSenderCount = senderCounts.size - (hasUnknownSender ? 1 : 0);
  return result;
}
