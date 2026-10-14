import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function dto(accountId: string, conversationId: string, stats: Record<string, unknown>) {
  return {
    accountId,
    conversationId,
    scope: 'archived-conversation' as const,
    timeZone: 'Asia/Shanghai' as const,
    stats
  };
}

function baseStats(overrides: Record<string, unknown> = {}) {
  return {
    totalMessages: 15,
    invalidMessageCount: 0,
    distinctSenderCount: 2,
    senderCounts: [],
    unknownSenderMessageCount: 0,
    kindCounts: { text: 12, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
    dailyCounts: { '2024-11-02': 7, '2024-03-08': 5 },
    unknownTimestampCount: 1,
    invalidTimestampCount: 2,
    ...overrides
  };
}

function zeroStats() {
  return baseStats({
    totalMessages: 0,
    distinctSenderCount: 0,
    kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
    dailyCounts: {},
    unknownTimestampCount: 0,
    invalidTimestampCount: 0
  });
}

async function loadAnalysisRenderer(getConversationStats: ReturnType<typeof vi.fn>) {
  const context = {
    account: { accountId: 'account', source: 'test' },
    conversations: [],
    archivedConversations: [{
      accountId: 'account',
      conversationId: 'conversation',
      title: '合成档案',
      messageCount: 12
    }],
    collector: { state: 'idle', pages: 0, messages: 0, reason: null },
    repair: { running: false, lastResult: null },
    exporting: false
  };
  const getMessages = vi.fn(async () => [{
    messagePk: 'page-1',
    platformMessageId: 'page-1',
    senderId: 'account',
    sentAtMs: 1,
    kind: 'text',
    contentStatus: 'parsed',
    text: 'page-body-SECRET'
  }]);
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
  return { ...loaded, document };
}

function pin(document: Document) {
  document.getElementById('analyzeConversation')!.click();
}

afterAll(closeRendererFixture);

it('requests conversation stats only for the journey tab with a pinned pair', async () => {
  const getConversationStats = vi.fn(async (input: { accountId: string; conversationId: string }) =>
    dto(input.accountId, input.conversationId, baseStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('分析此会话');

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  pin(document);
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="interaction"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(3));
  expect(getConversationStats).toHaveBeenLastCalledWith({ accountId: 'account', conversationId: 'conversation' });
  await vi.waitFor(() => expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(false));
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(getConversationStats).toHaveBeenCalledTimes(3);
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toBe('此会话已固定，但没有可用的 AI 服务。检索、模型和持久化尚未授权，当前不会分析，也不会展示示例回答。');
  dom.window.close();
});

it('renders an ascending Shanghai day spine and keeps event trace unauthorized', async () => {
  const getConversationStats = vi.fn(async (input: { accountId: string; conversationId: string }) =>
    dto(input.accountId, input.conversationId, baseStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  pin(document);
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(false));

  const journey = document.getElementById('analysis-journey-content');
  const dayText = document.getElementById('analysis-journey-days')?.textContent ?? '';
  expect(dayText.indexOf('2024-03-08 · 5')).toBeGreaterThanOrEqual(0);
  expect(dayText.indexOf('2024-03-08 · 5')).toBeLessThan(dayText.indexOf('2024-11-02 · 7'));
  expect(document.getElementById('analysis-journey-spine-note')?.textContent).toBe('日级归档脊，不是逐条事件追溯');
  expect(document.getElementById('analysis-journey-scope')?.textContent).toContain('上海时区');
  expect(document.getElementById('analysis-journey-pair')?.textContent).toContain('conversation');
  expect(document.getElementById('analysis-journey-total')?.textContent).toBe('15');
  expect(document.getElementById('analysis-journey-unknown-time')?.textContent).toBe('1');
  expect(document.getElementById('analysis-journey-invalid-time')?.textContent).toBe('2');
  expect(document.getElementById('analysis-journey-events-copy')?.textContent).toContain('尚未授权');
  expect(document.getElementById('analysis-journey-events-copy')?.textContent).toContain('messagePk');
  expect(document.getElementById('analysis-journey-events-copy')?.textContent).toContain('火花提醒');
  expect(journey?.textContent).not.toContain('page-body-SECRET');
  expect(journey?.textContent).not.toContain('关系阶段');
  expect(journey?.textContent).not.toContain('第一次');
  expect(journey?.querySelector('a, button:not(#analysis-journey-retry)')).toBeNull();
  expect(document.getElementById('analysis-tab-empty')?.hasAttribute('hidden')).toBe(true);
  dom.window.close();
});

it('drops an in-flight journey response after leaving the tab', async () => {
  const pending = deferred<ReturnType<typeof dto>>();
  const stale = baseStats({
    totalMessages: 77,
    dailyCounts: { '2020-01-01': 77 },
    unknownTimestampCount: 9,
    invalidTimestampCount: 8
  });
  const getConversationStats = vi.fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(dto('account', 'conversation', baseStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  pin(document);
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(1));
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');
  pending.resolve(dto('account', 'conversation', stale));
  await pending.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-journey-days')?.textContent ?? '').not.toContain('2020-01-01');
  expect(document.getElementById('analysis-journey-total')?.textContent).not.toBe('77');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  expect(getConversationStats).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('analysis-journey-days')?.textContent).toContain('2024-03-08 · 5'));
  expect(document.getElementById('analysis-journey-days')?.textContent).not.toContain('2020-01-01');
  expect(document.getElementById('analysis-journey-total')?.textContent).toBe('15');
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(false);
  dom.window.close();
});

it('covers zero-message, undatable, and failure paths without sample journey events', async () => {
  const undatable = baseStats({
    totalMessages: 4,
    dailyCounts: {},
    unknownTimestampCount: 3,
    invalidTimestampCount: 1
  });
  const getConversationStats = vi.fn()
    .mockResolvedValueOnce(dto('account', 'conversation', zeroStats()))
    .mockResolvedValueOnce(dto('account', 'conversation', undatable))
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(dto('wrong', 'conversation', baseStats()))
    .mockResolvedValue(dto('account', 'conversation', baseStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  pin(document);
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toBe('此会话暂无已归档消息。'));
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-journey-total')?.textContent).toBe('0');
  expect(document.getElementById('analysis-journey-unknown-time')?.textContent).toBe('0');
  expect(document.getElementById('analysis-journey-invalid-time')?.textContent).toBe('0');
  expect(document.getElementById('analysis-journey-days')?.textContent).toContain('没有可按上海时区归日的消息');
  expect(document.getElementById('analysis-journey-events-copy')?.textContent).toContain('尚未授权');
  expect(document.getElementById('analysis-journey-content')?.textContent).not.toContain('page-body-SECRET');
  expect(document.getElementById('analysis-journey-content')?.textContent).not.toContain('关系阶段');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('没有可按上海时区归日的消息'));
  expect(document.getElementById('analysis-journey-total')?.textContent).toBe('4');
  expect(document.getElementById('analysis-journey-unknown-time')?.textContent).toBe('3');
  expect(document.getElementById('analysis-journey-invalid-time')?.textContent).toBe('1');
  expect(document.getElementById('analysis-journey-days')?.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(document.getElementById('analysis-journey-events-copy')?.textContent).toContain('不跳转引用');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('失败'));
  expect(document.getElementById('analysis-journey-retry')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-journey-days')?.textContent).toBe('');
  expect(document.getElementById('analysis-journey-total')?.textContent).toBe('—');
  expect(document.getElementById('analysis-journey-events-copy')?.textContent).toContain('尚未授权');

  document.getElementById('analysis-journey-retry')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('失败'));
  expect(document.getElementById('analysis-journey-days')?.textContent).toBe('');

  document.getElementById('analysis-journey-retry')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(5));
  await vi.waitFor(() => expect(document.getElementById('analysis-journey-days')?.textContent).toContain('2024-03-08 · 5'));
  expect(document.getElementById('analysis-tab-empty')?.hasAttribute('hidden')).toBe(true);
  expect(getConversationStats.mock.calls.every(call => call[0].conversationId === 'conversation')).toBe(true);
  dom.window.close();
});
