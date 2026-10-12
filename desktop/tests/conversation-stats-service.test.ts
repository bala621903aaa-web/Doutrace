import { describe, expect, it, vi } from 'vitest';
import { loadConversationStats, parseConversationStatsInput } from '../src/core/conversation-stats-service.js';

describe('conversation-stats-service', () => {
  it('rejects invalid input before touching the database and preserves raw IDs', () => {
    const database = {
      listConversationStatsRows: vi.fn(),
      listMessages: vi.fn(),
      getExportBundle: vi.fn()
    };
    for (const input of [
      null,
      [],
      'x',
      {},
      { accountId: 'a' },
      { accountId: 'a', conversationId: 'b', extra: true },
      { accountId: '  ', conversationId: 'b' },
      { accountId: 'a', conversationId: '' },
      { accountId: 1, conversationId: 'b' }
    ]) {
      expect(() => loadConversationStats(database, input)).toThrowError('archive-stats-input-invalid');
    }
    expect(database.listConversationStatsRows).not.toHaveBeenCalled();
    expect(database.listMessages).not.toHaveBeenCalled();
    expect(database.getExportBundle).not.toHaveBeenCalled();

    const parsed = parseConversationStatsInput({ accountId: ' raw-a ', conversationId: ' raw-c ' });
    expect(parsed).toEqual({ accountId: ' raw-a ', conversationId: ' raw-c ' });
  });

  it('summarizes full stats rows into a scoped DTO without body leakage', () => {
    const rows = [
      { senderId: 'alice', senderName: 'Alice', kind: 'text' as const, sentAtMs: Date.parse('2025-01-01T16:30:00.000Z') },
      { senderId: undefined, senderName: 'Bob', kind: 'image' as const, sentAtMs: null }
    ];
    const database = {
      listConversationStatsRows: vi.fn(() => rows),
      listMessages: vi.fn(),
      getExportBundle: vi.fn()
    };
    const dto = loadConversationStats(database, { accountId: 'acct', conversationId: 'conv' });
    expect(database.listConversationStatsRows).toHaveBeenCalledWith('acct', 'conv');
    expect(database.listMessages).not.toHaveBeenCalled();
    expect(database.getExportBundle).not.toHaveBeenCalled();
    expect(dto).toMatchObject({
      accountId: 'acct',
      conversationId: 'conv',
      scope: 'archived-conversation',
      timeZone: 'Asia/Shanghai'
    });
    expect(dto.stats.totalMessages).toBe(2);
    expect(dto.stats.distinctSenderCount).toBe(2);
    expect(dto.stats.unknownTimestampCount).toBe(1);
    expect(JSON.stringify(dto)).not.toContain('SECRET_BODY');
    expect(Object.keys(dto).sort()).toEqual(['accountId', 'conversationId', 'scope', 'stats', 'timeZone']);
  });

  it('returns complete zero stats for empty conversations and surfaces database errors', () => {
    const emptyDb = { listConversationStatsRows: vi.fn(() => []) };
    expect(loadConversationStats(emptyDb, { accountId: 'a', conversationId: 'c' }).stats).toEqual({
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

    const failing = {
      listConversationStatsRows: vi.fn(() => { throw new Error('db-boom'); })
    };
    expect(() => loadConversationStats(failing, { accountId: 'a', conversationId: 'c' })).toThrowError('db-boom');
  });
});
