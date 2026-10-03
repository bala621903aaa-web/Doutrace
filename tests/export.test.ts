import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { makeArchive } from '../src/export';
import type { Attachment, Conversation } from '../src/types';
describe('offline export', () => {
  it('creates portable files, escapes untrusted message text, and omits temporary URLs', async () => {
    const c: Conversation = { key: 'c', title: '<img src=x onerror=alert(1)>', messages: [{ ref: 'm-one', platformId: '1', sender: '<script>bad()</script>', side: 'other', timestamp: null, timeText: '昨天', kind: 'text', text: '<script>alert(1)</script>', media: [], fingerprint: 'f', capturedAt: '' }], runs: [{ id: 'r', startedAt: '', mode: 'loaded', batches: 1, added: 1, reason: 'loaded_only' }], warnings: [], updatedAt: '' };
    const attachments: Attachment[] = [{ id: 'm-one-0', kind: 'audio', quality: 'unknown', status: 'failed', attempts: 3, error: 'CORS' }];
    const archive = await makeArchive(c, attachments).zip();
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['export-report.json', 'index.html', 'messages.json']);
    const html = strFromU8(files['index.html']);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(strFromU8(files['messages.json'])).toContain('m-one');
    expect(strFromU8(files['export-report.json'])).toContain('CORS');
  });
});
