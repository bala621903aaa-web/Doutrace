import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/background.ts', 'src/content.ts', 'src/app.ts'], bundle: true, outdir: 'dist', format: 'iife', target: 'chrome120', sourcemap: false });
await cp('public', 'dist', { recursive: true });
console.log('Built unpacked extension: dist/');
