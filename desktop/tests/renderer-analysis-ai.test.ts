import { readFile } from 'node:fs/promises';
import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

const NO_CONTEXT = '请先在聊天档案中选择会话，点击「分析此会话」。检索、模型和持久化尚未授权，当前不会分析，也不会展示示例回答。';
const PINNED_EMPTY = '此会话已固定，但没有可用的 AI 服务。检索、模型和持久化尚未授权，当前不会分析，也不会展示示例回答。';

function dto(accountId: string, conversationId: string) {
  return {
    accountId,
    conversationId,
    scope: 'archived-conversation' as const,
    timeZone: 'Asia/Shanghai' as const,
    stats: {
      totalMessages: 2001,
      invalidMessageCount: 0,
      distinctSenderCount: 2,
      senderCounts: [],
      unknownSenderMessageCount: 0,
      kindCounts: { text: 2001, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
      dailyCounts: { '2024-03-08': 2001 },
      unknownTimestampCount: 0,
      invalidTimestampCount: 0
    }
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

function expectNoFakeAnswer(document: Document) {
  const panel = document.getElementById('analysis-ai-content');
  expect(panel).not.toBeNull();
  expect(document.querySelector('#analysis-ai-answer, #analysis-ai-sample, [data-ai-answer], .analysis-ai-answer, .analysis-ai-sample')).toBeNull();
  const text = panel?.textContent ?? '';
  expect(text).toContain('检索');
  expect(text).toContain('模型');
  expect(text).toContain('持久化');
  expect(text).toContain('尚未授权');
  expect(text).toContain('不会分析');
  expect(text).toContain('不会展示示例回答');
  expect(text).not.toContain('page-body-SECRET');
  expect(text).not.toContain('2001');
  expect(text).not.toMatch(/问：|答：|示例回答：/);
  expect(text).not.toContain('关系阶段');
  expect(panel?.querySelector('script, img, a, button')).toBeNull();
}

afterAll(closeRendererFixture);

it('keeps the AI shell local: no stats request, no new IPC, and no sample answer', async () => {
  const [aiSource, preload, main] = await Promise.all([
    readFile(new URL('../src/renderer/analysis-ai.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  ]);
  expect(aiSource).not.toMatch(/getConversationStats\s*\(/);
  expect(aiSource).not.toMatch(/\bfetch\s*\(/);
  expect(aiSource).not.toContain('ipcRenderer');
  expect(aiSource).not.toContain('XMLHttpRequest');
  expect(preload).not.toContain('archive-ai');
  expect(main).not.toContain('archive-ai');

  const getConversationStats = vi.fn(async (input: { accountId: string; conversationId: string }) =>
    dto(input.accountId, input.conversationId));
  const { document, dom } = await loadAnalysisRenderer(getConversationStats);

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.getElementById('analysis-tab-empty')?.textContent).toBe(NO_CONTEXT);
  expect(document.getElementById('analysis-ai-content')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-ai-state')?.textContent).toContain('分析此会话');
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expectNoFakeAnswer(document);

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  document.getElementById('analyzeConversation')!.click();
  expect(getConversationStats).not.toHaveBeenCalled();
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toBe(PINNED_EMPTY);
  expect(document.getElementById('analysis-ai-state')?.textContent).toContain('账号 account');
  expect(document.getElementById('analysis-ai-state')?.textContent).toContain('会话 conversation');
  expect(document.getElementById('analysis-ai-state')?.textContent).toContain('没有可用的 AI 服务');
  expect(document.getElementById('analysis-ai-content')?.hasAttribute('hidden')).toBe(false);
  expectNoFakeAnswer(document);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="overview"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(false));
  expect(document.getElementById('analysis-ai-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(getConversationStats).toHaveBeenCalledTimes(1);
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-ai-content')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('analysis-tab-empty')?.textContent).toBe(PINNED_EMPTY);
  expectNoFakeAnswer(document);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="interaction"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(false));
  expect(document.getElementById('analysis-ai-content')?.hasAttribute('hidden')).toBe(true);

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="journey"]')!.click();
  await vi.waitFor(() => expect(getConversationStats).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(false));
  expect(document.getElementById('analysis-ai-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-journey-days')?.textContent).toContain('2024-03-08 · 2001');

  document.querySelector<HTMLButtonElement>('[data-analysis-tab="ai"]')!.click();
  expect(getConversationStats).toHaveBeenCalledTimes(3);
  expect(document.getElementById('analysis-journey-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('analysis-tab-empty')?.hasAttribute('hidden')).toBe(false);
  expectNoFakeAnswer(document);
  dom.window.close();
});
