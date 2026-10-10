import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom';
import { buildRenderer } from '../scripts/build-renderer.mjs';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'doutrace-renderer-build-'));
export const rendererFiles = await buildRenderer({ outDir: join(fixtureRoot, 'renderer') });

export async function closeRendererFixture() {
  await rm(fixtureRoot, { recursive: true, force: true });
}

export async function loadRenderer(beforeParse: (window: DOMWindow) => void) {
  const resourceErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => resourceErrors.push(error.message));
  const html = await readFile(rendererFiles.htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    url: pathToFileURL(rendererFiles.htmlPath).href,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.addEventListener('error', event => {
        const error = event as ErrorEvent;
        resourceErrors.push(error.message || 'renderer-resource-error');
      }, true);
      beforeParse(window);
    }
  });
  await new Promise<void>(resolve => {
    if (dom.window.document.readyState === 'complete') {
      resolve();
      return;
    }
    dom.window.addEventListener('load', () => resolve(), { once: true });
  });
  return { dom, resourceErrors };
}

export function rendererPathFromResourceUrl(url: string) {
  return fileURLToPath(url);
}
