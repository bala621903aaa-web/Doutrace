import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(desktopRoot, 'dist');

export async function markDevelopmentBuild(root) {
  await rm(resolve(root, 'release-validation.json'), { force: true });
  await writeFile(resolve(root, 'development-mode.json'), JSON.stringify({ kind: 'development-mode', mockDataOnly: true }) + '\n');
}

export async function clearReleaseValidation(root) {
  await rm(resolve(root, 'release-validation.json'), { force: true });
}

export async function markReleaseBuild(root) {
  await rm(resolve(root, 'development-mode.json'), { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'dev') throw new Error('build-mode: expected dev');
  await markDevelopmentBuild(distRoot);
}
