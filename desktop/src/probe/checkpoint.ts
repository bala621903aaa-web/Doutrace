import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataRoot } from './browser.js';
import { normalizeCheckpointId, normalizeSuiteId, type SuiteRunMetadata, type SuiteRedactor } from './verification-suite.js';

/**
 * Version 1 is deliberately retained as a legacy reader only. It is never
 * promoted into a P1 acceptance record and is not used by the new verifier.
 */
export interface LegacyHistoryVerificationCheckpoint {
  version: 1;
  runId: string;
  savedAt: string;
  accountId: string;
  conversationId: string;
  conversationShortId: string;
  nextCursor: string | null;
  lastPageMessageIds: string[];
  lastPageIndexes: string[];
  lastPageHasMore: boolean | null;
}

export interface HistoryVerificationCheckpoint {
  version: 2;
  kind: 'p1-history-checkpoint';
  suiteId: string;
  checkpointId: string;
  runId: string;
  savedAt: string;
  accountId: string;
  conversationId: string;
  conversationShortId: string;
  nextCursor: string | null;
  lastPageMessageIds: string[];
  lastPageIndexes: string[];
  lastPageHasMore: boolean | null;
  codeVersionHash: string;
  protocolMappingVersion: string;
  timeMappingVersion: string;
}

export interface HistoryControlBaseline {
  version: 1;
  kind: 'p1-history-control-baseline';
  suiteId: string;
  checkpointId: string;
  runId: string;
  capturedAt: string;
  accountId: string;
  conversationId: string;
  conversationShortId: string;
  inputCursor: string | null;
  responseMessageIds: string[];
  responseIndexes: string[];
  nextCursor: string | null;
  hasMore: boolean | null;
  httpStatus: number;
  businessStatus: string | null;
  codeVersionHash: string;
  protocolMappingVersion: string;
  timeMappingVersion: string;
}

interface CheckpointIndexEntry {
  checkpointId: string;
  checkpointPath: string;
  controlPath: string;
  accountFingerprint: string;
  conversationFingerprint: string;
  updatedAt: string;
}

interface CheckpointIndex {
  version: 1;
  suiteId: string;
  entries: CheckpointIndexEntry[];
}

export interface CheckpointStoreContext {
  suiteId: string;
  checkpointId: string;
  accountFingerprint: string;
  conversationFingerprint: string;
}

function legacyPath() {
  return join(appDataRoot(), 'verification-checkpoints', 'history.json');
}

export function verificationCheckpointPath() {
  // Kept for diagnostics and backwards-compatible callers. New code must use
  // the suite-scoped path returned by saveVerificationCheckpoint.
  return legacyPath();
}

function suiteDirectory(suiteId: string) {
  return join(appDataRoot(), 'verification-checkpoints', 'suites', normalizeSuiteId(suiteId));
}

function suiteIndexPath(suiteId: string) {
  return join(suiteDirectory(suiteId), 'index.json');
}

function validLegacyCheckpoint(value: unknown): value is LegacyHistoryVerificationCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && typeof item.runId === 'string' && typeof item.savedAt === 'string' &&
    typeof item.accountId === 'string' && typeof item.conversationId === 'string' && typeof item.conversationShortId === 'string' &&
    (item.nextCursor === null || typeof item.nextCursor === 'string') && Array.isArray(item.lastPageMessageIds) &&
    item.lastPageMessageIds.every(value => typeof value === 'string') && Array.isArray(item.lastPageIndexes) &&
    item.lastPageIndexes.every(value => typeof value === 'string') &&
    (item.lastPageHasMore === null || typeof item.lastPageHasMore === 'boolean');
}

function validCheckpoint(value: unknown): value is HistoryVerificationCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.version === 2 && item.kind === 'p1-history-checkpoint' && typeof item.suiteId === 'string' &&
    typeof item.checkpointId === 'string' && typeof item.runId === 'string' && typeof item.savedAt === 'string' &&
    typeof item.accountId === 'string' && typeof item.conversationId === 'string' && typeof item.conversationShortId === 'string' &&
    (item.nextCursor === null || typeof item.nextCursor === 'string') && Array.isArray(item.lastPageMessageIds) &&
    item.lastPageMessageIds.every(value => typeof value === 'string') && Array.isArray(item.lastPageIndexes) &&
    item.lastPageIndexes.every(value => typeof value === 'string') &&
    (item.lastPageHasMore === null || typeof item.lastPageHasMore === 'boolean') &&
    typeof item.codeVersionHash === 'string' && typeof item.protocolMappingVersion === 'string' && typeof item.timeMappingVersion === 'string';
}

function validControlBaseline(value: unknown): value is HistoryControlBaseline {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && item.kind === 'p1-history-control-baseline' && typeof item.suiteId === 'string' &&
    typeof item.checkpointId === 'string' && typeof item.runId === 'string' && typeof item.capturedAt === 'string' &&
    typeof item.accountId === 'string' && typeof item.conversationId === 'string' && typeof item.conversationShortId === 'string' &&
    (item.inputCursor === null || typeof item.inputCursor === 'string') && Array.isArray(item.responseMessageIds) &&
    item.responseMessageIds.every(value => typeof value === 'string') && Array.isArray(item.responseIndexes) &&
    item.responseIndexes.every(value => typeof value === 'string') && (item.nextCursor === null || typeof item.nextCursor === 'string') &&
    (item.hasMore === null || typeof item.hasMore === 'boolean') && typeof item.httpStatus === 'number' &&
    (item.businessStatus === null || typeof item.businessStatus === 'string') && typeof item.codeVersionHash === 'string' &&
    typeof item.protocolMappingVersion === 'string' && typeof item.timeMappingVersion === 'string';
}

async function atomicWrite(path: string, value: unknown) {
  const directory = join(path, '..');
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporaryPath, path);
}

async function readIndex(suiteId: string): Promise<CheckpointIndex> {
  try {
    const value: unknown = JSON.parse(await readFile(suiteIndexPath(suiteId), 'utf8'));
    if (value && typeof value === 'object' && (value as CheckpointIndex).version === 1 && Array.isArray((value as CheckpointIndex).entries)) {
      return value as CheckpointIndex;
    }
  } catch {
    // An absent or malformed index is equivalent to no new checkpoint.
  }
  return { version: 1, suiteId: normalizeSuiteId(suiteId), entries: [] };
}

function checkpointPaths(context: CheckpointStoreContext) {
  const suite = suiteDirectory(context.suiteId);
  const directory = join(suite, 'accounts', context.accountFingerprint, 'conversations', context.conversationFingerprint);
  const base = join(directory, context.checkpointId);
  return { checkpointPath: `${base}.checkpoint.json`, controlPath: `${base}.control.json` };
}

function contextForCheckpoint(checkpoint: HistoryVerificationCheckpoint, redactor: SuiteRedactor): CheckpointStoreContext {
  return {
    suiteId: checkpoint.suiteId,
    checkpointId: checkpoint.checkpointId,
    accountFingerprint: redactor.fingerprint('account', checkpoint.accountId) ?? 'unknown-account',
    conversationFingerprint: redactor.fingerprint('conversation', checkpoint.conversationId) ?? 'unknown-conversation'
  };
}

export function codeVersionHash(metadata: SuiteRunMetadata): string {
  return createHash('sha256').update(JSON.stringify({
    files: metadata.codeVersion.files,
    protocolMappingVersion: metadata.protocolMappingVersion,
    timeMappingVersion: metadata.timeMappingVersion
  })).digest('hex');
}

export async function loadVerificationCheckpoint(): Promise<LegacyHistoryVerificationCheckpoint | null> {
  try {
    const value: unknown = JSON.parse(await readFile(legacyPath(), 'utf8'));
    return validLegacyCheckpoint(value) ? value : null;
  } catch {
    return null;
  }
}

export async function loadSuiteVerificationCheckpoint(input: { suiteId: string; checkpointId: string }): Promise<HistoryVerificationCheckpoint | null> {
  const suiteId = normalizeSuiteId(input.suiteId);
  const checkpointId = normalizeCheckpointId(input.checkpointId);
  const index = await readIndex(suiteId);
  const entry = index.entries.find(item => item.checkpointId === checkpointId);
  if (!entry) return null;
  try {
    const value: unknown = JSON.parse(await readFile(entry.checkpointPath, 'utf8'));
    return validCheckpoint(value) && value.suiteId === suiteId && value.checkpointId === checkpointId ? value : null;
  } catch {
    return null;
  }
}

export async function saveVerificationCheckpoint(checkpoint: HistoryVerificationCheckpoint, context?: CheckpointStoreContext): Promise<string> {
  if (!context) {
    // Do not silently migrate the old single-file checkpoint. This branch is
    // retained only for callers that explicitly write the legacy format.
    if ((checkpoint as unknown as { version?: number }).version !== 1) throw new Error('new checkpoints require suite-scoped storage');
    const path = legacyPath();
    await atomicWrite(path, checkpoint);
    return path;
  }
  const suiteId = normalizeSuiteId(context.suiteId);
  const checkpointId = normalizeCheckpointId(context.checkpointId);
  if (checkpoint.suiteId !== suiteId || checkpoint.checkpointId !== checkpointId) throw new Error('checkpoint-context-mismatch');
  const paths = checkpointPaths({ ...context, suiteId, checkpointId });
  await atomicWrite(paths.checkpointPath, checkpoint);
  const index = await readIndex(suiteId);
  const nextEntry: CheckpointIndexEntry = {
    checkpointId,
    checkpointPath: paths.checkpointPath,
    controlPath: paths.controlPath,
    accountFingerprint: context.accountFingerprint,
    conversationFingerprint: context.conversationFingerprint,
    updatedAt: new Date().toISOString()
  };
  index.entries = [...index.entries.filter(item => item.checkpointId !== checkpointId), nextEntry];
  await atomicWrite(suiteIndexPath(suiteId), index);
  return paths.checkpointPath;
}

export async function saveControlBaseline(baseline: HistoryControlBaseline, context: CheckpointStoreContext): Promise<string> {
  const suiteId = normalizeSuiteId(context.suiteId);
  const checkpointId = normalizeCheckpointId(context.checkpointId);
  if (baseline.suiteId !== suiteId || baseline.checkpointId !== checkpointId) throw new Error('control-context-mismatch');
  const paths = checkpointPaths({ ...context, suiteId, checkpointId });
  await atomicWrite(paths.controlPath, baseline);
  return paths.controlPath;
}

export async function loadControlBaseline(input: { suiteId: string; checkpointId: string }): Promise<HistoryControlBaseline | null> {
  const suiteId = normalizeSuiteId(input.suiteId);
  const checkpointId = normalizeCheckpointId(input.checkpointId);
  const index = await readIndex(suiteId);
  const entry = index.entries.find(item => item.checkpointId === checkpointId);
  if (!entry) return null;
  try {
    const value: unknown = JSON.parse(await readFile(entry.controlPath, 'utf8'));
    return validControlBaseline(value) && value.suiteId === suiteId && value.checkpointId === checkpointId ? value : null;
  } catch {
    return null;
  }
}

export function checkpointStoreContext(checkpoint: HistoryVerificationCheckpoint, redactor: SuiteRedactor): CheckpointStoreContext {
  return contextForCheckpoint(checkpoint, redactor);
}
