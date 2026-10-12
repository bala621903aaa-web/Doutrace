import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { AccountInfo, CapturedMessage, ConversationInfo, HistoryPage, InternalMediaAssetDescription, InternalMessagePayload, NormalizedMessage } from './contracts.js';
import type { CollectorCursorCommitEvidence, CollectorCursorRequestEvidence, StoredCollectorCursorEvidence } from './collector-evidence.js';

type SqliteRow = Record<string, unknown>;
interface SqliteStatement {
  run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T extends SqliteRow = SqliteRow>(...parameters: unknown[]): T | undefined;
  all<T extends SqliteRow = SqliteRow>(...parameters: unknown[]): T[];
}
interface SqliteDatabase {
  pragma(statement: string, options?: { simple?: boolean }): unknown;
  exec(statement: string): void;
  prepare(statement: string): SqliteStatement;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase;

export type RunState = 'running' | 'complete' | 'partial' | 'stopped' | 'interrupted' | 'error';

export interface ArchiveRun {
  runId: string;
  accountId: string;
  conversationId: string;
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  pages: number;
  messages: number;
  nextCursor: string | null;
  hasMore: boolean | null;
}

export interface CheckpointRecord {
  accountId: string;
  conversationId: string;
  runId: string | null;
  nextCursor: string | null;
  hasMore: boolean | null;
  state: RunState;
  lastMessageId: string | null;
  lastSequence: string | null;
  updatedAt: string;
}

export interface ArchiveConversationRow extends ConversationInfo {
  accountId: string;
  messageCount: number;
  latestSentAtMs: number | null;
  updatedAt: string;
}

export interface ArchiveMessageRow extends NormalizedMessage {
  messagePk: string;
  capturedAt: string;
}

export interface ArchiveAttachmentRow {
  id: string;
  messagePk: string;
  kind: string;
  quality: string;
  status: 'pending' | 'saved' | 'failed' | 'unavailable';
  attempts: number;
  mime: string | null;
  extension: string | null;
  localPath: string | null;
  error: string | null;
  size: number | null;
  assetState: 'current' | 'legacy' | 'superseded';
  replacedBy: string | null;
  validationStatus: 'unverified' | 'signature-valid' | 'browser-verified' | 'invalid' | 'role-ambiguous' | 'role-mismatch';
  actualFormat: string | null;
  canRetry: boolean;
  updatedAt: string;
}

export interface BrowserMediaEvidence {
  imageDecoded: { recordedAt: string; naturalWidth: number; naturalHeight: number } | null;
  imageError: { recordedAt: string; errorCode: number } | null;
  audioMetadata: { recordedAt: string; durationSeconds: number } | null;
  audioPlayback: { recordedAt: string; advancedSeconds: number } | null;
  audioEnded: { recordedAt: string } | null;
  audioError: { recordedAt: string; errorCode: number } | null;
}

export type BrowserMediaEvidenceEvent =
  | { type: 'image-decoded'; naturalWidth: number; naturalHeight: number }
  | { type: 'image-error'; errorCode: number }
  | { type: 'audio-metadata'; durationSeconds: number }
  | { type: 'audio-playback'; advancedSeconds: number }
  | { type: 'audio-ended' }
  | { type: 'audio-error'; errorCode: number };

export interface AttachmentMediaContext {
  id: string;
  localPath: string;
  size: number | null;
  status: ArchiveAttachmentRow['status'];
  assetState: ArchiveAttachmentRow['assetState'];
  expectedRole: InternalMediaAssetDescription['role'] | 'legacy';
}

export interface InternalAttachmentRecord extends ArchiveAttachmentRow {
  accountId: string;
  conversationId: string;
  resourceKey: string;
  resourceJson: string;
}

export interface RepairSnapshot {
  messageCount: number;
  messageIdFingerprint: string;
  checkpointFingerprint: string;
  runFingerprint: string;
  targetIds: string[];
  contentStatusCounts: Record<NonNullable<NormalizedMessage['contentStatus']>, number>;
  sourcePayloadMissing: number;
  incompleteMessageCount: number;
}

export interface ArchiveExportBundle {
  account: AccountInfo | null;
  conversation: ArchiveConversationRow | null;
  messages: ArchiveMessageRow[];
  segments: Array<{ messagePk: string; ordinal: number; kind: string; text: string | null; assetId: string | null; label: string | null; source: string | null }>;
  references: Array<{ messagePk: string; targetMessageId: string | null; status: string; snapshotJson: string | null }>;
  attachments: ArchiveAttachmentRow[];
  attachmentRoles: Record<string, InternalMediaAssetDescription['role'] | 'legacy'>;
  runs: ArchiveRun[];
  checkpoint: CheckpointRecord | null;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  display_name TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  participant_ids_json TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, conversation_id),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  message_pk TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform_message_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  sent_at_ms INTEGER,
  sent_at_raw TEXT,
  sent_at_source TEXT NOT NULL,
  sent_at_precision TEXT NOT NULL,
  sequence_index TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_payload_ref TEXT,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, conversation_id) ON DELETE CASCADE,
  UNIQUE (account_id, conversation_id, platform_message_id)
);
CREATE INDEX IF NOT EXISTS messages_conversation_order ON messages(account_id, conversation_id, sent_at_ms, sequence_index, message_pk);
CREATE TABLE IF NOT EXISTS content_segments (
  message_pk TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  asset_id TEXT,
  label TEXT,
  source TEXT,
  PRIMARY KEY (message_pk, ordinal),
  FOREIGN KEY (message_pk) REFERENCES messages(message_pk) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS message_references (
  message_pk TEXT PRIMARY KEY,
  target_message_id TEXT,
  status TEXT NOT NULL,
  snapshot_json TEXT,
  FOREIGN KEY (message_pk) REFERENCES messages(message_pk) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  message_pk TEXT NOT NULL,
  kind TEXT NOT NULL,
  quality TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  extension TEXT,
  local_path TEXT,
  error TEXT,
  size INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (message_pk) REFERENCES messages(message_pk) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  reason TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  next_cursor TEXT,
  has_more INTEGER,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, conversation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS checkpoints (
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  next_cursor TEXT,
  has_more INTEGER,
  state TEXT NOT NULL,
  last_message_id TEXT,
  last_sequence TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, conversation_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, conversation_id) ON DELETE CASCADE
);
`;

const CURRENT_SCHEMA_VERSION = 5;
const MAX_INTERNAL_PAYLOAD_BYTES = 1024 * 1024;
const CONTENT_STATUS_RANK: Record<NonNullable<NormalizedMessage['contentStatus']>, number> = {
  'legacy-missing': 0, unknown: 1, partial: 2, parsed: 3
};

function checkedInternalPayload(input?: InternalMessagePayload): InternalMessagePayload {
  if (!input) return { payloadVersion: 1, wireMessageType: null, aweType: null, contentJson: null, payloadStatus: 'legacy-missing' };
  if (input.payloadVersion !== 1) throw new Error('message-payload-version-unsupported');
  if (input.wireMessageType !== null && (!Number.isSafeInteger(input.wireMessageType) || input.wireMessageType < 0)) {
    throw new Error('message-payload-wire-type-invalid');
  }
  if (input.aweType !== null && typeof input.aweType !== 'string' && (typeof input.aweType !== 'number' || !Number.isFinite(input.aweType))) {
    throw new Error('message-payload-awe-type-invalid');
  }
  if (!['present', 'legacy-missing', 'invalid'].includes(input.payloadStatus)) throw new Error('message-payload-status-invalid');
  if (input.payloadStatus === 'legacy-missing' && (input.contentJson !== null || input.wireMessageType !== null || input.aweType !== null)) {
    throw new Error('message-payload-legacy-shape-invalid');
  }
  if (input.contentJson !== null) {
    if (Buffer.byteLength(input.contentJson, 'utf8') > MAX_INTERNAL_PAYLOAD_BYTES) throw new Error('message-payload-too-large');
    try { JSON.parse(input.contentJson); } catch { throw new Error('message-payload-json-invalid'); }
  }
  if (input.payloadStatus === 'present' && input.contentJson === null) throw new Error('message-payload-content-missing');
  return input;
}

function internalPayloadFromRow(row: SqliteRow | undefined): InternalMessagePayload | null {
  if (!row) return null;
  let aweType: string | number | null = null;
  if (row.awe_type !== null && row.awe_type !== undefined) {
    const raw = String(row.awe_type);
    try { aweType = JSON.parse(raw) as string | number; } catch { aweType = raw; }
  }
  return {
    payloadVersion: Number(row.payload_version) as 1,
    wireMessageType: row.wire_message_type === null || row.wire_message_type === undefined ? null : Number(row.wire_message_type),
    aweType,
    contentJson: row.content_json === null || row.content_json === undefined ? null : String(row.content_json),
    payloadStatus: String(row.payload_status) as InternalMessagePayload['payloadStatus']
  };
}

function contentStatusFor(message: NormalizedMessage, payload: InternalMessagePayload): NonNullable<NormalizedMessage['contentStatus']> {
  if (message.contentStatus) return message.contentStatus;
  if (payload.payloadStatus === 'legacy-missing') return 'legacy-missing';
  return payload.payloadStatus === 'invalid' ? 'partial' : 'unknown';
}

function contentStatusReasonFor(message: NormalizedMessage, payload: InternalMessagePayload): string | null {
  if (message.contentStatusReason) return message.contentStatusReason;
  if (message.contentStatus === 'parsed') return null;
  if (payload.payloadStatus === 'legacy-missing') return 'legacy-payload-unavailable';
  if (payload.payloadStatus === 'invalid') return 'payload-invalid';
  return 'content-not-interpreted';
}

function mediaCategory(asset: InternalMediaAssetDescription): string {
  if (asset.role === 'audio') return 'audio';
  if (asset.role === 'video') return 'video';
  return 'image';
}

function stableAttachmentId(messagePk: string, resourceKey: string) {
  return `att-${createHash('sha256').update(`${messagePk}\0${resourceKey}`).digest('hex').slice(0, 32)}`;
}

function legacyPrimaryAttachmentId(messagePk: string) {
  return `att-${createHash('sha256').update(`${messagePk}\0${0}`).digest('hex').slice(0, 32)}`;
}

function legacyFormatMatches(asset: InternalMediaAssetDescription, row: SqliteRow): boolean {
  if (String(row.status) !== 'saved' || !row.mime) return false;
  const mime = String(row.mime).toLowerCase();
  if (['image', 'poster', 'emoji'].includes(asset.role)) return mime.startsWith('image/');
  if (asset.role === 'audio') return ['audio/aac', 'audio/mpeg', 'audio/wav', 'audio/ogg'].includes(mime);
  return false;
}

function attachmentRow(row: SqliteRow): ArchiveAttachmentRow {
  const descriptor = parseJson<{ candidates?: unknown[] }>(row.resource_json, {});
  return {
    id: String(row.attachment_id), messagePk: String(row.message_pk), kind: String(row.kind), quality: String(row.quality), status: String(row.status) as ArchiveAttachmentRow['status'],
    attempts: Number(row.attempts), mime: row.mime ? String(row.mime) : null, extension: row.extension ? String(row.extension) : null,
    localPath: row.local_path ? String(row.local_path) : null, error: row.error ? String(row.error) : null,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    assetState: String(row.asset_state ?? 'legacy') as ArchiveAttachmentRow['assetState'],
    replacedBy: row.replaced_by ? String(row.replaced_by) : null,
    validationStatus: String(row.validation_status ?? 'unverified') as ArchiveAttachmentRow['validationStatus'],
    actualFormat: row.actual_format ? String(row.actual_format) : null,
    canRetry: String(row.asset_state ?? 'legacy') === 'current' && String(row.status) !== 'saved' &&
      Array.isArray(descriptor.candidates) && descriptor.candidates.length > 0,
    updatedAt: String(row.updated_at)
  };
}

function internalAttachmentRow(row: SqliteRow): InternalAttachmentRecord | null {
  if (typeof row.resource_key !== 'string' || typeof row.resource_json !== 'string') return null;
  return {
    ...attachmentRow(row), accountId: String(row.account_id), conversationId: String(row.conversation_id),
    resourceKey: row.resource_key, resourceJson: row.resource_json
  };
}

function boolToInt(value: boolean | null) {
  return value === null ? null : value ? 1 : 0;
}

function intToBool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Number(value) === 1;
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function messagePrimaryKey(message: Pick<NormalizedMessage, 'accountId' | 'conversationId' | 'platformMessageId' | 'sequence' | 'text'>) {
  const stable = message.platformMessageId
    ? `${message.accountId}\0${message.conversationId}\0${message.platformMessageId}`
    : `${message.accountId}\0${message.conversationId}\0${message.sequence ?? ''}\0${message.text}`;
  return `msg-${createHash('sha256').update(stable).digest('hex')}`;
}

function rowToRun(row: SqliteRow): ArchiveRun {
  return {
    runId: String(row.run_id), accountId: String(row.account_id), conversationId: String(row.conversation_id),
    state: String(row.state) as RunState, startedAt: String(row.started_at), finishedAt: row.finished_at ? String(row.finished_at) : null,
    reason: row.reason ? String(row.reason) : null, pages: Number(row.pages), messages: Number(row.messages),
    nextCursor: row.next_cursor === null || row.next_cursor === undefined ? null : String(row.next_cursor), hasMore: intToBool(row.has_more)
  };
}

function rowToCheckpoint(row: SqliteRow | undefined): CheckpointRecord | null {
  if (!row) return null;
  return {
    accountId: String(row.account_id), conversationId: String(row.conversation_id), runId: row.run_id ? String(row.run_id) : null,
    nextCursor: row.next_cursor === null || row.next_cursor === undefined ? null : String(row.next_cursor), hasMore: intToBool(row.has_more),
    state: String(row.state) as RunState, lastMessageId: row.last_message_id ? String(row.last_message_id) : null,
    lastSequence: row.last_sequence ? String(row.last_sequence) : null, updatedAt: String(row.updated_at)
  };
}

function rowToMessage(row: SqliteRow): ArchiveMessageRow {
  return {
    messagePk: String(row.message_pk), accountId: String(row.account_id), conversationId: String(row.conversation_id),
    platformMessageId: row.platform_message_id ? String(row.platform_message_id) : undefined, senderId: row.sender_id ? String(row.sender_id) : undefined,
    senderName: row.sender_name ? String(row.sender_name) : undefined, sentAtMs: row.sent_at_ms === null || row.sent_at_ms === undefined ? null : Number(row.sent_at_ms),
    sentAtRaw: row.sent_at_raw === null || row.sent_at_raw === undefined ? undefined : String(row.sent_at_raw), sentAtSource: String(row.sent_at_source),
    sentAtPrecision: String(row.sent_at_precision) as NormalizedMessage['sentAtPrecision'], sequence: row.sequence_index ? String(row.sequence_index) : undefined,
    kind: String(row.kind) as NormalizedMessage['kind'], contentStatus: String(row.content_status) as NonNullable<NormalizedMessage['contentStatus']>,
    contentStatusReason: row.content_status_reason ? String(row.content_status_reason) : undefined,
    text: String(row.text ?? ''), segments: [], replyToPlatformMessageId: undefined,
    attachmentCandidates: [], rawPayloadRef: row.raw_payload_ref ? String(row.raw_payload_ref) : undefined, capturedAt: String(row.captured_at)
  };
}

export class ArchiveDatabase {
  private readonly db: SqliteDatabase;

  constructor(readonly path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    try {
      this.db.exec(SCHEMA);
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate() {
    const version = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('archive-schema-version-invalid');
    if (version > CURRENT_SCHEMA_VERSION) throw new Error('archive-schema-version-newer-than-app');

    const requireColumns = (table: string, required: string[]) => {
      const columns = new Set((this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name));
      for (const column of required) if (!columns.has(column)) throw new Error(`archive-schema-v0-invalid:${table}.${column}`);
    };
    if (version === 0) {
      requireColumns('messages', ['message_pk', 'account_id', 'conversation_id', 'platform_message_id', 'text', 'captured_at']);
      requireColumns('attachments', ['attachment_id', 'message_pk', 'status', 'updated_at']);
      requireColumns('checkpoints', ['account_id', 'conversation_id', 'next_cursor', 'last_message_id', 'last_sequence']);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE message_payloads (
            message_pk TEXT PRIMARY KEY,
            payload_version INTEGER NOT NULL,
            wire_message_type INTEGER,
            awe_type TEXT,
            content_json TEXT,
            payload_status TEXT NOT NULL CHECK (payload_status IN ('present', 'legacy-missing', 'invalid')),
            updated_at TEXT NOT NULL,
            FOREIGN KEY (message_pk) REFERENCES messages(message_pk) ON DELETE CASCADE
          );
          CREATE INDEX message_payloads_status ON message_payloads(payload_status, updated_at);
          INSERT INTO message_payloads(message_pk, payload_version, wire_message_type, awe_type, content_json, payload_status, updated_at)
            SELECT message_pk, 1, NULL, NULL, NULL, 'legacy-missing', captured_at FROM messages;
        `);
        this.db.pragma('user_version = 1');
      })();
    }

    const migratedVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (migratedVersion === 1) {
      requireColumns('messages', ['message_pk', 'text', 'captured_at']);
      requireColumns('message_payloads', ['message_pk', 'payload_status']);
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE messages ADD COLUMN content_status TEXT NOT NULL DEFAULT 'legacy-missing'
            CHECK (content_status IN ('parsed', 'partial', 'unknown', 'legacy-missing'));
          ALTER TABLE messages ADD COLUMN content_status_reason TEXT;
          UPDATE messages SET
            content_status = COALESCE((SELECT CASE payload_status WHEN 'legacy-missing' THEN 'legacy-missing' WHEN 'invalid' THEN 'partial' ELSE 'unknown' END
              FROM message_payloads WHERE message_payloads.message_pk = messages.message_pk), 'legacy-missing'),
            content_status_reason = COALESCE((SELECT CASE payload_status WHEN 'legacy-missing' THEN 'legacy-payload-unavailable' WHEN 'invalid' THEN 'payload-invalid' ELSE 'content-not-interpreted' END
              FROM message_payloads WHERE message_payloads.message_pk = messages.message_pk), 'legacy-payload-unavailable');
        `);
        this.db.pragma('user_version = 2');
      })();
    }
    const attachmentVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (attachmentVersion === 2) {
      requireColumns('attachments', ['attachment_id', 'message_pk', 'kind', 'status', 'mime', 'local_path', 'updated_at']);
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE attachments ADD COLUMN resource_key TEXT;
          ALTER TABLE attachments ADD COLUMN resource_json TEXT;
          ALTER TABLE attachments ADD COLUMN asset_state TEXT NOT NULL DEFAULT 'legacy'
            CHECK (asset_state IN ('current', 'legacy', 'superseded'));
          ALTER TABLE attachments ADD COLUMN replaced_by TEXT;
          ALTER TABLE attachments ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'unverified'
            CHECK (validation_status IN ('unverified', 'signature-valid', 'browser-verified', 'invalid', 'role-ambiguous', 'role-mismatch'));
          ALTER TABLE attachments ADD COLUMN actual_format TEXT;
          CREATE UNIQUE INDEX attachments_message_resource ON attachments(message_pk, resource_key) WHERE resource_key IS NOT NULL;
        `);
        this.db.pragma('user_version = 3');
      })();
    }
    const evidenceVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (evidenceVersion === 3) {
      requireColumns('attachments', ['attachment_id', 'message_pk', 'status', 'local_path', 'asset_state', 'validation_status']);
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE attachment_browser_evidence (
            attachment_id TEXT NOT NULL,
            file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'),
            stage TEXT NOT NULL CHECK (stage IN ('image-decoded', 'image-error', 'audio-metadata', 'audio-playback', 'audio-ended', 'audio-error')),
            result_json TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY (attachment_id, file_sha256, stage),
            FOREIGN KEY (attachment_id) REFERENCES attachments(attachment_id) ON DELETE CASCADE
          );
          CREATE INDEX attachment_browser_evidence_version ON attachment_browser_evidence(attachment_id, file_sha256);
        `);
        this.db.pragma('user_version = 4');
      })();
    }
    const collectorEvidenceVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (collectorEvidenceVersion === 4) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE collector_cursor_evidence (
            evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
            process_fingerprint TEXT NOT NULL CHECK (length(process_fingerprint) = 64 AND process_fingerprint NOT GLOB '*[^0-9a-f]*'),
            run_fingerprint TEXT NOT NULL CHECK (length(run_fingerprint) = 64 AND run_fingerprint NOT GLOB '*[^0-9a-f]*'),
            scope_fingerprint TEXT NOT NULL CHECK (length(scope_fingerprint) = 64 AND scope_fingerprint NOT GLOB '*[^0-9a-f]*'),
            phase TEXT NOT NULL CHECK (phase IN ('requested', 'committed')),
            page_index INTEGER NOT NULL CHECK (page_index BETWEEN 1 AND 10000),
            resume_requested INTEGER NOT NULL CHECK (resume_requested IN (0, 1)),
            checkpoint_state TEXT,
            checkpoint_cursor_present INTEGER NOT NULL CHECK (checkpoint_cursor_present IN (0, 1)),
            checkpoint_cursor_fingerprint TEXT NOT NULL CHECK (length(checkpoint_cursor_fingerprint) = 64 AND checkpoint_cursor_fingerprint NOT GLOB '*[^0-9a-f]*'),
            input_cursor_present INTEGER NOT NULL CHECK (input_cursor_present IN (0, 1)),
            input_cursor_fingerprint TEXT NOT NULL CHECK (length(input_cursor_fingerprint) = 64 AND input_cursor_fingerprint NOT GLOB '*[^0-9a-f]*'),
            input_matches_checkpoint INTEGER NOT NULL CHECK (input_matches_checkpoint IN (0, 1)),
            output_cursor_present INTEGER CHECK (output_cursor_present IN (0, 1)),
            output_cursor_fingerprint TEXT CHECK (output_cursor_fingerprint IS NULL OR (length(output_cursor_fingerprint) = 64 AND output_cursor_fingerprint NOT GLOB '*[^0-9a-f]*')),
            page_message_count INTEGER CHECK (page_message_count IS NULL OR page_message_count >= 0),
            new_message_count INTEGER CHECK (new_message_count IS NULL OR new_message_count >= 0),
            unique_platform_message_id_count INTEGER CHECK (unique_platform_message_id_count IS NULL OR unique_platform_message_id_count >= 0),
            identity_validated INTEGER CHECK (identity_validated IN (0, 1)),
            has_more INTEGER CHECK (has_more IN (0, 1)),
            checkpoint_committed INTEGER NOT NULL CHECK (checkpoint_committed IN (0, 1)),
            recorded_at TEXT NOT NULL
          );
          CREATE INDEX collector_cursor_evidence_scope_run ON collector_cursor_evidence(scope_fingerprint, run_fingerprint, page_index);
        `);
        this.db.pragma('user_version = 5');
      })();
    }
    const finalVersion = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (finalVersion !== CURRENT_SCHEMA_VERSION) throw new Error('archive-schema-migration-incomplete');
  }

  static async open(path: string) {
    await mkdir(dirname(path), { recursive: true });
    return new ArchiveDatabase(path);
  }

  close() { this.db.close(); }

  private writeCollectorCursorEvidence(evidence: CollectorCursorRequestEvidence | CollectorCursorCommitEvidence, phase: 'requested' | 'committed') {
    const committed = phase === 'committed' ? evidence as CollectorCursorCommitEvidence : null;
    this.db.prepare(`INSERT INTO collector_cursor_evidence(
      process_fingerprint, run_fingerprint, scope_fingerprint, phase, page_index, resume_requested, checkpoint_state,
      checkpoint_cursor_present, checkpoint_cursor_fingerprint, input_cursor_present, input_cursor_fingerprint,
      input_matches_checkpoint, output_cursor_present, output_cursor_fingerprint, page_message_count, new_message_count,
      unique_platform_message_id_count, identity_validated, has_more, checkpoint_committed, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evidence.processFingerprint, evidence.runFingerprint, evidence.scopeFingerprint, phase, evidence.pageIndex,
        evidence.resumeRequested ? 1 : 0, evidence.checkpointState, evidence.checkpointCursorPresent ? 1 : 0,
        evidence.checkpointCursorFingerprint, evidence.inputCursorPresent ? 1 : 0, evidence.inputCursorFingerprint,
        evidence.inputMatchesCheckpoint ? 1 : 0, committed ? (committed.outputCursorPresent ? 1 : 0) : null,
        committed?.outputCursorFingerprint ?? null, committed?.pageMessageCount ?? null, committed?.newMessageCount ?? null,
        committed?.uniquePlatformMessageIdCount ?? null, committed ? 1 : null,
        committed?.hasMore === null || committed?.hasMore === undefined ? null : committed.hasMore ? 1 : 0,
        committed ? 1 : 0, new Date().toISOString());
    this.db.prepare(`DELETE FROM collector_cursor_evidence WHERE evidence_id NOT IN
      (SELECT evidence_id FROM collector_cursor_evidence ORDER BY evidence_id DESC LIMIT 128)`).run();
  }

  recordCollectorCursorRequest(evidence: CollectorCursorRequestEvidence) {
    this.db.transaction(() => this.writeCollectorCursorEvidence(evidence, 'requested'))();
  }

  listCollectorCursorEvidence(scopeFingerprint?: string): StoredCollectorCursorEvidence[] {
    const rows = scopeFingerprint
      ? this.db.prepare('SELECT * FROM collector_cursor_evidence WHERE scope_fingerprint=? ORDER BY evidence_id').all(scopeFingerprint)
      : this.db.prepare('SELECT * FROM collector_cursor_evidence ORDER BY evidence_id').all();
    return rows.map(row => ({
      processFingerprint: String(row.process_fingerprint), runFingerprint: String(row.run_fingerprint), scopeFingerprint: String(row.scope_fingerprint),
      phase: String(row.phase) as StoredCollectorCursorEvidence['phase'], pageIndex: Number(row.page_index),
      resumeRequested: Number(row.resume_requested) === 1, checkpointState: row.checkpoint_state === null ? null : String(row.checkpoint_state),
      checkpointCursorPresent: Number(row.checkpoint_cursor_present) === 1, checkpointCursorFingerprint: String(row.checkpoint_cursor_fingerprint),
      inputCursorPresent: Number(row.input_cursor_present) === 1, inputCursorFingerprint: String(row.input_cursor_fingerprint),
      inputMatchesCheckpoint: Number(row.input_matches_checkpoint) === 1,
      outputCursorPresent: row.output_cursor_present === null ? null : Number(row.output_cursor_present) === 1,
      outputCursorFingerprint: row.output_cursor_fingerprint === null ? null : String(row.output_cursor_fingerprint),
      pageMessageCount: row.page_message_count === null ? null : Number(row.page_message_count),
      newMessageCount: row.new_message_count === null ? null : Number(row.new_message_count),
      uniquePlatformMessageIdCount: row.unique_platform_message_id_count === null ? null : Number(row.unique_platform_message_id_count),
      identityValidated: row.identity_validated === null ? null : Number(row.identity_validated) === 1,
      hasMore: row.has_more === null ? null : Number(row.has_more) === 1,
      checkpointCommitted: Number(row.checkpoint_committed) === 1, recordedAt: String(row.recorded_at)
    }));
  }

  recoverInterruptedRuns() {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE runs SET state = 'interrupted', reason = 'interrupted', finished_at = ? WHERE state = 'running'").run(now);
    this.db.prepare("UPDATE checkpoints SET state = 'interrupted', updated_at = ? WHERE state = 'running'").run(now);
  }

  upsertAccount(account: AccountInfo) {
    this.db.prepare(`INSERT INTO accounts(account_id, display_name, source, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET display_name=excluded.display_name, source=excluded.source, updated_at=excluded.updated_at`).run(
      account.accountId, account.displayName ?? null, account.source, new Date().toISOString()
    );
  }

  upsertConversation(accountId: string, conversation: ConversationInfo) {
    this.db.prepare(`INSERT INTO conversations(account_id, conversation_id, title, participant_ids_json, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id) DO UPDATE SET title=excluded.title, participant_ids_json=excluded.participant_ids_json, source=excluded.source, updated_at=excluded.updated_at`).run(
      accountId, conversation.conversationId, conversation.title || conversation.conversationId, json(conversation.participantIds), conversation.source, new Date().toISOString()
    );
  }

  private persistMediaAssets(message: NormalizedMessage & { internalMediaAssets?: InternalMediaAssetDescription[] }, messagePk: string, now: string) {
    const assets = message.internalMediaAssets ?? [];
    const findCurrent = this.db.prepare('SELECT attachment_id, status, resource_json FROM attachments WHERE message_pk = ? AND resource_key = ?');
    const findLegacyPrimary = this.db.prepare('SELECT * FROM attachments WHERE attachment_id = ? AND message_pk = ? AND resource_key IS NULL AND asset_state = \'legacy\'');
    const supersedeLegacy = this.db.prepare(`UPDATE attachments SET asset_state='superseded', replaced_by=?, updated_at=?
      WHERE attachment_id=? AND message_pk=? AND resource_key IS NULL AND asset_state='legacy'`);
    const upsert = this.db.prepare(`INSERT INTO attachments(
        attachment_id, message_pk, kind, quality, status, attempts, mime, extension, local_path, error, size, updated_at,
        resource_key, resource_json, asset_state, replaced_by, validation_status, actual_format
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, NULL, ?, ?, ?, 'current', NULL, 'unverified', NULL)
      ON CONFLICT(attachment_id) DO UPDATE SET kind=excluded.kind, quality=excluded.quality,
        status=CASE WHEN ?=1 THEN attachments.status ELSE excluded.status END,
        attempts=CASE WHEN ?=1 THEN attachments.attempts ELSE 0 END,
        mime=CASE WHEN ?=1 THEN attachments.mime ELSE NULL END,
        extension=CASE WHEN ?=1 THEN attachments.extension ELSE NULL END,
        local_path=CASE WHEN ?=1 THEN attachments.local_path ELSE NULL END,
        size=CASE WHEN ?=1 THEN attachments.size ELSE NULL END,
        error=CASE WHEN ?=1 THEN attachments.error ELSE excluded.error END,
        resource_key=excluded.resource_key, resource_json=excluded.resource_json, asset_state='current', replaced_by=NULL,
        validation_status=CASE WHEN ?=1 THEN attachments.validation_status ELSE 'unverified' END,
        actual_format=CASE WHEN ?=1 THEN attachments.actual_format ELSE NULL END, updated_at=excluded.updated_at`);

    for (const [index, asset] of assets.entries()) {
      if (!asset.resourceKey || asset.resourceKey.length > 128 || !/^[\w.:-]+$/.test(asset.resourceKey)) throw new Error('attachment-resource-key-invalid');
      if (!['image', 'audio', 'video', 'poster', 'emoji'].includes(asset.role)) throw new Error('attachment-resource-role-invalid');
      if (!Array.isArray(asset.candidates) || asset.candidates.length > 20) throw new Error('attachment-resource-candidates-invalid');
      for (const candidate of asset.candidates) {
        let url: URL;
        try { url = new URL(candidate.url); } catch { throw new Error('attachment-resource-url-invalid'); }
        if (url.protocol !== 'https:' || url.username || url.password || candidate.sourcePath.length > 256 ||
            !['original', 'large', 'preview', 'unknown'].includes(candidate.quality)) throw new Error('attachment-resource-url-invalid');
      }
      if (asset.skey !== null && asset.skey.length > 256) throw new Error('attachment-resource-key-invalid');
      const resourceJson = JSON.stringify(asset);
      if (Buffer.byteLength(resourceJson, 'utf8') > 256 * 1024) throw new Error('attachment-resource-too-large');
      const current = findCurrent.get(messagePk, asset.resourceKey);
      let attachmentId = current ? String(current.attachment_id) : stableAttachmentId(messagePk, asset.resourceKey);
      let preserveSaved = Boolean(current && current.status === 'saved' && current.resource_json === resourceJson);
      let legacy: SqliteRow | undefined;
      if (!current && index === 0) {
        legacy = findLegacyPrimary.get(legacyPrimaryAttachmentId(messagePk), messagePk);
        if (legacy && legacyFormatMatches(asset, legacy)) {
          attachmentId = String(legacy.attachment_id);
          preserveSaved = true;
        } else if (legacy) {
          supersedeLegacy.run(attachmentId, now, legacy.attachment_id, messagePk);
        }
      }
      const kind = mediaCategory(asset);
      const quality = asset.candidates.some(candidate => candidate.quality === 'original') ? 'original'
        : asset.candidates.some(candidate => candidate.quality === 'large') ? 'large'
          : asset.candidates.some(candidate => candidate.quality === 'preview') ? 'preview' : 'unknown';
      const status = asset.candidates.length ? 'pending' : 'unavailable';
      const error = asset.candidates.length ? null : 'resource-source-missing';
      upsert.run(attachmentId, messagePk, kind, quality, status, error, now, asset.resourceKey, resourceJson,
        ...Array.from({ length: 9 }, () => preserveSaved ? 1 : 0));
    }
  }

  startRun(account: AccountInfo, conversation: ConversationInfo, runId: string = randomUUID()) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.upsertAccount(account);
      this.upsertConversation(account.accountId, conversation);
      this.db.prepare(`INSERT INTO runs(run_id, account_id, conversation_id, state, started_at, finished_at, reason, pages, messages, next_cursor, has_more)
        VALUES (?, ?, ?, 'running', ?, NULL, NULL, 0, 0, NULL, NULL)`).run(runId, account.accountId, conversation.conversationId, now);
    })();
    return runId;
  }

  savePage(input: { runId: string; account: AccountInfo; conversation: ConversationInfo; page: HistoryPage; state: RunState; reason?: string | null;
    cursorEvidence?: { request: CollectorCursorRequestEvidence; commit: (newMessageCount: number) => CollectorCursorCommitEvidence } }) {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      if (input.page.accountId !== input.account.accountId || input.page.conversationId !== input.conversation.conversationId) throw new Error('page-identity-mismatch');
      const run = this.getRun(input.runId);
      if (!run || run.accountId !== input.account.accountId || run.conversationId !== input.conversation.conversationId) throw new Error('run-identity-mismatch');
      this.upsertAccount(input.account);
      this.upsertConversation(input.account.accountId, input.conversation);
      const insertMessage = this.db.prepare(`INSERT INTO messages(message_pk, account_id, conversation_id, platform_message_id, sender_id, sender_name, sent_at_ms, sent_at_raw, sent_at_source, sent_at_precision, sequence_index, kind, text, raw_payload_ref, captured_at, content_status, content_status_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET sender_id=excluded.sender_id, sender_name=excluded.sender_name, sent_at_ms=excluded.sent_at_ms, sent_at_raw=excluded.sent_at_raw, sent_at_source=excluded.sent_at_source, sent_at_precision=excluded.sent_at_precision, sequence_index=excluded.sequence_index,
          kind=CASE WHEN (CASE excluded.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) >= (CASE messages.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) THEN excluded.kind ELSE messages.kind END,
          text=CASE WHEN (CASE excluded.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) >= (CASE messages.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) THEN excluded.text ELSE messages.text END,
          raw_payload_ref=COALESCE(excluded.raw_payload_ref, messages.raw_payload_ref),
          content_status=CASE WHEN (CASE excluded.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) >= (CASE messages.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) THEN excluded.content_status ELSE messages.content_status END,
          content_status_reason=CASE WHEN (CASE excluded.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) >= (CASE messages.content_status WHEN 'parsed' THEN 3 WHEN 'partial' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END) THEN excluded.content_status_reason ELSE messages.content_status_reason END,
          captured_at=excluded.captured_at`);
      const deleteSegments = this.db.prepare('DELETE FROM content_segments WHERE message_pk = ?');
      const insertSegment = this.db.prepare('INSERT INTO content_segments(message_pk, ordinal, kind, text, asset_id, label, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const deleteReference = this.db.prepare('DELETE FROM message_references WHERE message_pk = ?');
      const insertReference = this.db.prepare('INSERT INTO message_references(message_pk, target_message_id, status, snapshot_json) VALUES (?, ?, ?, ?)');
      const upsertPayload = this.db.prepare(`INSERT INTO message_payloads(message_pk, payload_version, wire_message_type, awe_type, content_json, payload_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_pk) DO UPDATE SET payload_version=excluded.payload_version, wire_message_type=excluded.wire_message_type,
          awe_type=excluded.awe_type, content_json=excluded.content_json, payload_status=excluded.payload_status, updated_at=excluded.updated_at
        WHERE message_payloads.payload_status != 'present' AND
          (excluded.payload_status = 'present' OR (message_payloads.payload_status = 'legacy-missing' AND excluded.payload_status = 'invalid'))`);
      const messagesWithKeys: Array<{ message: NormalizedMessage; messagePk: string }> = [];
      let newMessageCount = 0;
      const findExistingMessage = this.db.prepare('SELECT content_status FROM messages WHERE message_pk = ?');
      for (const message of input.page.messages) {
        if (message.accountId !== input.account.accountId || message.conversationId !== input.conversation.conversationId) throw new Error('message-identity-mismatch');
        const messagePk = messagePrimaryKey(message);
        const payload = checkedInternalPayload(message.internalPayload);
        const contentStatus = contentStatusFor(message, payload);
        const contentStatusReason = contentStatusReasonFor(message, payload);
        const existing = findExistingMessage.get(messagePk);
        if (!existing) newMessageCount++;
        const existingStatus = existing ? String(existing.content_status) as NonNullable<NormalizedMessage['contentStatus']> : null;
        const updateContent = existingStatus === null || CONTENT_STATUS_RANK[contentStatus] >= (CONTENT_STATUS_RANK[existingStatus] ?? 0);
        insertMessage.run(messagePk, message.accountId, message.conversationId, message.platformMessageId ?? null, message.senderId ?? null, message.senderName ?? null,
          message.sentAtMs ?? null, message.sentAtRaw === undefined ? null : String(message.sentAtRaw), message.sentAtSource, message.sentAtPrecision,
          message.sequence === undefined ? null : String(message.sequence), message.kind, message.text, message.rawPayloadRef ?? null, now, contentStatus, contentStatusReason);
        if (updateContent) {
          deleteSegments.run(messagePk);
          message.segments.forEach((segment, ordinal) => insertSegment.run(messagePk, ordinal, segment.kind, segment.text ?? null, segment.assetId ?? null, segment.label ?? null, segment.source ?? null));
          deleteReference.run(messagePk);
          if (message.replyToPlatformMessageId || message.replySnapshot) {
            insertReference.run(messagePk, message.replyToPlatformMessageId ?? null, message.replySnapshot?.status ?? 'unresolved', message.replySnapshot ? json(message.replySnapshot) : null);
          }
        }
        upsertPayload.run(messagePk, payload.payloadVersion, payload.wireMessageType, payload.aweType === null ? null : JSON.stringify(payload.aweType), payload.contentJson, payload.payloadStatus, now);
        this.persistMediaAssets(message, messagePk, now);
        messagesWithKeys.push({ message, messagePk });
      }
      const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND conversation_id = ?').get<{ count: number }>(input.account.accountId, input.conversation.conversationId);
      const last = [...input.page.messages].sort((left, right) => {
        if (left.sequence !== undefined && right.sequence !== undefined) {
          const a = BigInt(String(left.sequence)), b = BigInt(String(right.sequence));
          return a < b ? -1 : a > b ? 1 : 0;
        }
        return (left.sentAtMs ?? 0) - (right.sentAtMs ?? 0);
      })[0];
      this.db.prepare(`UPDATE runs SET pages = pages + 1, messages = ?, next_cursor = ?, has_more = ?, state = ?, reason = ?, finished_at = ? WHERE run_id = ?`).run(
        Number(countRow?.count ?? 0), input.page.nextCursor, boolToInt(input.page.hasMore), input.state,
        input.state === 'running' ? null : input.reason ?? (input.state === 'complete' ? 'history_end' : null),
        input.state === 'running' ? null : now, input.runId
      );
      this.db.prepare(`INSERT INTO checkpoints(account_id, conversation_id, run_id, next_cursor, has_more, state, last_message_id, last_sequence, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id) DO UPDATE SET run_id=excluded.run_id, next_cursor=excluded.next_cursor, has_more=excluded.has_more, state=excluded.state, last_message_id=excluded.last_message_id, last_sequence=excluded.last_sequence, updated_at=excluded.updated_at`).run(
        input.account.accountId, input.conversation.conversationId, input.runId, input.page.nextCursor, boolToInt(input.page.hasMore), input.state,
        last?.platformMessageId ?? null, last?.sequence === undefined ? null : String(last.sequence), now
      );
      if (input.cursorEvidence) this.writeCollectorCursorEvidence(input.cursorEvidence.commit(newMessageCount), 'committed');
      return { messageCount: messagesWithKeys.length, newMessageCount, totalMessages: Number(countRow?.count ?? 0) };
    })();
  }

  finishRun(runId: string, state: Exclude<RunState, 'running'>, reason: string) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE runs SET state = ?, reason = ?, finished_at = ? WHERE run_id = ?').run(state, reason, now, runId);
      this.db.prepare('UPDATE checkpoints SET state = ?, updated_at = ? WHERE run_id = ?').run(state, now, runId);
    })();
  }

  getCheckpoint(accountId: string, conversationId: string) {
    return rowToCheckpoint(this.db.prepare('SELECT * FROM checkpoints WHERE account_id = ? AND conversation_id = ?').get(accountId, conversationId));
  }

  getRun(runId: string) {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    return row ? rowToRun(row) : null;
  }

  listRuns(accountId?: string, conversationId?: string) {
    const rows = accountId && conversationId
      ? this.db.prepare('SELECT * FROM runs WHERE account_id = ? AND conversation_id = ? ORDER BY started_at DESC, rowid DESC').all(accountId, conversationId)
      : this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC').all();
    return rows.map(rowToRun);
  }

  listConversations(accountId?: string): ArchiveConversationRow[] {
    const rows = accountId
      ? this.db.prepare(`SELECT c.*, a.account_id AS account_key, COUNT(m.message_pk) AS message_count, MAX(m.sent_at_ms) AS latest_sent_at_ms
        FROM conversations c JOIN accounts a ON a.account_id=c.account_id LEFT JOIN messages m ON m.account_id=c.account_id AND m.conversation_id=c.conversation_id
        WHERE c.account_id = ? GROUP BY c.account_id, c.conversation_id ORDER BY c.updated_at DESC`).all(accountId)
      : this.db.prepare(`SELECT c.*, a.account_id AS account_key, COUNT(m.message_pk) AS message_count, MAX(m.sent_at_ms) AS latest_sent_at_ms
        FROM conversations c JOIN accounts a ON a.account_id=c.account_id LEFT JOIN messages m ON m.account_id=c.account_id AND m.conversation_id=c.conversation_id
        GROUP BY c.account_id, c.conversation_id ORDER BY c.updated_at DESC`).all();
    return rows.map(row => ({
      accountId: String(row.account_id), conversationId: String(row.conversation_id), title: String(row.title),
      participantIds: parseJson<string[]>(row.participant_ids_json, []), source: String(row.source), messageCount: Number(row.message_count),
      latestSentAtMs: row.latest_sent_at_ms === null || row.latest_sent_at_ms === undefined ? null : Number(row.latest_sent_at_ms), updatedAt: String(row.updated_at)
    }));
  }

  listMessages(accountId: string, conversationId: string, query = '', limit = 500, offset = 0): ArchiveMessageRow[] {
    const search = query.trim().toLocaleLowerCase();
    const rows = search
      ? this.db.prepare(`SELECT * FROM messages WHERE account_id = ? AND conversation_id = ? AND (instr(lower(text), ?) > 0 OR instr(lower(COALESCE(sender_name, '')), ?) > 0 OR platform_message_id = ?)
        ORDER BY CASE WHEN sent_at_ms IS NULL THEN 1 ELSE 0 END, sent_at_ms, length(sequence_index), sequence_index, message_pk LIMIT ? OFFSET ?`).all(accountId, conversationId, search, search, search, limit, offset)
      : this.db.prepare(`SELECT * FROM messages WHERE account_id = ? AND conversation_id = ?
        ORDER BY CASE WHEN sent_at_ms IS NULL THEN 1 ELSE 0 END, sent_at_ms, length(sequence_index), sequence_index, message_pk LIMIT ? OFFSET ?`).all(accountId, conversationId, limit, offset);
    const result = rows.map(rowToMessage);
    const segments = this.db.prepare('SELECT * FROM content_segments WHERE message_pk = ? ORDER BY ordinal');
    const reference = this.db.prepare(`SELECT r.*, t.text AS target_text, t.kind AS target_kind, t.sender_id AS target_sender
      FROM message_references r JOIN messages m ON m.message_pk=r.message_pk
      LEFT JOIN messages t ON t.account_id=m.account_id AND t.conversation_id=m.conversation_id AND t.platform_message_id=r.target_message_id
      WHERE r.message_pk = ?`);
    for (const message of result) {
      message.segments = segments.all(message.messagePk).map(row => ({
        kind: String(row.kind) as NormalizedMessage['segments'][number]['kind'], text: row.text === null ? undefined : String(row.text),
        assetId: row.asset_id === null ? undefined : String(row.asset_id), label: row.label === null ? undefined : String(row.label), source: row.source === null ? undefined : String(row.source)
      }));
      const reply = reference.get(message.messagePk);
      if (reply) {
        message.replyToPlatformMessageId = reply.target_message_id ? String(reply.target_message_id) : undefined;
        message.replySnapshot = reply.target_text !== null && reply.target_text !== undefined
          ? { status: 'available', text: String(reply.target_text), kind: String(reply.target_kind) as NormalizedMessage['kind'], senderId: reply.target_sender ? String(reply.target_sender) : undefined }
          : { ...parseJson(reply.snapshot_json, {}), status: 'missing' };
      }
    }
    return result;
  }

  listConversationStatsRows(accountId: string, conversationId: string): Array<Pick<ArchiveMessageRow, 'senderId' | 'senderName' | 'kind' | 'sentAtMs'>> {
    const rows = this.db.prepare(`SELECT sender_id, sender_name, kind, sent_at_ms FROM messages
      WHERE account_id = ? AND conversation_id = ?
      ORDER BY CASE WHEN sent_at_ms IS NULL THEN 1 ELSE 0 END, sent_at_ms, length(sequence_index), sequence_index, message_pk`).all(accountId, conversationId);
    return rows.map(row => {
      const sentAtMs = row.sent_at_ms === null || row.sent_at_ms === undefined
        ? null
        : typeof row.sent_at_ms === 'number'
          ? row.sent_at_ms
          : Number.NaN;
      return {
        senderId: row.sender_id ? String(row.sender_id) : undefined,
        senderName: row.sender_name ? String(row.sender_name) : undefined,
        kind: String(row.kind) as ArchiveMessageRow['kind'],
        sentAtMs
      };
    });
  }

    getRepairSnapshot(accountId: string, conversationId: string): RepairSnapshot {
    const rows = this.db.prepare(`SELECT m.message_pk, m.platform_message_id, m.content_status, p.payload_status
      FROM messages m LEFT JOIN message_payloads p ON p.message_pk=m.message_pk
      WHERE m.account_id=? AND m.conversation_id=? ORDER BY m.message_pk`).all(accountId, conversationId);
    const messageIdFingerprint = createHash('sha256').update(rows.map(row => `${row.platform_message_id ?? `pk:${row.message_pk}`}\0`).join('')).digest('hex');
    const checkpoint = this.db.prepare('SELECT run_id, next_cursor, has_more, state, last_message_id, last_sequence FROM checkpoints WHERE account_id=? AND conversation_id=?').get(accountId, conversationId);
    const checkpointFingerprint = createHash('sha256').update(checkpoint ? JSON.stringify(checkpoint) : 'no-checkpoint').digest('hex');
    const runs = this.db.prepare('SELECT run_id, state, started_at, finished_at, reason, pages, messages, next_cursor, has_more FROM runs WHERE account_id=? AND conversation_id=? ORDER BY run_id').all(accountId, conversationId);
    const runFingerprint = createHash('sha256').update(JSON.stringify(runs)).digest('hex');
    const contentStatusCounts: RepairSnapshot['contentStatusCounts'] = { parsed: 0, partial: 0, unknown: 0, 'legacy-missing': 0 };
    let sourcePayloadMissing = 0;
    let incompleteMessageCount = 0;
    const targetIds: string[] = [];
    for (const row of rows) {
      const status = String(row.content_status) as keyof typeof contentStatusCounts;
      if (Object.hasOwn(contentStatusCounts, status)) contentStatusCounts[status]++;
      if (row.payload_status !== 'present') sourcePayloadMissing++;
      if (status !== 'parsed' || row.payload_status !== 'present') incompleteMessageCount++;
      if (row.platform_message_id !== null && row.platform_message_id !== undefined &&
          (status !== 'parsed' || row.payload_status !== 'present')) targetIds.push(String(row.platform_message_id));
    }
    return { messageCount: rows.length, messageIdFingerprint, checkpointFingerprint, runFingerprint, targetIds, contentStatusCounts, sourcePayloadMissing, incompleteMessageCount };
  }

  repairExistingMessages(input: {
    accountId: string;
    conversationId: string;
    targetIds: readonly string[];
    messages: CapturedMessage[];
  }) {
    const targets = new Set(input.targetIds);
    const matchedIds: string[] = [];
    const improvedIds: string[] = [];
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const find = this.db.prepare(`SELECT message_pk, content_status, kind, text FROM messages
        WHERE account_id=? AND conversation_id=? AND platform_message_id=?`);
      const update = this.db.prepare(`UPDATE messages SET
          kind=CASE WHEN ?=1 THEN ? ELSE kind END,
          text=CASE WHEN ?=1 THEN ? ELSE text END,
          content_status=CASE WHEN ?=1 THEN ? ELSE content_status END,
          content_status_reason=CASE WHEN ?=1 THEN ? ELSE content_status_reason END
        WHERE message_pk=? AND account_id=? AND conversation_id=? AND platform_message_id=?`);
      const deleteSegments = this.db.prepare('DELETE FROM content_segments WHERE message_pk=?');
      const insertSegment = this.db.prepare('INSERT INTO content_segments(message_pk, ordinal, kind, text, asset_id, label, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const upsertReference = this.db.prepare(`INSERT INTO message_references(message_pk, target_message_id, status, snapshot_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(message_pk) DO UPDATE SET target_message_id=excluded.target_message_id, status=excluded.status, snapshot_json=excluded.snapshot_json`);
      const payload = this.db.prepare(`INSERT INTO message_payloads(message_pk, payload_version, wire_message_type, awe_type, content_json, payload_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_pk) DO UPDATE SET payload_version=excluded.payload_version, wire_message_type=excluded.wire_message_type,
          awe_type=excluded.awe_type, content_json=excluded.content_json, payload_status=excluded.payload_status, updated_at=excluded.updated_at
        WHERE message_payloads.payload_status != 'present' AND
          (excluded.payload_status = 'present' OR (message_payloads.payload_status = 'legacy-missing' AND excluded.payload_status = 'invalid'))`);

      for (const message of input.messages) {
        const platformId = message.platformMessageId;
        if (!platformId || !targets.has(platformId)) continue;
        if (message.accountId !== input.accountId || message.conversationId !== input.conversationId) throw new Error('repair-message-identity-mismatch');
        const existing = find.get(input.accountId, input.conversationId, platformId);
        if (!existing) continue;
        const messagePk = String(existing.message_pk);
        const messagePayload = checkedInternalPayload(message.internalPayload);
        const newStatus = contentStatusFor(message, messagePayload);
        const oldStatus = String(existing.content_status) as NonNullable<NormalizedMessage['contentStatus']>;
        const oldRank = CONTENT_STATUS_RANK[oldStatus] ?? 0;
        const newRank = CONTENT_STATUS_RANK[newStatus] ?? 0;
        const improvesStatus = newRank > oldRank;
        const improvesKind = message.kind !== 'unknown' && (existing.kind === 'unknown' || newRank > oldRank);
        const improvesText = !String(existing.text ?? '') && Boolean(message.text);
        const canUpdateStatus = newRank >= oldRank;
        update.run(improvesKind ? 1 : 0, message.kind, improvesText ? 1 : 0, message.text,
          canUpdateStatus ? 1 : 0, newStatus, canUpdateStatus ? 1 : 0, contentStatusReasonFor(message, messagePayload),
          messagePk, input.accountId, input.conversationId, platformId);
        if (canUpdateStatus && message.segments.length) {
          deleteSegments.run(messagePk);
          message.segments.forEach((segment, ordinal) => insertSegment.run(messagePk, ordinal, segment.kind, segment.text ?? null, segment.assetId ?? null, segment.label ?? null, segment.source ?? null));
        }
        if (message.replyToPlatformMessageId || message.replySnapshot) {
          upsertReference.run(messagePk, message.replyToPlatformMessageId ?? null, message.replySnapshot?.status ?? 'unresolved', message.replySnapshot ? json(message.replySnapshot) : null);
        }
        payload.run(messagePk, messagePayload.payloadVersion, messagePayload.wireMessageType,
          messagePayload.aweType === null ? null : JSON.stringify(messagePayload.aweType), messagePayload.contentJson, messagePayload.payloadStatus, now);
        this.persistMediaAssets(message, messagePk, now);
        matchedIds.push(platformId);
        if (improvesStatus || improvesKind || improvesText || messagePayload.payloadStatus === 'present') improvedIds.push(platformId);
      }
    })();
    return { matchedIds: [...new Set(matchedIds)], improvedIds: [...new Set(improvedIds)] };
  }

  ensureAttachment(input: { attachmentId: string; messagePk: string; kind: string; quality: string }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO attachments(attachment_id, message_pk, kind, quality, status, attempts, mime, extension, local_path, error, size, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(attachment_id) DO NOTHING`).run(input.attachmentId, input.messagePk, input.kind, input.quality, now);
  }

  updateAttachment(input: {
    attachmentId: string;
    status: ArchiveAttachmentRow['status'];
    attempts: number;
    quality?: string;
    mime?: string | null;
    extension?: string | null;
    localPath?: string | null;
    error?: string | null;
    size?: number | null;
    validationStatus?: ArchiveAttachmentRow['validationStatus'];
    actualFormat?: string | null;
  }) {
    const updates = ['status = ?', 'attempts = ?', 'updated_at = ?'];
    const values: unknown[] = [input.status, input.attempts, new Date().toISOString()];
    const optional: Array<[keyof typeof input, string]> = [
      ['quality', 'quality'], ['mime', 'mime'], ['extension', 'extension'], ['localPath', 'local_path'], ['error', 'error'],
      ['size', 'size'], ['validationStatus', 'validation_status'], ['actualFormat', 'actual_format']
    ];
    for (const [field, column] of optional) {
      if (!Object.hasOwn(input, field)) continue;
      updates.push(`${column} = ?`);
      values.push(input[field] ?? null);
    }
    values.push(input.attachmentId);
    this.db.prepare(`UPDATE attachments SET ${updates.join(', ')} WHERE attachment_id = ?`).run(...values);
  }

  listAttachments(accountId: string, conversationId: string): ArchiveAttachmentRow[] {
    return this.db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.message_pk=a.message_pk WHERE m.account_id=? AND m.conversation_id=? ORDER BY a.updated_at`).all(accountId, conversationId).map(row => ({
      ...attachmentRow(row)
    }));
  }

  getInternalAttachment(id: string): InternalAttachmentRecord | null {
    const row = this.db.prepare(`SELECT a.*, m.account_id, m.conversation_id FROM attachments a
      JOIN messages m ON m.message_pk=a.message_pk WHERE a.attachment_id=?`).get(id);
    return row ? internalAttachmentRow(row) : null;
  }

  listRetryableAttachments(accountId?: string, conversationId?: string): InternalAttachmentRecord[] {
    const where = accountId && conversationId ? 'm.account_id=? AND m.conversation_id=? AND '
      : accountId ? 'm.account_id=? AND ' : '';
    const parameters = accountId && conversationId ? [accountId, conversationId]
      : accountId ? [accountId] : [];
    const rows = this.db.prepare(`SELECT a.*, m.account_id, m.conversation_id FROM attachments a
      JOIN messages m ON m.message_pk=a.message_pk
      WHERE ${where}(a.status IN ('pending', 'failed') AND a.attempts < 3) AND a.resource_json IS NOT NULL
      ORDER BY a.updated_at, a.attachment_id`).all(...parameters);
    return rows.map(internalAttachmentRow).filter((row): row is InternalAttachmentRecord => row !== null);
  }

  listSavedAttachments(accountId?: string, conversationId?: string): InternalAttachmentRecord[] {
    const where = accountId && conversationId ? 'm.account_id=? AND m.conversation_id=? AND '
      : accountId ? 'm.account_id=? AND ' : '';
    const parameters = accountId && conversationId ? [accountId, conversationId]
      : accountId ? [accountId] : [];
    const rows = this.db.prepare(`SELECT a.*, m.account_id, m.conversation_id FROM attachments a
      JOIN messages m ON m.message_pk=a.message_pk
      WHERE ${where}a.status='saved' AND a.asset_state='current' AND a.resource_json IS NOT NULL
      ORDER BY a.updated_at, a.attachment_id`).all(...parameters);
    return rows.map(internalAttachmentRow).filter((row): row is InternalAttachmentRecord => row !== null);
  }

  retryAttachment(id: string) {
    const result = this.db.prepare(`UPDATE attachments SET status='pending', attempts=0, error=NULL, updated_at=?
      WHERE attachment_id=? AND resource_json IS NOT NULL AND asset_state='current'`).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  getAttachment(id: string) {
    const row = this.db.prepare('SELECT local_path, status FROM attachments WHERE attachment_id = ?').get(id);
    return row?.status === 'saved' && row.local_path ? String(row.local_path) : null;
  }

  getAttachmentMediaContext(id: string): AttachmentMediaContext | null {
    const row = this.db.prepare(`SELECT a.attachment_id, a.local_path, a.size, a.status, a.asset_state, a.resource_json,
        m.kind AS message_kind
      FROM attachments a JOIN messages m ON m.message_pk=a.message_pk WHERE a.attachment_id=?`).get(id);
    if (!row || row.status !== 'saved' || typeof row.local_path !== 'string' || !row.local_path) return null;
    let expectedRole: AttachmentMediaContext['expectedRole'] = 'legacy';
    if (typeof row.resource_json === 'string') {
      const descriptor = parseJson<{ role?: unknown }>(row.resource_json, {});
      if (typeof descriptor.role === 'string' && ['image', 'audio', 'video', 'poster', 'emoji'].includes(descriptor.role)) {
        expectedRole = descriptor.role as AttachmentMediaContext['expectedRole'];
      }
    }
    if (expectedRole === 'legacy') {
      const legacyRole: Record<string, AttachmentMediaContext['expectedRole']> = {
        image: 'image', voice: 'audio', 'video-file': 'video', emoji: 'emoji', 'video-share': 'poster'
      };
      expectedRole = legacyRole[String(row.message_kind)] ?? 'legacy';
    }
    return {
      id: String(row.attachment_id), localPath: String(row.local_path),
      size: row.size === null || row.size === undefined ? null : Number(row.size),
      status: String(row.status) as ArchiveAttachmentRow['status'],
      assetState: String(row.asset_state ?? 'legacy') as ArchiveAttachmentRow['assetState'], expectedRole
    };
  }

  getBrowserMediaEvidence(attachmentId: string, fileSha256: string): BrowserMediaEvidence {
    const evidence: BrowserMediaEvidence = {
      imageDecoded: null, imageError: null, audioMetadata: null, audioPlayback: null, audioEnded: null, audioError: null
    };
    if (!/^[\da-f]{64}$/.test(fileSha256)) return evidence;
    const rows = this.db.prepare(`SELECT stage, result_json, recorded_at FROM attachment_browser_evidence
      WHERE attachment_id=? AND file_sha256=?`).all(attachmentId, fileSha256);
    for (const row of rows) {
      const result = parseJson<Record<string, unknown>>(row.result_json, {});
      const recordedAt = String(row.recorded_at);
      switch (row.stage) {
        case 'image-decoded': evidence.imageDecoded = { recordedAt, naturalWidth: Number(result.naturalWidth), naturalHeight: Number(result.naturalHeight) }; break;
        case 'image-error': evidence.imageError = { recordedAt, errorCode: Number(result.errorCode) }; break;
        case 'audio-metadata': evidence.audioMetadata = { recordedAt, durationSeconds: Number(result.durationSeconds) }; break;
        case 'audio-playback': evidence.audioPlayback = { recordedAt, advancedSeconds: Number(result.advancedSeconds) }; break;
        case 'audio-ended': evidence.audioEnded = { recordedAt }; break;
        case 'audio-error': evidence.audioError = { recordedAt, errorCode: Number(result.errorCode) }; break;
      }
    }
    return evidence;
  }

  recordBrowserMediaEvidence(attachmentId: string, fileSha256: string, event: BrowserMediaEvidenceEvent) {
    if (!/^[\da-f]{64}$/.test(fileSha256)) throw new Error('media-file-version-invalid');
    const evidence = this.getBrowserMediaEvidence(attachmentId, fileSha256);
    const stageByType: Record<BrowserMediaEvidenceEvent['type'], string> = {
      'image-decoded': 'imageDecoded', 'image-error': 'imageError', 'audio-metadata': 'audioMetadata',
      'audio-playback': 'audioPlayback', 'audio-ended': 'audioEnded', 'audio-error': 'audioError'
    };
    if (evidence[stageByType[event.type] as keyof BrowserMediaEvidence]) return { recorded: false, evidence };
    if (event.type === 'image-decoded' && (!Number.isSafeInteger(event.naturalWidth) || !Number.isSafeInteger(event.naturalHeight) ||
        event.naturalWidth < 1 || event.naturalHeight < 1 || event.naturalWidth > 100_000 || event.naturalHeight > 100_000 || event.naturalWidth * event.naturalHeight > 1_000_000_000)) throw new Error('media-image-dimensions-invalid');
    if ((event.type === 'image-error' || event.type === 'audio-error') && (!Number.isSafeInteger(event.errorCode) || event.errorCode < 1 || event.errorCode > 4)) throw new Error('media-element-error-invalid');
    if (event.type === 'audio-metadata' && (!Number.isFinite(event.durationSeconds) || event.durationSeconds <= 0 || event.durationSeconds > 172_800)) throw new Error('media-audio-duration-invalid');
    if (event.type === 'audio-playback' && (!Number.isFinite(event.advancedSeconds) || event.advancedSeconds < 0.25 || event.advancedSeconds > 3_600)) throw new Error('media-audio-progress-invalid');
    if (event.type === 'audio-ended' && !evidence.audioPlayback) throw new Error('media-audio-ended-without-progress');
    const result = { ...event } as Record<string, unknown>;
    delete result.type;
    const recordedAt = new Date().toISOString();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO attachment_browser_evidence(attachment_id, file_sha256, stage, result_json, recorded_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM attachments WHERE attachment_id=? AND status='saved' AND asset_state IN ('current','legacy'))`)
      .run(attachmentId, fileSha256, event.type, json(result), recordedAt, attachmentId);
    if (!insert.changes) return { recorded: false, evidence: this.getBrowserMediaEvidence(attachmentId, fileSha256) };
    if (event.type === 'image-decoded' || event.type === 'audio-playback' || event.type === 'audio-ended') {
      this.db.prepare("UPDATE attachments SET validation_status='browser-verified', updated_at=? WHERE attachment_id=? AND status='saved' AND asset_state IN ('current','legacy')")
        .run(recordedAt, attachmentId);
    }
    return { recorded: true, evidence: this.getBrowserMediaEvidence(attachmentId, fileSha256) };
  }

  getInternalMessagePayload(messagePk: string): InternalMessagePayload | null {
    return internalPayloadFromRow(this.db.prepare('SELECT * FROM message_payloads WHERE message_pk = ?').get(messagePk));
  }

  getExportBundle(accountId: string, conversationId: string): ArchiveExportBundle {
    const conversation = this.listConversations(accountId).find(item => item.conversationId === conversationId) ?? null;
    const accountRow = this.db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId);
    const account = accountRow ? { accountId, displayName: accountRow.display_name ? String(accountRow.display_name) : undefined, source: String(accountRow.source) } : null;
    const messages = this.listMessages(accountId, conversationId, '', -1, 0);
    const segments = this.db.prepare(`SELECT s.* FROM content_segments s JOIN messages m ON m.message_pk=s.message_pk
      WHERE m.account_id=? AND m.conversation_id=? ORDER BY s.message_pk, s.ordinal`).all(accountId, conversationId).map(row => ({
      messagePk: String(row.message_pk), ordinal: Number(row.ordinal), kind: String(row.kind), text: row.text ? String(row.text) : null, assetId: row.asset_id ? String(row.asset_id) : null, label: row.label ? String(row.label) : null, source: row.source ? String(row.source) : null
    }));
    const references = messages.filter(message => message.replySnapshot || message.replyToPlatformMessageId).map(message => ({
      messagePk: message.messagePk, targetMessageId: message.replyToPlatformMessageId ?? null,
      status: message.replySnapshot?.status ?? 'unresolved', snapshotJson: message.replySnapshot ? json(message.replySnapshot) : null
    }));
    const roleRows = this.db.prepare(`SELECT a.attachment_id, a.resource_json FROM attachments a JOIN messages m ON m.message_pk=a.message_pk
      WHERE m.account_id=? AND m.conversation_id=?`).all(accountId, conversationId);
    const attachmentRoles: ArchiveExportBundle['attachmentRoles'] = {};
    for (const row of roleRows) {
      let role: InternalMediaAssetDescription['role'] | 'legacy' = 'legacy';
      if (typeof row.resource_json === 'string') {
        try {
          const parsed = JSON.parse(row.resource_json) as { role?: unknown };
          if (typeof parsed.role === 'string' && ['image', 'audio', 'video', 'poster', 'emoji'].includes(parsed.role)) role = parsed.role as InternalMediaAssetDescription['role'];
        } catch { /* malformed private descriptor stays classified as legacy */ }
      }
      attachmentRoles[String(row.attachment_id)] = role;
    }
    return { account, conversation, messages, segments, references, attachments: this.listAttachments(accountId, conversationId), attachmentRoles, runs: this.listRuns(accountId, conversationId), checkpoint: this.getCheckpoint(accountId, conversationId) };
  }
}
