import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function emptyStats(totalMessages = 0) {
  return {
    totalMessages,
    invalidMessageCount: 0,
    distinctSenderCount: totalMessages > 0 ? 2 : 0,
    senderCounts: [],
    unknownSenderMessageCount: 0,
    kindCounts: { text: totalMessages, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
    dailyCounts: totalMessages ? { '2025-01-02': totalMessages } : {},
    unknownTimestampCount: 0,
    invalidTimestampCount: 0
  };
}

function dto(accountId: string, conversationId: string, totalMessages: number) {
  return {
    accountId,
    conversationId,
    scope: 'archived-conversation' as const,
    timeZone: 'Asia/Shanghai' as const,
    stats: emptyStats(totalMessages)
  };
}

async function loadAnalysisRenderer(getConversationStats: ReturnType<typeof vi.fn>) {
  const context = {
    account: { accountId: 'account', source: 'test' },
    conversations: [],
    archivedConversations: [{
      accountId: 'account',
      conversationId: 'conversation',
      title: '合成档案',
      messageCount: 2001
    }],
    collector: { state: 'idle', pages: 0, messages: 0, reason: null },
    repair: { running: false, lastResult: null },
    exporting: false
  };
  const getMessages = vi.fn(async () => Array.from({ length: 500 }, (_, index) => ({
    messagePk: `page-${index}`,
    platformMessageId: `page-${index}`,
    senderId: 'account',
    sentAtMs: 1,
    kind: 'text',
    contentStatus: 'parsed',
    text: `page-body-${index}`
  })));
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
        getMessages,
        getConversationStats,
        getAttachments: async () => [],
        getMediaUrl: async () => null,
        recordMediaEvidence: async () => ({ evidence: {} }),
        retryAttachment: async () => false,
        onEvent: () => () => {}
      }
    });
  });
  const document = loaded.dom.window.document;
  await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(document.getElementById('filterCount')?.textContent).toContain('筛选显示'));
  return { ...loaded, getMessages, document };
}

afterAll(closeRendererFixture);

it('does not query stats without pinned context and hides overview stats off overview', async () => {
  const getConversationStats = vi.fn(async (input: { accountId: string; conversationId: string }) =>
    dto(input.accountId, input.conversationId, 2001));
  const { document, dom, resourceErrors } = await loadAnalysisRenderer(getConversationStats);

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('分析此会话');
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  document.getElementById('analyzeConversation')!.click();
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(1));
  expect(getConversationStats).toHaveBeenCalledWith({ accountId: 'account', conversationId: 'conversation' });
  await vi.waitFor(() => expect(document.getElementById('analysis-stats-total')?.textContent).toBe('2001'));
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-tab-empty')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  expect(getConversationStats).toHaveBeenCalledTimes(2);
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');
  expect(document.getElementById('analysis-tab-empty')?.hasAttribute('hidden')).toBe(false);
  expect(resourceErrors.filter(item => !item.includes('Error loading stylesheet'))).toEqual([]);
  dom.window.close();
});

it('shows full-conversation totals and retries failures for the pinned pair', async () => {
  const pending = deferred<ReturnType<typeof dto>>();
  const getConversationStats = vi.fn()
    .mockImplementationOnce(() => pending.promise)
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue(dto('account', 'conversation', 2001));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);

  document.getElementById('analyzeConversation')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(1));
  expect(getConversationStats).toHaveBeenCalledWith({ accountId: 'account', conversationId: 'conversation' });
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');

  pending.resolve(dto('account', 'conversation', 2001));
  await vi.waitFor(() => expect(document.getElementById('analysis-stats-total')?.textContent).toBe('2001'));
  expect(document.getElementById('analysis-stats-pair')?.textContent).toContain('conversation');

  // Force a failure + retry on the same pinned pair. Leave via AI so the journey tab does not consume this mock.
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('失败'));
  document.getElementById('analysis-stats-retry')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(document.getElementById('analysis-stats-total')?.textContent).toBe('2001'));
  expect(getConversationStats.mock.calls.every(call => call[0].conversationId === 'conversation')).toBe(true);
  dom.window.close();
});

it('renders zero and mismatched dto states without putting bodies into the analysis panel', async () => {
  const getConversationStats = vi.fn()
    .mockResolvedValueOnce(dto('account', 'conversation', 0))
    .mockResolvedValueOnce(dto('wrong', 'conversation', 9));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  document.getElementById('analyzeConversation')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toBe('此会话暂无已归档消息。'));
  expect(document.getElementById('analysis-stats-total')?.textContent).toBe('0');
  const panel = document.getElementById('analysis-tab-panel');
  expect(panel?.textContent).not.toContain('page-body');
  expect(panel?.textContent).not.toContain('SECRET');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('失败'));
  expect(document.getElementById('analysis-stats-total')?.textContent).toBe('—');
  dom.window.close();
});
