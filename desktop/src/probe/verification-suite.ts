import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { appDataRoot } from './browser.js';

export const PROTOCOL_MAPPING_VERSION = 'p1-history-and-init-protocol-v4';
export const TIME_MAPPING_VERSION = 'p1-official-ui-copy-time-v7';

export const VERIFICATION_TASKS = ['chain', 'time', 'endpoint', 'recovery', 'semantics'] as const;
export type VerificationTask = typeof VERIFICATION_TASKS[number];

export const P1_REQUIREMENTS = [
  'real-channel',
  'identity',
  'platform-message-id',
  'three-pages-no-scroll',
  'sent-time',
  'history-end',
  'cursor-recovery',
  'message-semantics'
] as const;
export type P1RequirementKey = typeof P1_REQUIREMENTS[number];

export const TASK_REQUIREMENTS: Record<VerificationTask, readonly P1RequirementKey[]> = {
  chain: ['real-channel', 'identity', 'platform-message-id', 'three-pages-no-scroll'],
  time: ['sent-time'],
  endpoint: ['history-end'],
  recovery: ['cursor-recovery'],
  semantics: ['message-semantics']
};

export interface SuiteRunMetadata {
  suiteId: string;
  runId: string;
  task: VerificationTask;
  mode: 'normal' | 'resume';
  checkpointId: string | null;
  startedAt: string;
  finishedAt: string | null;
  codeVersion: {
    algorithm: 'sha256';
    files: Record<string, string>;
  };
  protocolMappingVersion: string;
  timeMappingVersion: string;
}

export interface SuiteRedactor {
  fingerprint(kind: string, value: string | null): string | null;
}

export interface VerificationSuiteRun {
  metadata: SuiteRunMetadata;
  redactor: SuiteRedactor;
  root: string;
}

export interface SuiteManifestRun extends SuiteRunMetadata {
  reportJsonPath: string;
  reportJsonSha256: string;
  reportMarkdownPath: string;
  reportMarkdownSha256: string;
}

export interface VerificationSuiteManifest {
  version: 1;
  suiteId: string;
  createdAt: string;
  runs: SuiteManifestRun[];
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} 必须是 1 到 64 个 ASCII 字母、数字、点、下划线或短横线`);
  }
  return value;
}

export function normalizeSuiteId(value: string): string {
  return safeSegment(value, 'suite');
}

export function normalizeCheckpointId(value: string): string {
  return safeSegment(value, 'checkpoint');
}

function suiteRoot(suiteId: string) {
  return join(appDataRoot(), 'verification-suites', normalizeSuiteId(suiteId));
}

function keyPath(root: string) {
  return join(root, 'suite.key');
}

async function atomicWrite(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

async function loadOrCreateKey(root: string): Promise<Buffer> {
  const path = keyPath(root);
  try {
    const encoded = (await readFile(path, 'utf8')).trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.length === 32) return key;
  } catch {
    // Create the suite key below.
  }
  const key = randomBytes(32);
  await atomicWrite(path, key.toString('base64'));
  return Buffer.from(key.toString('base64'), 'base64');
}

async function sha256File(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function hashSuiteCode(workspaceRoot: string): Promise<Record<string, string>> {
  const relativeFiles = [
    'src/im/protocol.ts',
    'src/im/init-protocol.ts',
    'src/im/wire.ts',
    'src/probe/checkpoint.ts',
    'src/probe/history-transport.ts',
    'src/probe/history-verifier.ts',
    'src/probe/live-report.ts',
    'src/probe/page-state.ts',
    'src/probe/time-evidence.ts',
    'src/probe/time-window.ts',
    'src/probe/time-verifier.ts',
    'src/probe/time-mapping-source.ts',
    'src/probe/message-info-time.ts',
    'src/probe/p1-summary.ts',
    'src/probe/verification-suite.ts',
    'src/probe/verify-entry.ts'
  ];
  const result: Record<string, string> = {};
  for (const relativeFile of relativeFiles) {
    const path = join(workspaceRoot, relativeFile);
    try {
      result[relativeFile] = await sha256File(path);
    } catch {
      result[relativeFile] = 'missing';
    }
  }
  return result;
}

function createRedactor(key: Buffer): SuiteRedactor {
  return {
    fingerprint(kind, value) {
      if (value === null) return null;
      return createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex').slice(0, 24);
    }
  };
}

export async function openVerificationSuiteRun(input: {
  suiteId: string;
  runId: string;
  task: VerificationTask;
  mode: 'normal' | 'resume';
  checkpointId?: string | null;
  startedAt: string;
  workspaceRoot: string;
}): Promise<VerificationSuiteRun> {
  const suiteId = normalizeSuiteId(input.suiteId);
  const root = suiteRoot(suiteId);
  await mkdir(root, { recursive: true });
  const key = await loadOrCreateKey(root);
  const metadata: SuiteRunMetadata = {
    suiteId,
    runId: input.runId,
    task: input.task,
    mode: input.mode,
    checkpointId: input.checkpointId ? normalizeCheckpointId(input.checkpointId) : null,
    startedAt: input.startedAt,
    finishedAt: null,
    codeVersion: { algorithm: 'sha256', files: await hashSuiteCode(input.workspaceRoot) },
    protocolMappingVersion: PROTOCOL_MAPPING_VERSION,
    timeMappingVersion: TIME_MAPPING_VERSION
  };
  return { metadata, redactor: createRedactor(key), root };
}

function manifestPath(root: string) {
  return join(root, 'manifest.json');
}

export async function readVerificationSuiteManifest(suiteId: string): Promise<VerificationSuiteManifest | null> {
  const path = manifestPath(suiteRoot(suiteId));
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const manifest = value as VerificationSuiteManifest;
    if (manifest.version !== 1 || manifest.suiteId !== normalizeSuiteId(suiteId) || !Array.isArray(manifest.runs)) return null;
    return manifest;
  } catch {
    return null;
  }
}

export async function recordVerificationSuiteRun(run: SuiteManifestRun): Promise<string> {
  const root = suiteRoot(run.suiteId);
  await mkdir(root, { recursive: true });
  const current = await readVerificationSuiteManifest(run.suiteId);
  const manifest: VerificationSuiteManifest = current ?? { version: 1, suiteId: run.suiteId, createdAt: new Date().toISOString(), runs: [] };
  if (!manifest.runs.some(item => item.runId === run.runId)) manifest.runs.push(run);
  await atomicWrite(manifestPath(root), JSON.stringify(manifest, null, 2));
  return manifestPath(root);
}

export async function sha256Path(path: string) {
  return sha256File(path);
}

export function suiteRelativePath(workspaceRoot: string, path: string) {
  return relative(workspaceRoot, path).replaceAll('\\', '/');
}
