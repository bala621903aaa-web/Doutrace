import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildP1AcceptanceSummary } from '../src/probe/p1-summary.js';
import { P1_REQUIREMENTS, PROTOCOL_MAPPING_VERSION, TASK_REQUIREMENTS, TIME_MAPPING_VERSION, type SuiteManifestRun, type VerificationSuiteManifest, type VerificationTask } from '../src/probe/verification-suite.js';

const fixture = vi.hoisted(() => ({ manifest: null as VerificationSuiteManifest | null, files: { 'src/im/protocol.ts': 'a'.repeat(64), 'src/probe/history-verifier.ts': 'b'.repeat(64) } as Record<string, string> }));
vi.mock('../src/probe/verification-suite.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/probe/verification-suite.js')>(),
  readVerificationSuiteManifest: async () => fixture.manifest,
  hashSuiteCode: async () => fixture.files
}));

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-summary-unit-'));
  directories.push(directory);
  fixture.manifest = { version: 1, suiteId: 'unit-only', createdAt: '2026-10-03T00:00:00.000Z', runs: [] };
  return directory;
}

afterEach(async () => {
  fixture.manifest = null;
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('douyin-summary-unit-')) throw new Error('unexpected unit-test cleanup path');
    await rm(absolute, { recursive: true, force: true });
  }
});

async function addReport(directory: string, task: VerificationTask, options: { stale?: boolean; account?: string; omitAccount?: boolean; status?: string; id?: string } = {}) {
  const runId = options.id ?? `${task}-${fixture.manifest!.runs.length}`;
  const files = { ...fixture.files, ...(options.stale ? { 'src/im/protocol.ts': 'c'.repeat(64) } : {}) };
  const metadata = { suiteId: 'unit-only', runId, task, mode: task === 'recovery' ? 'resume' as const : 'normal' as const, checkpointId: null, startedAt: '', finishedAt: '', codeVersion: { algorithm: 'sha256' as const, files }, protocolMappingVersion: PROTOCOL_MAPPING_VERSION, timeMappingVersion: TIME_MAPPING_VERSION };
  const report = {
    reportVersion: 2, kind: 'p1-live-verification', runId, task, suite: metadata, evidenceComplete: true,
    accountFingerprints: options.omitAccount ? [] : [options.account ?? 'd'.repeat(24)], resume: { requested: task === 'recovery' },
    requirements: P1_REQUIREMENTS.map(key => ({ key, status: TASK_REQUIREMENTS[task].includes(key) ? options.status ?? 'pass' : 'not-run', evidence: {}, gaps: [] }))
  };
  const reportJsonPath = join(directory, `${runId}.json`);
  await writeFile(reportJsonPath, JSON.stringify(report));
  const reportJsonSha256 = createHash('sha256').update(await readFile(reportJsonPath)).digest('hex');
  const run: SuiteManifestRun = { ...metadata, reportJsonPath, reportJsonSha256, reportMarkdownPath: '', reportMarkdownSha256: '' };
  fixture.manifest!.runs.push(run);
  return reportJsonPath;
}

describe('current-version acceptance aggregation', () => {
  it('ignores stale passes before selecting evidence and accepts complete fresh task reports', async () => {
    const directory = await workspace();
    const old = await addReport(directory, 'chain', { stale: true });
    const missing = await buildP1AcceptanceSummary({ suiteId: 'unit-only', workspaceRoot: directory });
    expect(missing.summary.items.find(item => item.key === 'three-pages-no-scroll')?.status).toBe('not-run');
    expect(missing.summary.ignoredEvidence.some(item => item.reportPath === old)).toBe(true);
    expect(missing.summary.p2GateOpen).toBe(false);
    for (const task of ['chain', 'time', 'endpoint', 'recovery', 'semantics'] as const) await addReport(directory, task);
    const fresh = await buildP1AcceptanceSummary({ suiteId: 'unit-only', workspaceRoot: directory });
    expect(fresh.summary.overallStatus).toBe('pass');
    expect(fresh.summary.implementationMatches).toBe(true);
    expect(fresh.summary.p2GateOpen).toBe(true);
    expect(fresh.summary.items.flatMap(item => item.evidenceSources).every(item => item.reportPath !== old)).toBe(true);
  });

  it('does not combine successful evidence from different accounts', async () => {
    const directory = await workspace();
    for (const task of ['chain', 'time', 'endpoint', 'recovery', 'semantics'] as const) await addReport(directory, task, { account: task === 'endpoint' ? 'e'.repeat(24) : 'd'.repeat(24) });
    const result = await buildP1AcceptanceSummary({ suiteId: 'unit-only', workspaceRoot: directory });
    expect(result.summary.p2GateOpen).toBe(false);
    expect(result.summary.implementationMatches).toBe(false);
  });

  it('keeps current-version failures and rejects a changed evidence file', async () => {
    const directory = await workspace();
    for (const task of ['chain', 'time', 'endpoint', 'recovery', 'semantics'] as const) await addReport(directory, task);
    await addReport(directory, 'endpoint', { status: 'fail' });
    const failed = await buildP1AcceptanceSummary({ suiteId: 'unit-only', workspaceRoot: directory });
    expect(failed.summary.overallStatus).toBe('fail');
    expect(failed.summary.p2GateOpen).toBe(false);
    const path = await addReport(directory, 'chain');
    await writeFile(path, '{}');
    const altered = await buildP1AcceptanceSummary({ suiteId: 'unit-only', workspaceRoot: directory });
    expect(altered.summary.ignoredEvidence.some(item => item.reportPath === path)).toBe(true);
  });

  it('requires a complete account association even if every reported item passes', async () => {
    const directory = await workspace();
    for (const task of ['chain', 'time', 'endpoint', 'recovery', 'semantics'] as const) await addReport(directory, task, { omitAccount: task === 'time' });
    const result = await buildP1AcceptanceSummary({ suiteId: 'unit-only', workspaceRoot: directory });
    expect(result.summary.p2GateOpen).toBe(false);
    expect(result.summary.ignoredEvidence.some(item => item.reportPath === 'suite-account-association')).toBe(true);
  });
});
