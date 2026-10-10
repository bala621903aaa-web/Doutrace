import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { markDevelopmentBuild, clearReleaseValidation, markReleaseBuild } = await import('../scripts/build-mode.mjs') as {
  markDevelopmentBuild: (root: string) => Promise<void>;
  clearReleaseValidation: (root: string) => Promise<void>;
  markReleaseBuild: (root: string) => Promise<void>;
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('development and release build separation', () => {
  it('removes stale release validation and marks a mock-only development build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'douyin-build-mode-'));
    roots.push(root);
    await writeFile(join(root, 'release-validation.json'), '{"valid":true}');
    await markDevelopmentBuild(root);
    await expect(readFile(join(root, 'release-validation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'development-mode.json'), 'utf8')).resolves.toContain('"mockDataOnly":true');
  });

  it('keeps development mode on a failed release gate and clears it after a passing gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'douyin-build-mode-'));
    roots.push(root);
    await markDevelopmentBuild(root);
    await writeFile(join(root, 'release-validation.json'), '{"stale":true}');
    await clearReleaseValidation(root);
    await expect(readFile(join(root, 'development-mode.json'))).resolves.toBeTruthy();
    await expect(readFile(join(root, 'release-validation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await markReleaseBuild(root);
    await expect(readFile(join(root, 'development-mode.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps package scripts and main process guards on their intended paths', async () => {
    const [pkg, rootPkg, releaseScript, main, rendererHtml, rendererJavascript] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../scripts/build-release-validation.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8')
    ]);
    expect(pkg.scripts.dev).toContain('npm run build:dev');
    expect(pkg.scripts['build:dev']).not.toContain('build-release-validation');
    expect(pkg.scripts.build).toContain('build-release-validation.mjs');
    expect(pkg.scripts.build).toContain('node scripts/build-renderer.mjs');
    expect(pkg.scripts['build:dev']).toContain('node scripts/build-renderer.mjs');
    expect(pkg.scripts.package).toContain('npm run build');
    expect(rootPkg.scripts['desktop:build:dev']).toContain('build:dev');
    expect(releaseScript).toContain("summary.overallStatus !== 'pass'");
    expect(releaseScript).toContain('await markReleaseBuild(distRoot)');
    expect(main).toContain("join(dirname(currentDirectory), '.desktop-data', 'mock-dev')");
    expect(main).toContain('if (!releaseValidation.acquisitionEnabled || developmentMode) throw new Error(appState().message)');
    expect(rendererHtml).toContain('<script src="./renderer.js"></script>');
    expect(rendererJavascript).toContain("$('connect').disabled = state.busy || state.context.exporting || repair.running || isRunning() || !state.app?.acquisitionEnabled");
  });
});
