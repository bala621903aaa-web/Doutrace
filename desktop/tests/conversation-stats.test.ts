import { describe, expect, it } from 'vitest';
import type { ArchiveMessageRow } from '../src/core/archive-db.js';
import { summarizeConversationStats } from '../src/core/conversation-stats.js';

function message(overrides: Partial<ArchiveMessageRow> = {}): ArchiveMessageRow {
  return {
    messagePk: 'synthetic-message',
    accountId: 'synthetic-account',
    conversationId: 'synthetic-conversation',
    senderId: 'synthetic-sender',
    senderName: 'Synthetic Sender',
    sentAtMs: Date.parse('2025-01-01T16:30:00.000Z'),
    sentAtSource: 'synthetic-test',
    sentAtPrecision: 'millisecond',
    kind: 'text',
    text: 'synthetic body',
    segments: [],
    attachmentCandidates: [],
    capturedAt: '2025-01-02T00:30:00.000+08:00',
    ...overrides
  };
}

describe('summarizeConversationStats', () => {
  it('counts rows, sender identities, kinds, and Asia/Shanghai calendar days', () => {
    const rows = [
      message({ senderId: 'alice', senderName: 'Alice', kind: 'text', sentAtMs: Date.parse('2025-01-01T15:30:00.000Z') }),
      message({ messagePk: 'second', senderId: 'alice', senderName: 'Alice A.', kind: 'image', sentAtMs: Date.parse('2025-01-01T16:30:00.000Z') }),
      message({ messagePk: 'third', senderId: undefined, senderName: 'Bob', kind: 'voice', sentAtMs: Date.parse('2025-01-02T08:30:00.000Z') }),
      message({ messagePk: 'fourth', senderId: undefined, senderName: 'Bob', kind: 'text', sentAtMs: Date.parse('2025-01-02T08:45:00.000Z') })
    ];

    const stats = summarizeConversationStats(rows);

    expect(stats.totalMessages).toBe(4);
    expect(stats.invalidMessageCount).toBe(0);
    expect(stats.distinctSenderCount).toBe(2);
    expect(stats.senderCounts).toEqual([
      { senderId: 'alice', senderName: 'Alice', count: 2 },
      { senderId: null, senderName: 'Bob', count: 2 }
    ]);
    expect(stats.unknownSenderMessageCount).toBe(0);
    expect(stats.kindCounts).toEqual({
      text: 2, image: 1, voice: 1, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0
    });
    expect(stats.dailyCounts).toEqual({ '2025-01-01': 1, '2025-01-02': 3 });
    expect(stats.unknownTimestampCount).toBe(0);
    expect(stats.invalidTimestampCount).toBe(0);
  });

  it('returns a complete zero-valued result for empty input', () => {
    expect(summarizeConversationStats([])).toEqual({
      totalMessages: 0,
      invalidMessageCount: 0,
      distinctSenderCount: 0,
      senderCounts: [],
      unknownSenderMessageCount: 0,
      kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
      dailyCounts: {},
      unknownTimestampCount: 0,
      invalidTimestampCount: 0
    });
  });

  it('separates unknown timestamps from invalid values and excludes both from daily totals', () => {
    const rows = [
      message({ sentAtMs: null }),
      message({ messagePk: 'missing-time', sentAtMs: undefined as unknown as null }),
      message({ messagePk: 'nan-time', sentAtMs: Number.NaN }),
      message({ messagePk: 'infinite-time', sentAtMs: Number.POSITIVE_INFINITY }),
      message({ messagePk: 'out-of-range-time', sentAtMs: 8.64e15 + 1 }),
      message({ messagePk: 'string-time', sentAtMs: 'not-a-timestamp' as unknown as number }),
      message({ messagePk: 'valid-time', sentAtMs: Date.parse('2025-01-01T16:30:00.000Z') })
    ];

    const stats = summarizeConversationStats(rows);

    expect(stats.totalMessages).toBe(7);
    expect(stats.unknownTimestampCount).toBe(2);
    expect(stats.invalidTimestampCount).toBe(4);
    expect(stats.dailyCounts).toEqual({ '2025-01-02': 1 });
  });

  it('maps unsupported kinds and missing senders to explicit unknown buckets', () => {
    const stats = summarizeConversationStats([
      message({ senderId: undefined, senderName: undefined, kind: 'future-kind' as ArchiveMessageRow['kind'] }),
      message({ messagePk: 'also-unknown', senderId: '', senderName: '   ', kind: 'unknown' })
    ]);

    expect(stats.totalMessages).toBe(2);
    expect(stats.distinctSenderCount).toBe(0);
    expect(stats.unknownSenderMessageCount).toBe(2);
    expect(stats.senderCounts).toEqual([{ senderId: null, senderName: null, count: 2 }]);
    expect(stats.kindCounts.unknown).toBe(2);
  });

  it('skips malformed array entries without throwing and does not read message content', () => {
    const row = message();
    Object.defineProperty(row, 'text', { get: () => { throw new Error('message-content-must-not-be-read'); } });
    const rows = [row, null, 42, []] as unknown as ArchiveMessageRow[];

    const stats = summarizeConversationStats(rows);

    expect(stats.totalMessages).toBe(1);
    expect(stats.invalidMessageCount).toBe(3);
    expect(stats.kindCounts.text).toBe(1);
  });

  it('does not mutate the input rows or array', () => {
    const row = Object.freeze(message({ senderId: 'fixed', kind: 'emoji' }));
    const rows = Object.freeze([row]);
    const before = { ...row };

    summarizeConversationStats(rows);

    expect(row).toEqual(before);
    expect(rows).toHaveLength(1);
  });
});
