import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CollectorCursorCheckpoint {
  resumeRequested: boolean;
  state: string | null;
  cursor: string | null;
}

export interface CollectorCursorRequestInput {
  runId: string;
  accountId: string;
  conversationId: string;
  pageIndex: number;
  checkpoint: CollectorCursorCheckpoint;
  inputCursor: string | null;
}

export interface CollectorCursorRequestEvidence {
  processFingerprint: string;
  runFingerprint: string;
  scopeFingerprint: string;
  pageIndex: number;
  resumeRequested: boolean;
  checkpointState: string | null;
  checkpointCursorPresent: boolean;
  checkpointCursorFingerprint: string;
  inputCursorPresent: boolean;
  inputCursorFingerprint: string;
  inputMatchesCheckpoint: boolean;
}

export interface CollectorCursorCommitEvidence extends CollectorCursorRequestEvidence {
  outputCursorPresent: boolean;
  outputCursorFingerprint: string;
  pageMessageCount: number;
  newMessageCount: number;
  uniquePlatformMessageIdCount: number;
  identityValidated: true;
  hasMore: boolean | null;
  checkpointCommitted: true;
}

export interface StoredCollectorCursorEvidence {
  processFingerprint: string;
  runFingerprint: string;
  scopeFingerprint: string;
  phase: 'requested' | 'committed';
  pageIndex: number;
  resumeRequested: boolean;
  checkpointState: string | null;
  checkpointCursorPresent: boolean;
  checkpointCursorFingerprint: string;
  inputCursorPresent: boolean;
  inputCursorFingerprint: string;
  inputMatchesCheckpoint: boolean;
  outputCursorPresent: boolean | null;
  outputCursorFingerprint: string | null;
  pageMessageCount: number | null;
  newMessageCount: number | null;
  uniquePlatformMessageIdCount: number | null;
  identityValidated: boolean | null;
  hasMore: boolean | null;
  checkpointCommitted: boolean;
  recordedAt: string;
}

function digest(key: Buffer, label: string, value: string) {
  return createHmac('sha256', key).update(label).update('\0').update(value).digest('hex');
}

export class CollectorCursorEvidence {
  private readonly key: Buffer;
  private readonly processNonce = randomBytes(32);

  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.byteLength !== 32) throw new Error('collector-evidence-key-invalid');
    this.key = Buffer.from(key);
  }

  request(input: CollectorCursorRequestInput): CollectorCursorRequestEvidence {
    if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 1 || input.pageIndex > 10_000 ||
        input.runId.length > 128 || input.accountId.length > 512 || input.conversationId.length > 512 ||
        (input.inputCursor !== null && input.inputCursor.length > 65_536) ||
        (input.checkpoint.cursor !== null && input.checkpoint.cursor.length > 65_536)) {
      throw new Error('collector-evidence-input-invalid');
    }
    const scopeFingerprint = digest(this.key, 'scope', `${input.accountId}\0${input.conversationId}`);
    const cursorFingerprint = (cursor: string | null) => digest(this.key, 'cursor', `${scopeFingerprint}\0${cursor === null ? 'null' : `value\0${cursor}`}`);
    const checkpointUsable = input.checkpoint.resumeRequested && input.checkpoint.state !== 'complete';
    return {
      processFingerprint: digest(this.key, 'process', this.processNonce.toString('hex')),
      runFingerprint: digest(this.key, 'run', `${scopeFingerprint}\0${input.runId}`),
      scopeFingerprint,
      pageIndex: input.pageIndex,
      resumeRequested: input.checkpoint.resumeRequested,
      checkpointState: input.checkpoint.state,
      checkpointCursorPresent: input.checkpoint.cursor !== null,
      checkpointCursorFingerprint: cursorFingerprint(input.checkpoint.cursor),
      inputCursorPresent: input.inputCursor !== null,
      inputCursorFingerprint: cursorFingerprint(input.inputCursor),
      inputMatchesCheckpoint: checkpointUsable && input.inputCursor === input.checkpoint.cursor
    };
  }

  committed(request: CollectorCursorRequestEvidence, input: {
    accountId: string;
    conversationId: string;
    outputCursor: string | null;
    pageMessageCount: number;
    newMessageCount: number;
    uniquePlatformMessageIdCount: number;
    hasMore: boolean | null;
  }): CollectorCursorCommitEvidence {
    if (!Number.isSafeInteger(input.pageMessageCount) || input.pageMessageCount < 0 ||
        !Number.isSafeInteger(input.newMessageCount) || input.newMessageCount < 0 || input.newMessageCount > input.pageMessageCount ||
        !Number.isSafeInteger(input.uniquePlatformMessageIdCount) || input.uniquePlatformMessageIdCount < 0 ||
        (input.outputCursor !== null && input.outputCursor.length > 65_536) ||
        request.scopeFingerprint !== digest(this.key, 'scope', `${input.accountId}\0${input.conversationId}`)) {
      throw new Error('collector-evidence-commit-invalid');
    }
    const outputCursorFingerprint = digest(this.key, 'cursor', `${request.scopeFingerprint}\0${input.outputCursor === null ? 'null' : `value\0${input.outputCursor}`}`);
    return {
      ...request,
      outputCursorPresent: input.outputCursor !== null,
      outputCursorFingerprint,
      pageMessageCount: input.pageMessageCount,
      newMessageCount: input.newMessageCount,
      uniquePlatformMessageIdCount: input.uniquePlatformMessageIdCount,
      identityValidated: true,
      hasMore: input.hasMore,
      checkpointCommitted: true
    };
  }
}

export async function loadOrCreateCollectorEvidenceKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const key = await readFile(path);
    if (key.byteLength !== 32) throw new Error('collector-evidence-key-invalid');
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const candidate = randomBytes(32);
  try {
    await writeFile(path, candidate, { flag: 'wx', mode: 0o600 });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (existing.byteLength !== 32) throw new Error('collector-evidence-key-invalid');
    return existing;
  }
}
