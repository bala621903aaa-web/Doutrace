import { decodeMessage, ProtocolDecodeError, type DecodedHistoryMessage } from './protocol.js';
import { readWireFields, repeatedWireBytes, requiredWireBytes, requiredWireText, requiredWireVarint, wireVarint } from './wire.js';

export const INIT_ENDPOINT_PATH = '/v1/message/get_message_by_init';
// Observed in the original live probe: request 8→2043, response 6→2043→1→2.
// This decoder observes the site's normal initialization. It never replays it.
const INIT_BODY_FIELD = 2043;
const MAX_CONVERSATIONS = 256;
const MAX_INIT_MESSAGES = 4_096;

export interface InitRequestIdentity {
  command: bigint;
  sequenceId: bigint | null;
}

export function decodeInitRequestIdentity(raw: Uint8Array): InitRequestIdentity {
  const envelope = readWireFields(raw);
  const body = readWireFields(requiredWireBytes(envelope, 8));
  readWireFields(requiredWireBytes(body, INIT_BODY_FIELD));
  return { command: requiredWireVarint(envelope, 1), sequenceId: wireVarint(envelope, 2) ?? null };
}

export interface InitMessageResponse {
  command: bigint;
  sequenceId: bigint | null;
  statusCode: bigint;
  conversationCount: number;
  messages: DecodedHistoryMessage[];
}

export function decodeInitMessageResponse(raw: Uint8Array, request: InitRequestIdentity): InitMessageResponse {
  const envelope = readWireFields(raw);
  const command = requiredWireVarint(envelope, 1);
  const sequenceId = wireVarint(envelope, 2) ?? null;
  if (command !== request.command || sequenceId !== request.sequenceId) throw new ProtocolDecodeError('init-response-request-mismatch');
  const statusCode = requiredWireVarint(envelope, 3);
  if (statusCode !== 0n) return { command, sequenceId, statusCode, conversationCount: 0, messages: [] };
  const body = readWireFields(requiredWireBytes(envelope, 6));
  const init = readWireFields(requiredWireBytes(body, INIT_BODY_FIELD));
  const conversations = repeatedWireBytes(init, 1);
  if (conversations.length > MAX_CONVERSATIONS) throw new ProtocolDecodeError('too-many-init-conversations');
  const messages: DecodedHistoryMessage[] = [];
  for (const rawConversation of conversations) {
    const conversation = readWireFields(rawConversation);
    const info = readWireFields(requiredWireBytes(conversation, 1));
    const conversationId = requiredWireText(info, 1);
    const shortId = requiredWireVarint(info, 2);
    for (const rawMessage of repeatedWireBytes(conversation, 2)) {
      if (messages.length >= MAX_INIT_MESSAGES) throw new ProtocolDecodeError('too-many-init-messages');
      const message = decodeMessage(rawMessage);
      if (message.conversationId !== conversationId || message.conversationShortId !== shortId ||
          message.platformMessageId === null || message.senderUid === null || message.indexInConversation === null) {
        throw new ProtocolDecodeError('init-message-identity-mismatch');
      }
      messages.push(message);
    }
  }
  return { command, sequenceId, statusCode, conversationCount: conversations.length, messages };
}
