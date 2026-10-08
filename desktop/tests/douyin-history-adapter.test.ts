import { describe, expect, it, vi } from 'vitest';
import { DouyinHistoryAdapter, type BrowserHistoryAdapterOptions } from '../src/adapters/douyin-history-adapter.js';
import type { HistoryNetworkObserver } from '../src/probe/history-transport.js';
import type { BrowserProbeSession } from '../src/probe/session.js';

describe('Douyin history adapter page-context invalidation', () => {
  it('clears cached request templates and invalidates the selected context on main-frame navigation', () => {
    const mainFrame = {};
    let onNavigated: ((frame: unknown) => void) | undefined;
    const page = {
      mainFrame: () => mainFrame,
      on: (event: string, listener: (frame: unknown) => void) => {
        if (event === 'framenavigated') onNavigated = listener;
      }
    };
    let selectedConversation: string | null = 'private-conversation';
    const onContextInvalidated = vi.fn(() => { selectedConversation = null; });
    const Constructor = DouyinHistoryAdapter as unknown as new (
      session: BrowserProbeSession,
      observer: HistoryNetworkObserver,
      options: BrowserHistoryAdapterOptions
    ) => DouyinHistoryAdapter;
    const adapter = new Constructor({ page } as unknown as BrowserProbeSession, {} as HistoryNetworkObserver, { onContextInvalidated });
    const internal = adapter as unknown as { templates: Map<string, unknown> };
    internal.templates.set('private-conversation', { body: new Uint8Array([1, 2, 3]) });

    onNavigated!(mainFrame);

    expect(internal.templates.size).toBe(0);
    expect(onContextInvalidated).toHaveBeenCalledOnce();
    expect(selectedConversation).toBeNull();
  });
});

describe('Douyin history adapter media URL boundary', () => {
  it('does not follow redirects when fetching allowlisted attachment URLs', async () => {
    const dispose = vi.fn(async () => {});
    const get = vi.fn(async () => ({
      ok: () => true,
      status: () => 200,
      body: async () => new Uint8Array([1, 2, 3]),
      headers: () => ({ 'content-type': 'image/png' }),
      dispose
    }));
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { context: { request: { get: typeof get } } };
      downloadAttachment(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>;
    };
    adapter.closed = false;
    adapter.session = { context: { request: { get } } };

    await expect(adapter.downloadAttachment('https://cdn.douyinpic.com/image.png')).resolves.toMatchObject({ mime: 'image/png' });
    expect(get).toHaveBeenCalledWith('https://cdn.douyinpic.com/image.png', expect.objectContaining({ maxRedirects: 0 }));
    expect(dispose).toHaveBeenCalledOnce();
    await expect(adapter.downloadAttachment('https://attacker.example/image.png')).rejects.toThrow('attachment-url-not-allowed');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
