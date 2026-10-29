import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

describe('renderer conversation picker directory and selection', () => {
  const baseAccount = { accountId: 'test-account', source: 'test' };

  it('renders updated sidebar titles, footnotes, and empty text', async () => {
    const { dom } = await loadRenderer(window => {
      Object.assign(window, {
        desktopArchive: {
          getState: async () => ({ acquisitionEnabled: true, connected: false, browserStatus: '离线' }),
          getContext: async () => ({
            account: null,
            conversations: [],
            archivedConversations: [],
            collector: { state: 'idle' },
            repair: { running: false, lastResult: null },
            exporting: false
          }),
          getMessages: async () => [],
          getConversationStats: async () => ({
            stats: { totalMessages: 0, invalidMessageCount: 0, distinctSenderCount: 0, senderCounts: [], unknownSenderMessageCount: 0,
              kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
              dailyCounts: {}, unknownTimestampCount: 0, invalidTimestampCount: 0 }
          }),
          getAttachments: async () => [],
          onEvent: () => () => {}
        }
      });
    });

    try {
      const doc = dom.window.document;
      const heading = doc.querySelector('.archive-sidebar__section--current h2');
      expect(heading?.textContent).toBe('可采集的联系人');

      const footnote = doc.querySelector('.archive-sidebar__footnote');
      expect(footnote?.textContent).toBe('仅显示已保存的档案和浏览器中可见的联系人；点击联系人可自动切换采集目标。');

      const empty = doc.querySelector('#conversations .empty');
      expect(empty?.textContent).toBe('连接浏览器并刷新后，此处显示所有可采集的联系人。');
    } finally {
      dom.window.close();
    }
  });

  it('triggers api.selectConversation and applies conversation--switching class when connected and acquisitionEnabled=true', async () => {
    let resolveSelect: (val: any) => void;
    const selectPromise = new Promise(resolve => {
      resolveSelect = resolve;
    });
    const selectConversation = vi.fn().mockImplementation(() => selectPromise);

    const initialContext = {
      account: baseAccount,
      conversations: [
        { conversationId: 'conv-1', title: '联系人 1', participantIds: ['p1'], source: 'directory' }
      ],
      archivedConversations: [],
      collector: { state: 'idle' },
      repair: { running: false, lastResult: null },
      exporting: false
    };

    const updatedContext = {
      ...initialContext,
      conversations: [
        { conversationId: 'conv-1', title: '联系人 1 (已切换)', participantIds: ['p1'], source: 'selected' }
      ]
    };

    const { dom } = await loadRenderer(window => {
      Object.assign(window, {
        desktopArchive: {
          getState: async () => ({ acquisitionEnabled: true, connected: true, browserStatus: '就绪' }),
          getContext: async () => initialContext,
          selectConversation,
          getMessages: async () => [],
          getConversationStats: async () => ({
            stats: { totalMessages: 0, invalidMessageCount: 0, distinctSenderCount: 0, senderCounts: [], unknownSenderMessageCount: 0,
              kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
              dailyCounts: {}, unknownTimestampCount: 0, invalidTimestampCount: 0 }
          }),
          getAttachments: async () => [],
          onEvent: () => () => {}
        }
      });
    });

    try {
      const doc = dom.window.document;
      await vi.waitFor(() => expect(doc.querySelector('[data-conversation="conv-1"]')).not.toBeNull());
      const button = doc.querySelector<HTMLButtonElement>('[data-conversation="conv-1"]')!;

      button.click();

      expect(selectConversation).toHaveBeenCalledWith({ conversationId: 'conv-1' });
      expect(button.classList.contains('conversation--switching')).toBe(true);

      // Resolve the pending switch
      resolveSelect!(updatedContext);

      // After settlement, reader updates
      await vi.waitFor(() => {
        const title = doc.querySelector('#archiveTitle');
        expect(title?.textContent).toBe('联系人 1 (已切换)');
      });
    } finally {
      dom.window.close();
    }
  });

  it('does not call api.selectConversation when browser is not connected', async () => {
    const selectConversation = vi.fn();
    const context = {
      account: null,
      conversations: [
        { conversationId: 'conv-offline', title: '离线联系人', participantIds: [], source: 'cached' }
      ],
      archivedConversations: [],
      collector: { state: 'idle' },
      repair: { running: false, lastResult: null },
      exporting: false
    };

    const { dom } = await loadRenderer(window => {
      Object.assign(window, {
        desktopArchive: {
          getState: async () => ({ acquisitionEnabled: true, connected: false, browserStatus: '未连接' }),
          getContext: async () => context,
          selectConversation,
          getMessages: async () => [],
          getConversationStats: async () => ({
            stats: { totalMessages: 0, invalidMessageCount: 0, distinctSenderCount: 0, senderCounts: [], unknownSenderMessageCount: 0,
              kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
              dailyCounts: {}, unknownTimestampCount: 0, invalidTimestampCount: 0 }
          }),
          getAttachments: async () => [],
          onEvent: () => () => {}
        }
      });
    });

    try {
      const doc = dom.window.document;
      await vi.waitFor(() => expect(doc.querySelector('[data-conversation="conv-offline"]')).not.toBeNull());
      const button = doc.querySelector<HTMLButtonElement>('[data-conversation="conv-offline"]')!;

      button.click();

      expect(selectConversation).not.toHaveBeenCalled();
      expect(button.classList.contains('conversation--switching')).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('restores button state and shows error status if api.selectConversation fails', async () => {
    const selectConversation = vi.fn().mockRejectedValue(new Error('browser-select-conversation-timeout'));
    const context = {
      account: baseAccount,
      conversations: [
        { conversationId: 'conv-fail', title: '超时联系人', participantIds: [], source: 'directory' }
      ],
      archivedConversations: [],
      collector: { state: 'idle' },
      repair: { running: false, lastResult: null },
      exporting: false
    };

    const { dom } = await loadRenderer(window => {
      Object.assign(window, {
        desktopArchive: {
          getState: async () => ({ acquisitionEnabled: true, connected: true, browserStatus: '就绪' }),
          getContext: async () => context,
          selectConversation,
          getMessages: async () => [],
          getConversationStats: async () => ({
            stats: { totalMessages: 0, invalidMessageCount: 0, distinctSenderCount: 0, senderCounts: [], unknownSenderMessageCount: 0,
              kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
              dailyCounts: {}, unknownTimestampCount: 0, invalidTimestampCount: 0 }
          }),
          getAttachments: async () => [],
          onEvent: () => () => {}
        }
      });
    });

    try {
      const doc = dom.window.document;
      await vi.waitFor(() => expect(doc.querySelector('[data-conversation="conv-fail"]')).not.toBeNull());
      const button = doc.querySelector<HTMLButtonElement>('[data-conversation="conv-fail"]')!;

      button.click();

      await vi.waitFor(() => {
        expect(button.classList.contains('conversation--switching')).toBe(false);
        const status = doc.querySelector('#status');
        expect(status?.textContent).toContain('browser-select-conversation-timeout');
      });
    } finally {
      dom.window.close();
    }
  });
});

afterAll(closeRendererFixture);
