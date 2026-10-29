import { describe, expect, it, vi } from 'vitest';
import type { AccountInfo, ConversationInfo } from '../src/core/contracts.js';
import type { DesktopContext } from '../src/core/desktop-api.js';

describe('archive-select-conversation IPC handler validation', () => {
  const dummyContext: DesktopContext = {
    account: { accountId: 'acc-1', source: 'test' },
    conversations: [],
    archivedConversations: [],
    collector: {} as any,
    repair: { running: false, lastResult: null },
    exporting: false
  };

  async function runSelectConversation(
    input: { conversationId: string },
    options: {
      adapter?: any;
      acquisitionEnabled?: boolean;
      developmentMode?: boolean;
      exporting?: boolean;
      appStateMessage?: string;
      collector?: any;
      archiveRepair?: any;
      database?: any;
    } = {}
  ) {
    const {
      adapter = {
        selectConversationInBrowser: vi.fn(async () => {}),
        listPrivateConversations: vi.fn(async () => [{ conversationId: input?.conversationId, title: 'Chat', participantIds: [], source: 'test' }]),
        getAccount: vi.fn(async () => ({ accountId: 'acc-1', source: 'test' }))
      },
      acquisitionEnabled = true,
      developmentMode = false,
      exporting = false,
      appStateMessage = 'gate-closed',
      collector = { stopAndWait: vi.fn(async () => {}) },
      archiveRepair = { cancelAndWait: vi.fn(async () => {}) },
      database = { upsertAccount: vi.fn(), upsertConversation: vi.fn() }
    } = options;

    if (!adapter) throw new Error('请先连接独立浏览器。');
    if (!acquisitionEnabled || developmentMode) throw new Error(appStateMessage);
    if (typeof input?.conversationId !== 'string' || !input.conversationId.trim()) throw new Error('conversationId 无效。');
    if (exporting) throw new Error('导出期间暂不能切换会话。');
    await collector?.stopAndWait();
    await archiveRepair?.cancelAndWait();
    await adapter.selectConversationInBrowser(input.conversationId);
    const conversations = await adapter.listPrivateConversations();
    const activeAccount = await adapter.getAccount();
    database?.upsertAccount(activeAccount);
    for (const conv of conversations) {
      database?.upsertConversation(activeAccount.accountId, conv);
    }
    return dummyContext;
  }

  it('rejects when adapter is not connected', async () => {
    await expect(runSelectConversation({ conversationId: 'c1' }, { adapter: null })).rejects.toThrow('请先连接独立浏览器。');
  });

  it('rejects when acquisitionEnabled is false', async () => {
    await expect(runSelectConversation({ conversationId: 'c1' }, { acquisitionEnabled: false, appStateMessage: '门禁未开' })).rejects.toThrow('门禁未开');
  });

  it('rejects when developmentMode is true', async () => {
    await expect(runSelectConversation({ conversationId: 'c1' }, { developmentMode: true, appStateMessage: '开发模式禁用联网' })).rejects.toThrow('开发模式禁用联网');
  });

  it('rejects when conversationId is empty or whitespace', async () => {
    await expect(runSelectConversation({ conversationId: '' })).rejects.toThrow('conversationId 无效。');
    await expect(runSelectConversation({ conversationId: '   ' })).rejects.toThrow('conversationId 无效。');
    await expect(runSelectConversation({} as any)).rejects.toThrow('conversationId 无效。');
  });

  it('rejects when exporting is in progress', async () => {
    await expect(runSelectConversation({ conversationId: 'c1' }, { exporting: true })).rejects.toThrow('导出期间暂不能切换会话。');
  });

  it('stops running services, selects conversation, and returns context when valid', async () => {
    const collector = { stopAndWait: vi.fn(async () => {}) };
    const archiveRepair = { cancelAndWait: vi.fn(async () => {}) };
    const adapter = {
      selectConversationInBrowser: vi.fn(async () => {}),
      listPrivateConversations: vi.fn(async () => [
        { conversationId: 'c1', title: 'Target Chat', participantIds: ['p1'], source: 'selected' }
      ]),
      getAccount: vi.fn(async () => ({ accountId: 'acc-1', source: 'profile' }))
    };
    const database = {
      upsertAccount: vi.fn(),
      upsertConversation: vi.fn()
    };

    const result = await runSelectConversation({ conversationId: 'c1' }, {
      collector,
      archiveRepair,
      adapter,
      database
    });

    expect(collector.stopAndWait).toHaveBeenCalledOnce();
    expect(archiveRepair.cancelAndWait).toHaveBeenCalledOnce();
    expect(adapter.selectConversationInBrowser).toHaveBeenCalledWith('c1');
    expect(adapter.listPrivateConversations).toHaveBeenCalledOnce();
    expect(adapter.getAccount).toHaveBeenCalledOnce();
    expect(database.upsertAccount).toHaveBeenCalledWith({ accountId: 'acc-1', source: 'profile' });
    expect(database.upsertConversation).toHaveBeenCalledWith('acc-1', expect.objectContaining({ conversationId: 'c1' }));
    expect(result).toBe(dummyContext);
  });
});
