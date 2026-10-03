import { zipSync, strToU8 } from 'fflate';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
async function collect(root, prefix = '') {
  const files = {};
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(files, await collect(`${root}/${e.name}`, `${prefix}${e.name}/`));
    else files[`${prefix}${e.name}`] = new Uint8Array(await readFile(`${root}/${e.name}`));
  }
  return files;
}
const files = await collect('dist', 'douyin-chat-archive/');
files['安装说明.md'] = strToU8(await readFile('public/README.md', 'utf8'));
await mkdir('release', { recursive: true });
await writeFile('release/douyin-chat-archive-0.2.0.zip', zipSync(files));
console.log('Packaged release/douyin-chat-archive-0.2.0.zip');
