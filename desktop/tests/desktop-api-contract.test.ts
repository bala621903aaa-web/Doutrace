import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('desktop IPC contract wiring', () => {
  it('keeps repair, cancellation, attachment retry, and export APIs connected across types, preload, and main', async () => {
    const [api, preload, main] = await Promise.all([
      readFile(new URL('../src/core/desktop-api.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'),
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
    ]);
    const methods = [
      ['repairConversation', 'archive-repair-conversation'],
      ['cancelRepair', 'archive-cancel-repair'],
      ['retryAttachment', 'archive-retry-attachment'],
      ['recordMediaEvidence', 'archive-record-media-evidence'],
      ['exportConversation', 'archive-export']
    ] as const;
    for (const [method, channel] of methods) {
      expect(api).toContain(`${method}(`);
      expect(preload).toContain(`${method}:`);
      expect(preload).toContain(`'${channel}'`);
      expect(main).toContain(`handleArchive('${channel}'`);
    }
    expect(main).toContain('assertTrustedArchiveSender(event, windowInstance, rendererEntryUrl)');
  });

  it('wires the deterministic stop-after-page control through the capture IPC contract', async () => {
    const [api, preload, main, rendererHtml, rendererJavascript] = await Promise.all([
      readFile(new URL('../src/core/desktop-api.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'),
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8')
    ]);
    expect(api).toContain('stopAfterPages?: number');
    expect(preload).toContain('startCapture:');
    expect(preload).toContain("'archive-start-capture'");
    expect(main).toContain('stopAfterPages?: number');
    expect(main).toContain('单次自动停止仅支持提交下一页后停止。');
    expect(rendererHtml).toContain('id="stopAfterNextPage"');
    expect(rendererJavascript).toContain("$('stopAfterNextPage').checked?1:undefined");
  });
});
