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

describe('DouyinHistoryAdapter.listConversationDirectory', () => {
  it('returns parsed conversation directory when page is trusted', async () => {
    const page = {
      url: () => 'https://www.douyin.com/chat?isPopup=1',
      evaluate: vi.fn(async () => [
        { conversationId: 'conv-1', title: 'User 1', participantIds: ['u1'] },
        { conversationId: 'conv-2', title: '', participantIds: [] }
      ])
    };
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { page: typeof page };
      templates: Map<string, unknown>;
      listConversationDirectory(): Promise<unknown>;
    };
    adapter.closed = false;
    adapter.session = { page };
    adapter.templates = new Map();

    const result = await adapter.listConversationDirectory();
    expect(result).toEqual([
      { conversationId: 'conv-1', title: 'User 1', participantIds: ['u1'], source: 'douyin.conversationStore-or-dom' },
      { conversationId: 'conv-2', title: 'conv-2', participantIds: [], source: 'douyin.conversationStore-or-dom' }
    ]);
  });

  it('rejects with history-page-context-untrusted when page is untrusted', async () => {
    const page = {
      url: () => 'https://untrusted.example/chat',
      evaluate: vi.fn()
    };
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { page: typeof page };
      templates: Map<string, unknown>;
      listConversationDirectory(): Promise<unknown>;
    };
    adapter.closed = false;
    adapter.session = { page };
    adapter.templates = new Map();

    await expect(adapter.listConversationDirectory()).rejects.toThrow('history-page-context-untrusted');
  });

  it('does not throw and returns empty array when directory is empty', async () => {
    const page = {
      url: () => 'https://www.douyin.com/chat?isPopup=1',
      evaluate: vi.fn(async () => [])
    };
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { page: typeof page };
      templates: Map<string, unknown>;
      listConversationDirectory(): Promise<unknown>;
    };
    adapter.closed = false;
    adapter.session = { page };
    adapter.templates = new Map();

    await expect(adapter.listConversationDirectory()).resolves.toEqual([]);
  });
});

describe('DouyinHistoryAdapter.selectConversationInBrowser', () => {
  function makeMockPageState(selectedId: string) {
    return {
      origin: 'https://www.douyin.com',
      pathname: '/chat',
      selectedConversationIds: [selectedId],
      selectedTitle: 'Selected User',
      messageList: { found: false, scrollTop: null, scrollHeight: null, clientHeight: null, rowCount: 0 },
      rows: []
    };
  }

  it('resolves after finding target in DOM, clicking, and polling matching selected ID', async () => {
    const mainFrame = {
      evaluate: vi.fn(async () => makeMockPageState('conv-target'))
    };
    const page = {
      url: () => 'https://www.douyin.com/chat?isPopup=1',
      mainFrame: () => mainFrame,
      evaluate: vi.fn(async () => true)
    };
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { page: typeof page };
      templates: Map<string, unknown>;
      selectConversationInBrowser(id: string, timeoutMs?: number): Promise<void>;
    };
    adapter.closed = false;
    adapter.session = { page };
    adapter.templates = new Map();

    await expect(adapter.selectConversationInBrowser('conv-target')).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), 'conv-target');
  });

  it('throws browser-conversation-not-visible when target is not in DOM', async () => {
    const mainFrame = {
      evaluate: vi.fn()
    };
    const page = {
      url: () => 'https://www.douyin.com/chat?isPopup=1',
      mainFrame: () => mainFrame,
      evaluate: vi.fn(async () => false)
    };
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { page: typeof page };
      templates: Map<string, unknown>;
      selectConversationInBrowser(id: string, timeoutMs?: number): Promise<void>;
    };
    adapter.closed = false;
    adapter.session = { page };
    adapter.templates = new Map();

    await expect(adapter.selectConversationInBrowser('conv-missing')).rejects.toThrow('browser-conversation-not-visible');
  });

  it('throws browser-select-conversation-timeout when polling does not match within timeout', async () => {
    const mainFrame = {
      evaluate: vi.fn(async () => makeMockPageState('conv-different'))
    };
    const page = {
      url: () => 'https://www.douyin.com/chat?isPopup=1',
      mainFrame: () => mainFrame,
      evaluate: vi.fn(async () => true)
    };
    const adapter = Object.create(DouyinHistoryAdapter.prototype) as unknown as {
      closed: boolean;
      session: { page: typeof page };
      templates: Map<string, unknown>;
      selectConversationInBrowser(id: string, timeoutMs?: number): Promise<void>;
    };
    adapter.closed = false;
    adapter.session = { page };
    adapter.templates = new Map();

    await expect(adapter.selectConversationInBrowser('conv-target', 200)).rejects.toThrow('browser-select-conversation-timeout');
  });
});
