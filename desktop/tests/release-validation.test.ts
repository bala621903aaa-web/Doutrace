import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectReleaseArtifactDigests, releaseArtifactFingerprint, validateReleaseValidation, type ReleaseValidationExpected, type ReleaseValidationDocument } from '../src/core/release-validation.js';

const roots: string[] = [];
const expected: ReleaseValidationExpected = {
  productVersion: '0.3.0', suiteId: 'p1-sol-final-20261004',
  requirementKeys: ['real-channel', 'identity', 'platform-message-id', 'three-pages-no-scroll', 'sent-time', 'history-end', 'cursor-recovery', 'message-semantics'],
  protocolMappingVersion: 'p1-history-and-init-protocol-v4', timeMappingVersion: 'p1-official-ui-copy-time-v7'
};

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'douyin-release-validation-'));
  roots.push(root);
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'renderer'), { recursive: true });
  await mkdir(join(dist, 'core'), { recursive: true });
  await writeFile(join(dist, 'main.js'), 'main-build');
  await writeFile(join(dist, 'preload.cjs'), 'preload-build');
  await writeFile(join(dist, 'renderer', 'index.html'), '<main>offline</main>');
  await writeFile(join(dist, 'core', 'attachment.js'), 'attachment-build');
  const files = await collectReleaseArtifactDigests(dist);
  const document: ReleaseValidationDocument = {
    schemaVersion: 1, kind: 'release-validation', generatedAt: new Date().toISOString(), suiteId: expected.suiteId, productVersion: expected.productVersion,
    p1: { overallStatus: 'pass', implementationMatches: true, p2GateOpen: true,
      requirements: expected.requirementKeys.map(key => ({ key, status: 'pass' })),
      protocolMappingVersion: expected.protocolMappingVersion, timeMappingVersion: expected.timeMappingVersion,
      sourceSummarySha256: createHash('sha256').update('source summary').digest('hex') },
    artifacts: { algorithm: 'sha256', files, fingerprint: releaseArtifactFingerprint(files) }
  };
  await writeFile(join(dist, 'release-validation.json'), JSON.stringify(document, null, 2));
  return { root, dist, document };
}

describe('release validation gate', () => {
  it('accepts matching P1 evidence and hashes for the current built files', async () => {
    const current = await fixture();
    await expect(validateReleaseValidation(current.dist, expected)).resolves.toMatchObject({ valid: true, acquisitionEnabled: true, offlineEnabled: true, reason: 'release-validation-pass' });
  });

  it('keeps offline reading enabled and closes acquisition when metadata is missing or a built artifact changes', async () => {
    const current = await fixture();
    await rm(join(current.dist, 'release-validation.json'));
    await expect(validateReleaseValidation(current.dist, expected)).resolves.toMatchObject({ valid: false, acquisitionEnabled: false, offlineEnabled: true });
    await writeFile(join(current.dist, 'release-validation.json'), JSON.stringify(current.document));
    await writeFile(join(current.dist, 'main.js'), 'tampered-build');
    await expect(validateReleaseValidation(current.dist, expected)).resolves.toMatchObject({ valid: false, acquisitionEnabled: false, offlineEnabled: true, reason: 'release-artifact-hash-mismatch' });
  });

  it('rejects a development marker even if a valid release manifest remains', async () => {
    const current = await fixture();
    await writeFile(join(current.dist, 'development-mode.json'), '{"kind":"development-mode","mockDataOnly":true}\n');
    await expect(validateReleaseValidation(current.dist, expected)).resolves.toMatchObject({
      valid: false, acquisitionEnabled: false, offlineEnabled: true, reason: 'development-build'
    });
  });

  it('rejects a product version mismatch, incomplete P1 evidence, and unbound files', async () => {
    const current = await fixture();
    await expect(validateReleaseValidation(current.dist, { ...expected, productVersion: '0.4.0' })).resolves.toMatchObject({ valid: false, acquisitionEnabled: false, reason: 'release-version-mismatch' });
    const changed = { ...current.document, p1: { ...current.document.p1, requirements: current.document.p1.requirements.slice(1) } };
    await writeFile(join(current.dist, 'release-validation.json'), JSON.stringify(changed));
    await expect(validateReleaseValidation(current.dist, expected)).resolves.toMatchObject({ valid: false, reason: 'release-p1-requirements-incomplete' });
    await writeFile(join(current.dist, 'release-validation.json'), JSON.stringify(current.document));
    await writeFile(join(current.dist, 'extra.js'), 'unbound');
    await expect(validateReleaseValidation(current.dist, expected)).resolves.toMatchObject({ valid: false, reason: 'release-artifact-set-mismatch' });
  });
});
