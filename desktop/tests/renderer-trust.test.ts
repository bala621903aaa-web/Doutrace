import { describe, expect, it } from 'vitest';
import { assertTrustedArchiveSender } from '../src/core/renderer-trust.js';

const entryUrl = 'file:///archive/dist/renderer/index.html';

describe('archive IPC sender boundary', () => {
  it('accepts only the active archive main frame at its packaged entry URL', () => {
    const mainFrame = { url: entryUrl };
    const webContents = { mainFrame };
    const window = { webContents };

    expect(() => assertTrustedArchiveSender({ sender: webContents, senderFrame: mainFrame }, window, entryUrl)).not.toThrow();
    expect(() => assertTrustedArchiveSender({ sender: webContents, senderFrame: { url: entryUrl } }, window, entryUrl)).toThrow('archive-renderer-untrusted');
    expect(() => assertTrustedArchiveSender({ sender: webContents, senderFrame: mainFrame }, undefined, entryUrl)).toThrow('archive-renderer-untrusted');
    expect(() => assertTrustedArchiveSender({ sender: { mainFrame }, senderFrame: mainFrame }, window, entryUrl)).toThrow('archive-renderer-untrusted');
    mainFrame.url = 'https://example.com/';
    expect(() => assertTrustedArchiveSender({ sender: webContents, senderFrame: mainFrame }, window, entryUrl)).toThrow('archive-renderer-untrusted');
  });
});
