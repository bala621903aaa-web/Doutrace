import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererSource = resolve(desktopRoot, 'src', 'renderer');

/**
 * @param {{ outDir?: string }} [options]
 */
export async function buildRenderer(options = {}) {
  const outDir = resolve(options.outDir ?? resolve(desktopRoot, 'dist', 'renderer'));
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [
      resolve(rendererSource, 'renderer.js'),
      resolve(rendererSource, 'renderer.css')
    ],
    outdir: outDir,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2022'],
    logLevel: 'silent'
  });
  await copyFile(resolve(rendererSource, 'index.html'), resolve(outDir, 'index.html'));
  return {
    htmlPath: resolve(outDir, 'index.html'),
    javascriptPath: resolve(outDir, 'renderer.js'),
    stylesheetPath: resolve(outDir, 'renderer.css')
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRenderer({ outDir: process.argv[2] ? resolve(process.argv[2]) : undefined });
}
