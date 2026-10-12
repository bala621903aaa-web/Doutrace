import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const zeroKinds = {
  text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0
};

function dto(accountId: string, conversationId: string, stats: Record<string, unknown>) {
  return {
    accountId,
    conversationId,
    scope: 'archived-conversation' as const,
    timeZone: 'Asia/Shanghai' as const,
    stats
  };
}

function richStats() {
  return {
    totalMessages: 12,
    invalidMessageCount: 0,
    distinctSenderCount: 2,
    senderCounts: [
      { senderId: 'sender-a', senderName: '甲<script>', count: 8 },
      { senderId: null, senderName: '仅展示名', count: 4 }
    ],
    unknownSenderMessageCount: 0,
    kindCounts: { text: 5, image: 3, voice: 1, 'video-file': 0, 'video-share': 2, emoji: 1, system: 0, unknown: 0 },
    dailyCounts: { '2024-11-02': 7, '2024-03-08': 5 },
    unknownTimestampCount: 0,
    invalidTimestampCount: 0
  };
}

function zeroStats() {
  return {
    totalMessages: 0,
    invalidMessageCount: 0,
    distinctSenderCount: 0,
    senderCounts: [],
    unknownSenderMessageCount: 0,
    kindCounts: zeroKinds,
    dailyCounts: {},
    unknownTimestampCount: 0,
    invalidTimestampCount: 0
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

function pinAndOpen(document: Document, tab: string) {
  document.getElementById('analyzeConversation')!.click();
  document.querySelector<HTMLButtonElement>(`[data-analysis-tab="${tab}"]`)!.click();
}

afterAll(closeRendererFixture);

it('shows the interaction panel only on the interaction tab and only requests a pinned pair', async () => {
  const getConversationStats = vi.fn(async (input: { accountId: string; conversationId: string }) =>
    dto(input.accountId, input.conversationId, richStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="interaction"]')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('分析此会话');

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  document.getElementById('analyzeConversation')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="interaction"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(1));
  expect(getConversationStats).toHaveBeenCalledWith({ accountId: 'account', conversationId: 'conversation' });
  await vi.waitFor(() => expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(false));
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(false));
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(getConversationStats).toHaveBeenCalledTimes(2);
  dom.window.close();
});

it('renders existing kind, day, and sender bucket fields and keeps initiative metrics empty', async () => {
  const getConversationStats = vi.fn(async (input: { accountId: string; conversationId: string }) =>
    dto(input.accountId, input.conversationId, richStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  pinAndOpen(document, 'interaction');
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-kind="text"]')?.textContent).toBe('5'));

  expect(document.querySelector<HTMLElement>('[data-kind="image"]')?.textContent).toBe('3');
  expect(document.querySelector<HTMLElement>('[data-kind="voice"]')?.textContent).toBe('1');
  expect(document.querySelector<HTMLElement>('[data-kind="video-file"]')?.textContent).toBe('0');
  expect(document.querySelector<HTMLElement>('[data-kind="video-share"]')?.textContent).toBe('2');
  expect(document.querySelector<HTMLElement>('[data-kind="emoji"]')?.textContent).toBe('1');
  const dayText = document.getElementById('analysis-interaction-days')?.textContent ?? '';
  expect(dayText.indexOf('2024-03-08 · 5')).toBeGreaterThanOrEqual(0);
  expect(dayText.indexOf('2024-03-08 · 5')).toBeLessThan(dayText.indexOf('2024-11-02 · 7'));
  const senderText = document.getElementById('analysis-interaction-senders')?.textContent ?? '';
  expect(senderText).toContain('统计桶');
  expect(senderText).toContain('senderId sender-a');
  expect(senderText).toContain('分桶依据：senderId');
  expect(senderText).toContain('仅展示名');
  expect(senderText).toContain('senderName 回退（不是身份）');
  expect(document.getElementById('analysis-interaction-bucket-note')?.textContent).toContain('不是双方身份');
  expect(document.getElementById('analysis-interaction-gap-copy')?.textContent).toContain('口径尚未确定');
  expect(document.getElementById('analysis-interaction-gap-copy')?.textContent).toContain('本刀不做');
  const panel = document.getElementById('analysis-tab-panel');
  expect(panel?.textContent).not.toContain('14 个月');
  expect(panel?.textContent).not.toContain('page-body-SECRET');
  expect(panel?.querySelector('script, img')).toBeNull();
  expect(panel?.textContent).toContain('甲<script>');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toBe('AI 洞察尚未提供真实分析服务，不会显示示例回答。');
  dom.window.close();
});

it('drops an in-flight interaction response after leaving the tab', async () => {
  const pending = deferred<ReturnType<typeof dto>>();
  const stale = richStats();
  stale.kindCounts = { ...stale.kindCounts, text: 77 };
  stale.totalMessages = 77;
  const getConversationStats = vi.fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(dto('account', 'conversation', richStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  pinAndOpen(document, 'interaction');
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(1));
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('正在统计');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');
  pending.resolve(dto('account', 'conversation', stale));
  await pending.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-interaction-kinds')?.textContent ?? '').not.toContain('77');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="interaction"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-kind="text"]')?.textContent).toBe('5'));
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(false);
  dom.window.close();
});

it('covers zero-message and failure paths without sample interaction numbers', async () => {
  const getConversationStats = vi.fn()
    .mockResolvedValueOnce(dto('account', 'conversation', zeroStats()))
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(dto('wrong', 'conversation', richStats()))
    .mockResolvedValue(dto('account', 'conversation', richStats()));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);
  pinAndOpen(document, 'interaction');
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toBe('此会话暂无已归档消息。'));
  expect(document.querySelector<HTMLElement>('[data-kind="text"]')?.textContent).toBe('0');
  expect(document.getElementById('analysis-interaction-days')?.textContent).toContain('没有可按上海时区归日的消息');
  expect(document.getElementById('analysis-interaction-senders')?.textContent).toContain('没有发送者统计桶');
  expect(document.getElementById('analysis-interaction-gap-copy')?.textContent).toContain('本刀不做');
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-tab-panel')?.textContent).not.toContain('page-body-SECRET');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="interaction"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('失败'));
  expect(document.getElementById('analysis-interaction-retry')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-interaction-kinds')?.textContent).toBe('');
  expect(document.getElementById('analysis-interaction-gap-copy')?.textContent).toContain('口径尚未确定');

  document.getElementById('analysis-interaction-retry')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('失败'));
  expect(document.querySelector('[data-kind="text"]')).toBeNull();

  document.getElementById('analysis-interaction-retry')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-kind="text"]')?.textContent).toBe('5'));
  expect(getConversationStats.mock.calls.every(call => call[0].conversationId === 'conversation')).toBe(true);
  dom.window.close();
});
