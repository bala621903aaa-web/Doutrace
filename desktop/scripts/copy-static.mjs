import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, 'dist', 'renderer'), { recursive: true });
await cp(resolve(root, 'src', 'preload.cjs'), resolve(root, 'dist', 'preload.cjs'), { force: true });
await cp(resolve(root, 'src', 'renderer', 'index.html'), resolve(root, 'dist', 'renderer', 'index.html'), { force: true });
