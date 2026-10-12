import type { ArchiveDatabase } from './archive-db.js';
import type { DesktopConversationStats } from './desktop-api.js';
import { summarizeConversationStats } from './conversation-stats.js';

export type { DesktopConversationStats };

export function parseConversationStatsInput(input: unknown): { accountId: string; conversationId: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('archive-stats-input-invalid');
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(record, 'accountId') || !Object.prototype.hasOwnProperty.call(record, 'conversationId')) {
    throw new Error('archive-stats-input-invalid');
  }
  const accountId = record.accountId;
  const conversationId = record.conversationId;
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('archive-stats-input-invalid');
  }
  if (typeof conversationId !== 'string' || conversationId.trim() === '') {
    throw new Error('archive-stats-input-invalid');
  }
  return { accountId, conversationId };
}

export function loadConversationStats(database: Pick<ArchiveDatabase, 'listConversationStatsRows'>, input: unknown): DesktopConversationStats {
  const { accountId, conversationId } = parseConversationStatsInput(input);
  const rows = database.listConversationStatsRows(accountId, conversationId);
  return {
    accountId,
    conversationId,
    scope: 'archived-conversation',
    timeZone: 'Asia/Shanghai',
    stats: summarizeConversationStats(rows)
  };
}
