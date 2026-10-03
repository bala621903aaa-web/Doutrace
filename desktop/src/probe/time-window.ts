import type { DecodedHistoryMessage } from '../im/protocol.js';
import type { CapturedHistoryExchange, CapturedInitExchange } from './history-transport.js';

export interface VisibleMessageWindow {
  messages: DecodedHistoryMessage[];
  initializationExchanges: number;
  historyExchanges: number;
  duplicateSourceMessages: number;
  conflictingMessageIds: number;
  sourceDecodeErrors: number;
}

function messageIdentity(message: DecodedHistoryMessage) {
  return JSON.stringify([message.conversationId, message.platformMessageId, message.conversationShortId?.toString(),
    message.indexInConversation?.toString(), message.senderUid?.toString(), message.messageType?.toString(),
    message.contentJson, message.timeField10?.toString(), message.extensions.filter(item => item.key === 's:server_message_create_time')]);
}

/** Only the selected conversation is returned; other init conversations are never serialized. */
export function collectVisibleMessageWindow(input: {
  conversationId: string;
  initialization: CapturedInitExchange[];
  history: CapturedHistoryExchange[];
}): VisibleMessageWindow {
  const result: VisibleMessageWindow = { messages: [], initializationExchanges: 0, historyExchanges: 0, duplicateSourceMessages: 0, conflictingMessageIds: 0, sourceDecodeErrors: 0 };
  const versions = new Map<string, { signature: string; message: DecodedHistoryMessage }>();
  const conflictingIds = new Set<string>();
  const add = (message: DecodedHistoryMessage) => {
    if (message.conversationId !== input.conversationId || !message.platformMessageId) return;
    const previous = versions.get(message.platformMessageId);
    const signature = messageIdentity(message);
    if (previous) {
      if (previous.signature === signature) result.duplicateSourceMessages++;
      else conflictingIds.add(message.platformMessageId);
    } else versions.set(message.platformMessageId, { signature, message });
  };
  for (const exchange of input.initialization) {
    if (exchange.decodeError) result.sourceDecodeErrors++;
    if (exchange.httpStatus < 200 || exchange.httpStatus >= 300 || exchange.decoded?.statusCode !== 0n) continue;
    if (!exchange.decoded.messages.some(message => message.conversationId === input.conversationId)) continue;
    result.initializationExchanges++;
    exchange.decoded.messages.forEach(add);
  }
  for (const exchange of input.history) {
    if (exchange.request.decoded.conversationId !== input.conversationId) continue;
    if (exchange.decodeError) result.sourceDecodeErrors++;
    if (exchange.httpStatus < 200 || exchange.httpStatus >= 300 || exchange.decoded?.state !== 'decoded' || exchange.decoded.statusCode !== 0n) continue;
    result.historyExchanges++;
    exchange.decoded.messages.forEach(add);
  }
  result.conflictingMessageIds = conflictingIds.size;
  result.messages = [...versions].filter(([id]) => !conflictingIds.has(id)).map(([, item]) => item.message)
    .sort((left, right) => {
      const a = left.indexInConversation;
      const b = right.indexInConversation;
      return a === null || b === null || a === b ? 0 : a > b ? -1 : 1;
    });
  return result;
}
