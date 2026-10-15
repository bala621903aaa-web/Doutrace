import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

const pair = { accountId: 'synthetic-account', conversationId: 'synthetic-conversation' };
const panelIds = ['analysis-stats-content', 'analysis-interaction-content', 'analysis-journey-content'] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function dto(totalMessages: number) {
  return {
    ...pair,
    scope: 'archived-conversation',
    timeZone: 'Asia/Shanghai',
    stats: {
      totalMessages,
      invalidMessageCount: 0,
      distinctSenderCount: totalMessages ? 2 : 0,
      senderCounts: [],
      unknownSenderMessageCount: 0,
      kindCounts: { text: totalMessages, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
      dailyCounts: totalMessages ? { '2025-01-02': totalMessages } : {},
      unknownTimestampCount: 0,
      invalidTimestampCount: 0
    }
  };
}

async function openRenderer(getConversationStats: ReturnType<typeof vi.fn>) {
  const context = {
    account: { accountId: pair.accountId, source: 'test' },
    conversations: [],
    archivedConversations: [{ ...pair, title: '合成档案', messageCount: 520 }],
    collector: { state: 'idle', pages: 0, messages: 0, reason: null },
    repair: { running: false, lastResult: null },
    exporting: false
  };
  const loaded = await loadRenderer(window => {
    Object.assign(window, {
      CSS: { escape: (value: string) => value },
      desktopArchive: {
        getState: async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '隔离合成档案' }),
        getContext: async () => context,
        connect: async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '隔离合成档案' }),
        refreshContext: async () => context,
        startCapture: async () => ({ state: 'idle' }),
        stopCapture: async () => ({ state: 'idle' }),
        repairConversation: async () => ({}),
        cancelRepair: async () => undefined,
        exportConversation: async () => ({ cancelled: true }),
        getMessages: async () => [],
        getConversationStats,
        getAttachments: async () => [],
        getMediaUrl: async () => null,
        recordMediaEvidence: async () => ({ evidence: {} }),
        retryAttachment: async () => false,
        onEvent: () => () => {}
      }
    });
  });
  const { document } = loaded.dom.window;
  await vi.waitFor(() => expect(document.getElementById('analyzeConversation')?.hasAttribute('disabled')).toBe(false));
  return { ...loaded, document };
}

function click(document: Document, selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click();
}

function expectVisible(document: Document, ...visibleIds: string[]) {
  const { defaultView } = document;
  expect(defaultView).not.toBeNull();
  for (const id of ['analysis-tab-empty', ...panelIds]) {
    const element = document.getElementById(id)!;
    expect(defaultView!.getComputedStyle(element).display, id).toBe(visibleIds.includes(id) ? 'grid' : 'none');
  }
}

afterAll(closeRendererFixture);

it('loads disk CSS and displays only the active analysis state through all four tabs', async () => {
  const pending = Array.from({ length: 3 }, () => deferred<ReturnType<typeof dto>>());
  const getConversationStats = vi.fn()
    .mockImplementationOnce(() => pending[0].promise)
    .mockImplementationOnce(() => pending[1].promise)
    .mockImplementationOnce(() => pending[2].promise);
  const { document, dom, resourceErrors } = await openRenderer(getConversationStats);

  expect(resourceErrors).toEqual([]);
  click(document, '[data-route="analysis"]');
  expectVisible(document, 'analysis-tab-empty');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('分析此会话');
  click(document, '[data-route="archive"]');
  click(document, '#analyzeConversation');
  expectVisible(document, 'analysis-tab-empty');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('AI 洞察');

  for (const [index, tab, contentId] of [
    [0, 'overview', 'analysis-stats-content'],
    [1, 'interaction', 'analysis-interaction-content'],
    [2, 'journey', 'analysis-journey-content']
  ] as const) {
    click(document, `[data-analysis-tab="${tab}"]`);
    await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(index + 1));
    expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');
    expectVisible(document, 'analysis-tab-empty');
    pending[index].resolve(dto(520));
    await vi.waitFor(() => expect(document.getElementById(contentId)?.hidden).toBe(false));
    expectVisible(document, contentId);
    expect(document.getElementById('analysis-tab-empty')?.hidden).toBe(true);
    if (tab === 'overview') expect(document.getElementById('analysis-stats-total')?.textContent).toBe('520');
  }

  click(document, '[data-analysis-tab="ai"]');
  expectVisible(document, 'analysis-tab-empty');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未提供真实分析服务');
  click(document, '[data-route="media"]');
  expect(dom.window.getComputedStyle(document.getElementById('chat-analysis-page')!).display).toBe('none');
  expect(dom.window.getComputedStyle(document.getElementById('media-page')!).display).toBe('grid');
  dom.window.close();
});

it('keeps failure, retry loading, and empty states visibly exclusive', async () => {
  const retry = deferred<ReturnType<typeof dto>>();
  const getConversationStats = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic failure'))
    .mockImplementationOnce(() => retry.promise)
    .mockResolvedValueOnce(dto(0));
  const { document, dom, resourceErrors } = await openRenderer(getConversationStats);
  expect(resourceErrors).toEqual([]);
  click(document, '#analyzeConversation');
  click(document, '[data-analysis-tab="overview"]');
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('加载失败'));
  expectVisible(document, 'analysis-tab-empty', 'analysis-stats-content');
  expect(dom.window.getComputedStyle(document.getElementById('analysis-stats-retry')!).display).not.toBe('none');

  click(document, '#analysis-stats-retry');
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');
  expectVisible(document, 'analysis-tab-empty');
  retry.resolve(dto(0));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('暂无已归档消息'));
  expect(dom.window.getComputedStyle(document.getElementById('analysis-stats-content')!).display).toBe('grid');
  expect(dom.window.getComputedStyle(document.getElementById('analysis-tab-empty')!).display).toBe('grid');
  expect(dom.window.getComputedStyle(document.getElementById('analysis-stats-retry')!).display).toBe('none');

  click(document, '[data-analysis-tab="interaction"]');
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(document.getElementById('analysis-interaction-content')?.hidden).toBe(false));
  expect(dom.window.getComputedStyle(document.getElementById('analysis-stats-content')!).display).toBe('none');
  expect(dom.window.getComputedStyle(document.getElementById('analysis-interaction-content')!).display).toBe('grid');
  dom.window.close();
});

it.each([
  ['interaction', 'analysis-interaction-content', 'analysis-interaction-retry'],
  ['journey', 'analysis-journey-content', 'analysis-journey-retry']
] as const)('shows visible failure, retry loading, and zero state on %s', async (tab, contentId, retryId) => {
  const pending = deferred<ReturnType<typeof dto>>();
  const getConversationStats = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic failure'))
    .mockImplementationOnce(() => pending.promise);
  const { document, dom, resourceErrors } = await openRenderer(getConversationStats);
  expect(resourceErrors).toEqual([]);
  click(document, '#analyzeConversation');
  click(document, `[data-analysis-tab="${tab}"]`);
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('加载失败'));
  expectVisible(document, 'analysis-tab-empty', contentId);
  expect(dom.window.getComputedStyle(document.getElementById(retryId)!).display).not.toBe('none');

  click(document, `#${retryId}`);
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');
  expectVisible(document, 'analysis-tab-empty');
  pending.resolve(dto(0));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('暂无已归档消息'));
  expectVisible(document, 'analysis-tab-empty', contentId);
  expect(dom.window.getComputedStyle(document.getElementById(retryId)!).display).toBe('none');
  dom.window.close();
});
