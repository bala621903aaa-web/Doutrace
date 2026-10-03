export type MessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'video-file'
  | 'video-share'
  | 'emoji'
  | 'system'
  | 'unknown';

export type TimestampPrecision = 'millisecond' | 'second' | 'minute' | 'label' | 'unknown';

export interface AccountInfo {
  accountId: string;
  displayName?: string;
  source: string;
}

export interface ConversationInfo {
  conversationId: string;
  title: string;
  participantIds: string[];
  source: string;
}

export interface ReplySnapshot {
  senderId?: string;
  senderName?: string;
  text?: string;
  kind?: MessageKind;
  status: 'available' | 'missing' | 'unresolved';
}

export interface ContentSegment {
  kind: 'text' | 'emoji' | 'image' | 'unknown';
  text?: string;
  assetId?: string;
  label?: string;
  source?: string;
}

export interface NormalizedMessage {
  accountId: string;
  conversationId: string;
  platformMessageId?: string;
  senderId?: string;
  senderName?: string;
  sentAtMs: number | null;
  sentAtRaw?: string | number;
  sentAtSource: string;
  sentAtPrecision: TimestampPrecision;
  sequence?: string | number;
  kind: MessageKind;
  text: string;
  segments: ContentSegment[];
  replyToPlatformMessageId?: string;
  replySnapshot?: ReplySnapshot;
  attachmentCandidates: string[];
  rawPayloadRef?: string;
}

export interface HistoryPage {
  accountId: string;
  conversationId: string;
  messages: NormalizedMessage[];
  nextCursor: string | null;
  hasMore: boolean | null;
  source: string;
}

export interface HistoryAdapter {
  getAccount(): Promise<AccountInfo>;
  listPrivateConversations(): Promise<ConversationInfo[]>;
  fetchHistory(input: {
    conversationId: string;
    cursor: string | null;
    signal: AbortSignal;
  }): Promise<HistoryPage>;
  close(): Promise<void>;
}
