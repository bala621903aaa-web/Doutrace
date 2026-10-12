import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer } from './renderer-test-dom.js';

it('calls the attachment retry API from the archive view', async () => {
  const retryAttachment = vi.fn().mockResolvedValue(true);
  const context = {
    account: { accountId: 'account', source: 'test' }, conversations: [],
    archivedConversations: [{ accountId: 'account', conversationId: 'conversation', title: '档案', messageCount: 1 }],
    collector: { state: 'idle' }, repair: { running: false, lastResult: null }, exporting: false
  };
  const { dom } = await loadRenderer(window => {
    Object.assign(window, { desktopArchive: {
        getState: async () => ({ acquisitionEnabled: true, connected: true, browserStatus: '就绪' }),
        getContext: async () => context,
        getMessages: async () => [{ messagePk: 'message', platformMessageId: '1', senderId: 'sender', sentAtMs: 1_700_000_000_000,
          kind: 'image', text: '', contentStatus: 'parsed' }],
        getConversationStats: async (input: { accountId: string; conversationId: string }) => ({
          accountId: input.accountId, conversationId: input.conversationId, scope: 'archived-conversation' as const,
          timeZone: 'Asia/Shanghai' as const,
          stats: { totalMessages: 0, invalidMessageCount: 0, distinctSenderCount: 0, senderCounts: [], unknownSenderMessageCount: 0,
            kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 },
            dailyCounts: {}, unknownTimestampCount: 0, invalidTimestampCount: 0 }
        }),
        getAttachments: async () => [{ id: 'attachment', messagePk: 'message', assetState: 'current', status: 'failed', canRetry: true,
          error: 'attachment-http-404' }],
        retryAttachment,
        onEvent: () => () => {}
    } });
  });
  try {
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-retry="attachment"]')).not.toBeNull());
    dom.window.document.querySelector<HTMLButtonElement>('[data-retry="attachment"]')!.click();
    await vi.waitFor(() => expect(retryAttachment).toHaveBeenCalledWith({ attachmentId: 'attachment' }));
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLButtonElement>('#export')?.disabled).toBe(false));
  } finally { dom.window.close(); }
});

afterAll(closeRendererFixture);
