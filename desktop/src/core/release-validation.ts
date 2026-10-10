import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export interface ReleaseValidationExpected {
  productVersion: string;
  suiteId: string;
  requirementKeys: readonly string[];
  protocolMappingVersion: string;
  timeMappingVersion: string;
}

export interface ReleaseValidationDocument {
  schemaVersion: 1;
  kind: 'release-validation';
  generatedAt: string;
  suiteId: string;
  productVersion: string;
  p1: {
    overallStatus: 'pass';
    implementationMatches: true;
    p2GateOpen: true;
    requirements: Array<{ key: string; status: 'pass' }>;
    protocolMappingVersion: string;
    timeMappingVersion: string;
    sourceSummarySha256: string;
  };
  artifacts: {
    algorithm: 'sha256';
    files: Record<string, string>;
    fingerprint: string;
  };
}

export interface ReleaseValidationState {
  valid: boolean;
  acquisitionEnabled: boolean;
  offlineEnabled: true;
  reason: string;
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function releaseArtifactFingerprint(files: Record<string, string>) {
  return createHash('sha256').update(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => `${path}:${hash}\n`).join('')).digest('hex');
}

export async function collectReleaseArtifactDigests(distRoot: string): Promise<Record<string, string>> {
  const root = resolve(distRoot);
  const files: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('release-artifact-symlink-unsupported');
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw new Error('release-artifact-entry-unsupported');
      const path = relative(root, absolute).split(sep).join('/');
      if (path === 'release-validation.json') continue;
      files[path] = sha256(await readFile(absolute));
    }
  };
  await visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function validRelativePath(path: string) {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)) return false;
  return path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

export async function validateReleaseValidation(distRoot: string, expected: ReleaseValidationExpected): Promise<ReleaseValidationState> {
  const invalid = (reason: string): ReleaseValidationState => ({ valid: false, acquisitionEnabled: false, offlineEnabled: true, reason });
  try {
    const root = resolve(distRoot);
    try {
      await readFile(join(root, 'development-mode.json'));
      return invalid('development-build');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return invalid('development-mode-unreadable');
    }
    const document = JSON.parse(await readFile(join(root, 'release-validation.json'), 'utf8')) as Partial<ReleaseValidationDocument>;
    if (document.schemaVersion !== 1 || document.kind !== 'release-validation' || typeof document.generatedAt !== 'string') return invalid('release-metadata-invalid');
    if (document.suiteId !== expected.suiteId || document.productVersion !== expected.productVersion) return invalid('release-version-mismatch');
    if (!document.p1 || document.p1.overallStatus !== 'pass' || document.p1.implementationMatches !== true || document.p1.p2GateOpen !== true ||
        document.p1.protocolMappingVersion !== expected.protocolMappingVersion || document.p1.timeMappingVersion !== expected.timeMappingVersion ||
        !/^[a-f0-9]{64}$/.test(document.p1.sourceSummarySha256)) return invalid('release-p1-evidence-invalid');
    const requirements = document.p1.requirements;
    if (!Array.isArray(requirements) || requirements.length !== expected.requirementKeys.length ||
        [...requirements].sort((a, b) => a.key.localeCompare(b.key)).some((item, index) => item.key !== [...expected.requirementKeys].sort()[index] || item.status !== 'pass')) {
      return invalid('release-p1-requirements-incomplete');
    }
    const files = document.artifacts?.files;
    if (document.artifacts?.algorithm !== 'sha256' || !files || typeof files !== 'object' || Array.isArray(files) ||
        document.artifacts.fingerprint !== releaseArtifactFingerprint(files)) return invalid('release-artifact-manifest-invalid');
    for (const required of ['main.js', 'preload.cjs', 'renderer/index.html', 'renderer/renderer.js', 'renderer/renderer.css']) {
      if (!Object.hasOwn(files, required)) return invalid('release-artifact-required-file-missing');
    }
    for (const [path, expectedHash] of Object.entries(files)) {
      if (!validRelativePath(path) || path === 'release-validation.json' || !/^[a-f0-9]{64}$/.test(expectedHash)) return invalid('release-artifact-manifest-invalid');
      const absolute = resolve(root, path);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return invalid('release-artifact-path-invalid');
      if (sha256(await readFile(absolute)) !== expectedHash) return invalid('release-artifact-hash-mismatch');
    }
    const actualFiles = await collectReleaseArtifactDigests(root);
    if (JSON.stringify(actualFiles) !== JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))) return invalid('release-artifact-set-mismatch');
    return { valid: true, acquisitionEnabled: true, offlineEnabled: true, reason: 'release-validation-pass' };
  } catch {
    return invalid('release-validation-missing-or-unreadable');
  }
}
