import type { ArchiveAttachmentRow, ArchiveConversationRow, ArchiveMessageRow, BrowserMediaEvidence, BrowserMediaEvidenceEvent } from './archive-db.js';
import type { AccountInfo, ConversationInfo } from './contracts.js';
import type { CollectorSnapshot } from './collector.js';
import type { RepairConversationResult } from './archive-repair.js';

export interface DesktopAppState {
  version: string;
  validationGate: 'p1-open' | 'p1-required';
  acquisitionEnabled: boolean;
  message: string;
  connected: boolean;
  account: AccountInfo | null;
  browserStatus: string;
}

export interface DesktopContext {
  account: AccountInfo | null;
  conversations: ConversationInfo[];
  archivedConversations: ArchiveConversationRow[];
  collector: CollectorSnapshot;
  repair: { running: boolean; lastResult: RepairConversationResult | null };
  exporting: boolean;
}

export interface DesktopMediaSource {
  url: string;
  fileVersion: string;
  mime: string;
  actualFormat: string;
  family: string;
  evidence: BrowserMediaEvidence;
}

export type DesktopAttachmentRow = Omit<ArchiveAttachmentRow, 'localPath'>;

export interface DesktopArchiveApi {
  getState(): Promise<DesktopAppState>;
  getContext(): Promise<DesktopContext>;
  connect(): Promise<DesktopAppState>;
  refreshContext(): Promise<DesktopContext>;
  startCapture(input: { conversationId: string; resume?: boolean; maxPages?: number; stopAfterPages?: number }): Promise<CollectorSnapshot>;
  stopCapture(): Promise<CollectorSnapshot>;
  getCollector(): Promise<CollectorSnapshot>;
  repairConversation(input: { accountId: string; conversationId: string; maxPages?: number }): Promise<RepairConversationResult>;
  cancelRepair(): Promise<void>;
  getMessages(input: { accountId: string; conversationId: string; query?: string; limit?: number; offset?: number }): Promise<ArchiveMessageRow[]>;
  getAttachments(input: { accountId: string; conversationId: string }): Promise<DesktopAttachmentRow[]>;
  getMediaUrl(input: { attachmentId: string }): Promise<DesktopMediaSource | null>;
  recordMediaEvidence(input: { attachmentId: string; fileVersion: string; event: BrowserMediaEvidenceEvent }): Promise<{ recorded: boolean; evidence: BrowserMediaEvidence }>;
  exportConversation(input: { accountId: string; conversationId: string }): Promise<{ cancelled: true } | { cancelled: false; outputPath: string; complete: boolean; historyComplete: boolean; fileCount: number; mediaCount: number; report: Record<string, unknown> }>;
  retryAttachment(input: { attachmentId: string }): Promise<boolean>;
  onEvent(listener: (context: DesktopContext) => void): () => void;
}
