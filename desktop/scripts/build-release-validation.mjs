import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearReleaseValidation, markReleaseBuild } from './build-mode.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(desktopRoot, 'dist');
await clearReleaseValidation(distRoot);
const suiteId = 'p1-sol-final-20261004';
const packageJson = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'));
const [{ buildP1AcceptanceSummary }, { P1_REQUIREMENTS, PROTOCOL_MAPPING_VERSION, TIME_MAPPING_VERSION }, { collectReleaseArtifactDigests, releaseArtifactFingerprint }] = await Promise.all([
  import(pathToFileURL(resolve(distRoot, 'probe/p1-summary.js'))),
  import(pathToFileURL(resolve(distRoot, 'probe/verification-suite.js'))),
  import(pathToFileURL(resolve(distRoot, 'core/release-validation.js')))
]);

const { summary } = await buildP1AcceptanceSummary({ suiteId, workspaceRoot: desktopRoot });
if (summary.overallStatus !== 'pass' || summary.implementationMatches !== true || summary.p2GateOpen !== true ||
    summary.items.length !== P1_REQUIREMENTS.length || summary.items.some(item => item.status !== 'pass')) {
  throw new Error('release-validation-p1-gate-closed');
}
const evidence = summary.items.flatMap(item => item.evidenceSources);
const protocolVersions = new Set(evidence.map(item => item.protocolMappingVersion));
const timeVersions = new Set(evidence.map(item => item.timeMappingVersion));
if (protocolVersions.size !== 1 || !protocolVersions.has(PROTOCOL_MAPPING_VERSION) || timeVersions.size !== 1 || !timeVersions.has(TIME_MAPPING_VERSION)) {
  throw new Error('release-validation-mapping-version-mismatch');
}
await markReleaseBuild(distRoot);
const files = await collectReleaseArtifactDigests(distRoot);
for (const required of ['main.js', 'preload.cjs', 'renderer/index.html']) if (!files[required]) throw new Error(`release-validation-required-artifact-missing:${required}`);
const sourceSummary = await readFile(resolve(desktopRoot, 'P1-ACCEPTANCE-SUMMARY.json'));
const document = {
  schemaVersion: 1,
  kind: 'release-validation',
  generatedAt: new Date().toISOString(),
  suiteId,
  productVersion: packageJson.version,
  p1: {
    overallStatus: summary.overallStatus,
    implementationMatches: summary.implementationMatches,
    p2GateOpen: summary.p2GateOpen,
    requirements: P1_REQUIREMENTS.map(key => ({ key, status: summary.items.find(item => item.key === key)?.status })),
    protocolMappingVersion: PROTOCOL_MAPPING_VERSION,
    timeMappingVersion: TIME_MAPPING_VERSION,
    sourceSummarySha256: createHash('sha256').update(sourceSummary).digest('hex')
  },
  artifacts: { algorithm: 'sha256', files, fingerprint: releaseArtifactFingerprint(files) }
};
const output = resolve(distRoot, 'release-validation.json');
const temporary = `${output}.${process.pid}.tmp`;
try {
  await writeFile(temporary, JSON.stringify(document, null, 2), { flag: 'wx' });
  await rename(temporary, output);
} catch (error) {
  await rm(temporary, { force: true }).catch(() => undefined);
  throw error;
}
console.log(`Release validation bound ${Object.keys(files).length} build files for ${suiteId} (${packageJson.version}).`);
