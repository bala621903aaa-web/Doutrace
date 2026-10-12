import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterAll, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer, rendererFiles, rendererPathFromResourceUrl } from './renderer-test-dom.js';

type AnalysisContext = { accountId: string; conversationId: string };
type ShellController = {
  getSnapshot: () => {
    activeModule: string;
    activeAnalysisTab: string;
    analysisContext: AnalysisContext | null;
  };
};
type ShellOptions = {
  documentRef: Document;
  onBeforeLeave?: (detail: { from: string; to: string }) => void;
  onAfterEnter?: (detail: { from: string; to: string }) => void;
  onAnalysisStateChange?: (snapshot: {
    activeModule: string;
    activeAnalysisTab: string;
    analysisContext: AnalysisContext | null;
  }) => void;
};
type ShellHandle = ShellController & {
  pinAnalysisContext: (context: unknown) => boolean;
  selectAnalysisTab: (tab: string, moveFocus?: boolean) => boolean;
  navigate: (module: string) => boolean;
};
type AppShellModule = {
  isStableAnalysisContext: (context: unknown) => boolean;
  createAppShell: (options: ShellOptions) => ShellHandle;
  mountAppShell: (options: ShellOptions) => ShellHandle;
  navigateAppShell: (module: string, analysisTab?: string, analysisContext?: unknown) => boolean;
};

// Renderer shell is plain JavaScript. desktop/tsconfig.json does not set allowJs.
// @ts-expect-error TS7016: the shell module has no declaration file.
const appShellModule = (await import('../src/renderer/shell/app-shell.js')) as AppShellModule;
const { isStableAnalysisContext, createAppShell, mountAppShell, navigateAppShell } = appShellModule;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function loadShellRenderer(
  getMessages = vi.fn(async () => []),
  waitForInitialLoad = true,
  initialApi: { getState?: () => Promise<unknown>; getContext?: () => Promise<unknown> } = {}
) {
  const context = {
    account: { accountId: 'synthetic-account', source: 'test' },
    conversations: [],
    archivedConversations: [{
      accountId: 'synthetic-account',
      conversationId: 'synthetic-conversation',
      title: '合成档案',
      messageCount: 1
    }],
    collector: { state: 'idle', pages: 0, messages: 0, reason: null },
    repair: { running: false, lastResult: null },
    exporting: false
  };
  const loaded = await loadRenderer(window => {
    Object.assign(window, {
      CSS: { escape: (value: string) => value },
      desktopArchive: {
        getState: initialApi.getState ?? (async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '隔离合成档案' })),
        getContext: initialApi.getContext ?? (async () => context),
        connect: async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '隔离合成档案' }),
        refreshContext: async () => context,
        startCapture: async () => ({ state: 'idle' }),
        stopCapture: async () => ({ state: 'idle' }),
        repairConversation: async () => ({}),
        cancelRepair: async () => undefined,
        exportConversation: async () => ({ cancelled: true }),
        getMessages,
        getConversationStats: async () => ({ accountId: 'synthetic-account', conversationId: 'synthetic-conversation', scope: 'archived-conversation', timeZone: 'Asia/Shanghai', stats: { totalMessages: 0, invalidMessageCount: 0, distinctSenderCount: 0, senderCounts: [], unknownSenderMessageCount: 0, kindCounts: { text: 0, image: 0, voice: 0, 'video-file': 0, 'video-share': 0, emoji: 0, system: 0, unknown: 0 }, dailyCounts: {}, unknownTimestampCount: 0, invalidTimestampCount: 0 } }),
        getAttachments: async () => [],
        getMediaUrl: async () => null,
        recordMediaEvidence: async () => ({ evidence: {} }),
        retryAttachment: async () => false,
        onEvent: () => () => {}
      }
    });
  });
  if (waitForInitialLoad) {
    const document = loaded.dom.window.document;
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.getElementById('mediaStatus')?.textContent).toBe('当前档案没有可保存附件。'));
    await vi.waitFor(() => expect(document.getElementById('filterCount')?.textContent).toBe('当前已加载消息：筛选显示 0 / 0 条'));
  }
  return { ...loaded, getMessages };
}

afterAll(closeRendererFixture);

it('keeps one global title bar and one 64px rail with the five required local icons', async () => {
  const { dom, resourceErrors } = await loadShellRenderer();
  const document = dom.window.document;
  expect(document.querySelectorAll('#app-titlebar.app-titlebar')).toHaveLength(1);
  expect(document.querySelectorAll('#primary-navigation.navigation-rail')).toHaveLength(1);
  expect(document.querySelectorAll('.app-titlebar')).toHaveLength(1);
  expect(document.querySelectorAll('.navigation-rail')).toHaveLength(1);
  expect(document.querySelector('.app-titlebar')?.textContent).toContain('抖忆 · DouTrace');
  expect(document.querySelector('.navigation-rail')?.contains(document.querySelector('.app-titlebar__logo'))).toBe(false);

  const routes = [...document.querySelectorAll<HTMLButtonElement>('.navigation-rail__item')];
  expect(routes.map(item => item.getAttribute('aria-label'))).toEqual([
    '聊天档案', '聊天分析', '媒体资源', '火花提醒', '设置'
  ]);
  expect(routes.map(item => item.dataset.route)).toEqual(['archive', 'analysis', 'media', 'reminders', 'settings']);
  expect(routes.filter(item => item.getAttribute('aria-current') === 'page').map(item => item.dataset.route)).toEqual(['archive']);

  const css = await readFile(rendererFiles.stylesheetPath, 'utf8');
  expect(css).toContain('--navigation-rail-width: 64px');
  expect(css).toContain('width: 20px');
  const iconImages = [...document.querySelectorAll<HTMLImageElement>('.app-titlebar__logo, .navigation-rail__item img')];
  expect(iconImages).toHaveLength(6);
  for (const icon of iconImages) {
    const localUrl = new URL(icon.getAttribute('src')!, pathToFileURL(rendererFiles.htmlPath));
    expect(localUrl.protocol).toBe('file:');
    const svg = await readFile(rendererPathFromResourceUrl(localUrl.href), 'utf8');
    expect(svg).toContain('<svg');
  }
  const flame = await readFile(rendererPathFromResourceUrl(new URL(routes[3].querySelector('img')!.src).href), 'utf8');
  expect(flame).toContain('M8.5 14.5');
  expect(flame).not.toContain('map-pin');
  expect(resourceErrors).toEqual([]);
  dom.window.close();
});

it('switches all modules, preserves selected navigation state, and exposes four keyboard-accessible analysis tabs', async () => {
  const getMessages = vi.fn()
    .mockImplementationOnce(async () => [])
    .mockImplementation(async () => [{
      messagePk: `shell-return-${getMessages.mock.calls.length}`,
      platformMessageId: `shell-return-${getMessages.mock.calls.length}`,
      senderId: 'synthetic-account',
      sentAtMs: 1,
      kind: 'text',
      contentStatus: 'parsed',
      text: '合成路由回读'
    }]);
  const { dom } = await loadShellRenderer(getMessages);
  const document = dom.window.document;
  const routeOrder = ['analysis', 'media', 'reminders', 'settings', 'archive'];
  for (const route of routeOrder) {
    document.querySelector<HTMLButtonElement>(`[data-route="${route}"]`)!.click();
    expect([...document.querySelectorAll('[data-route]')].filter(item => item.getAttribute('aria-current') === 'page')
      .map(item => item.getAttribute('data-route'))).toEqual([route]);
    expect([...document.querySelectorAll('[data-module]')].filter(item => !item.hasAttribute('hidden'))
      .map(item => item.getAttribute('data-module'))).toEqual([route]);
    if (route === 'archive') {
      await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(document.querySelector('[data-message-pk="shell-return-2"]')).not.toBeNull());
    }
  }

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  expect(document.querySelector('[data-module="analysis"]')?.getAttribute('data-analysis-account')).toBeNull();
  expect(document.querySelector('[data-module="analysis"]')?.getAttribute('data-analysis-conversation')).toBeNull();
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map(tab => tab.textContent?.trim())).toEqual(['总览', '互动分析', '聊天旅程', 'AI 洞察']);
  expect(tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent?.trim())).toEqual(['总览']);

  for (const [index, tab] of tabs.entries()) {
    tab.click();
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.tabIndex).toBe(0);
    expect(tabs.filter(item => item.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(document.getElementById('analysis-tab-title')?.textContent).toBe(tab.textContent?.trim());
    const emptyText = document.getElementById('analysis-tab-empty')?.textContent ?? '';
    if (tab.dataset.analysisTab === 'overview' || tab.dataset.analysisTab === 'interaction') {
      expect(emptyText).toContain('分析此会话');
    } else {
      expect(emptyText).toContain('尚未');
    }
    expect(document.getElementById('analysis-stats-content')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('analysis-interaction-content')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('analysis-tab-panel')?.getAttribute('aria-labelledby')).toBe(tab.id);
    if (index > 0) expect(tabs[index - 1].tabIndex).toBe(-1);
  }

  tabs[0].focus();
  tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tabs[1]);
  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(document.querySelector('[data-message-pk="shell-return-3"]')).not.toBeNull());
  expect(document.querySelector('[data-route="archive"]')?.getAttribute('aria-current')).toBe('page');
  expect(document.querySelector('[data-module="archive"]')?.hasAttribute('hidden')).toBe(false);
  dom.window.close();
});

it('pauses and clears hidden archive media, invalidates the pending message response, and reloads on return', async () => {
  const pending = deferred<Array<Record<string, unknown>>>();
  const getMessages = vi.fn()
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(async () => [{
      messagePk: 'return-message',
      platformMessageId: 'return-message',
      senderId: 'synthetic-account',
      sentAtMs: 1,
      kind: 'text',
      contentStatus: 'parsed',
      text: '返回档案'
    }]);
  const { dom } = await loadShellRenderer(getMessages, false);
  const document = dom.window.document;
  await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));

  const audio = document.createElement('audio');
  document.getElementById('messages')!.append(audio);
  let playing = true;
  Object.defineProperty(audio, 'paused', { configurable: true, get: () => !playing });
  const pause = vi.fn(() => { playing = false; });
  audio.pause = pause;
  audio.setAttribute('src', 'file:///synthetic-archive-audio.wav');

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(audio.hasAttribute('src')).toBe(false);

  pending.resolve([{
    messagePk: 'stale-message',
    platformMessageId: 'stale-message',
    senderId: 'synthetic-account',
    sentAtMs: 1,
    kind: 'text',
    contentStatus: 'parsed',
    text: '不得回填的旧响应'
  }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#messages .message')).toBeNull();

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.getElementById('mediaStatus')?.textContent).toBe('当前档案没有可保存附件。'));
  await vi.waitFor(() => expect(document.querySelector('[data-message-pk="return-message"]')).not.toBeNull());
  expect(getMessages).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-route="archive"]')?.getAttribute('aria-current')).toBe('page');
  dom.window.close();
});

it('cancels startup archive work when leaving early and initializes when returning', async () => {
  const pendingState = deferred<Record<string, unknown>>();
  const pendingContext = deferred<Record<string, unknown>>();
  const getState = vi.fn()
    .mockImplementationOnce(() => pendingState.promise)
    .mockResolvedValue({ acquisitionEnabled: false, connected: false, browserStatus: '隔离合成档案' });
  const context = {
    account: { accountId: 'synthetic-account', source: 'test' },
    conversations: [],
    archivedConversations: [{ accountId: 'synthetic-account', conversationId: 'synthetic-conversation', title: '合成档案', messageCount: 1 }],
    collector: { state: 'idle', pages: 0, messages: 0, reason: null },
    repair: { running: false, lastResult: null },
    exporting: false
  };
  const getContext = vi.fn()
    .mockImplementationOnce(() => pendingContext.promise)
    .mockResolvedValue(context);
  const getMessages = vi.fn(async () => [{
    messagePk: 'returned-after-startup',
    platformMessageId: 'returned-after-startup',
    senderId: 'synthetic-account',
    sentAtMs: 1,
    kind: 'text',
    contentStatus: 'parsed',
    text: '返回后加载的合成消息'
  }]);
  const { dom } = await loadShellRenderer(getMessages, false, { getState, getContext });
  const document = dom.window.document;

  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  pendingState.resolve({ acquisitionEnabled: false, connected: false, browserStatus: '隔离合成档案' });
  pendingContext.resolve(context);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(getMessages).not.toHaveBeenCalled();

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(document.querySelector('[data-message-pk="returned-after-startup"]')).not.toBeNull());
  expect(getState).toHaveBeenCalledTimes(2);
  expect(getContext).toHaveBeenCalledTimes(2);
  dom.window.close();
});

it('uses the native Windows title-bar overlay without changing the security or window-size boundary', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  expect(main).toContain("titleBarStyle: 'hidden'");
  expect(main).toContain('titleBarOverlay: {');
  expect(main).toContain("symbolColor: '#5f554a'");
  expect(main).toContain('height: 38');
  expect(main).toContain('width: 1220');
  expect(main).toContain('height: 820');
  expect(main).toContain('minWidth: 980');
  expect(main).toContain('minHeight: 650');
  expect(main).toContain('contextIsolation: true');
  expect(main).toContain('nodeIntegration: false');
  expect(main).toContain('sandbox: true');
  expect(main).toContain('setWindowOpenHandler');
  expect(main).toContain("event.preventDefault()");
  expect(main).not.toContain('frame: false');
  expect(main).not.toContain('window-control');
});

it('accepts only a stable accountId and conversationId as analysis context', () => {
  expect(isStableAnalysisContext({ accountId: 'account-1', conversationId: 'conversation-1' })).toBe(true);
  expect(isStableAnalysisContext({ accountId: ' id-a ', conversationId: 'id-b', title: '昵称' })).toBe(true);
  expect(isStableAnalysisContext({ title: '昵称' })).toBe(false);
  expect(isStableAnalysisContext({ accountId: '', conversationId: 'conversation-1' })).toBe(false);
  expect(isStableAnalysisContext({ accountId: '   ', conversationId: 'conversation-1' })).toBe(false);
  expect(isStableAnalysisContext({ accountId: 'account-1', conversationId: ' ' })).toBe(false);
  expect(isStableAnalysisContext({ accountId: null, conversationId: 'conversation-1' })).toBe(false);
  expect(isStableAnalysisContext({ accountId: 1, conversationId: 'conversation-1' })).toBe(false);
  expect(isStableAnalysisContext(null)).toBe(false);
});

it('does not navigate to analysis before the shell is mounted', () => {
  expect(navigateAppShell('analysis', 'ai', { accountId: 'account-1', conversationId: 'conversation-1' })).toBe(false);
});

it('lands on analysis AI with or without a pinned context and keeps earlier navigation', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button data-route="archive" aria-current="page"></button>
    <button data-route="analysis"></button>
    <button data-route="media"></button>
    <button data-route="reminders"></button>
    <button data-route="settings"></button>
    <section data-module="archive"></section>
    <section data-module="analysis" hidden></section>
    <section data-module="media" hidden></section>
    <section data-module="reminders" hidden></section>
    <section data-module="settings" hidden></section>
    <button id="analysis-tab-overview" data-analysis-tab="overview" aria-selected="true"></button>
    <button id="analysis-tab-interaction" data-analysis-tab="interaction" aria-selected="false"></button>
    <button id="analysis-tab-journey" data-analysis-tab="journey" aria-selected="false"></button>
    <button id="analysis-tab-ai" data-analysis-tab="ai" aria-selected="false"></button>
    <section id="analysis-tab-panel"></section>
    <h2 id="analysis-tab-title"></h2>
    <p id="analysis-tab-empty"></p>
  </body></html>`);
  const document = dom.window.document;
  const shell = mountAppShell({ documentRef: document });
  const analysis = document.querySelector<HTMLElement>('[data-module="analysis"]')!;

  expect(navigateAppShell('analysis', 'ai')).toBe(true);
  expect(shell.getSnapshot()).toMatchObject({ activeModule: 'analysis', activeAnalysisTab: 'ai', analysisContext: null });
  expect(analysis.hidden).toBe(false);
  expect(analysis.getAttribute('data-analysis-account')).toBeNull();
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');

  expect(navigateAppShell('archive')).toBe(true);
  expect(shell.getSnapshot().activeModule).toBe('archive');
  expect(shell.getSnapshot().analysisContext).toBeNull();

  const input = {
    accountId: ' id-a ',
    conversationId: 'conv-1',
    title: '昵称',
    messages: [{ text: '合成正文' }]
  };
  expect(navigateAppShell('analysis', 'ai', input)).toBe(true);
  input.accountId = 'mutated';
  input.messages.push({ text: '更多正文' });
  expect(shell.getSnapshot().analysisContext).toEqual({ accountId: ' id-a ', conversationId: 'conv-1' });
  expect(analysis.dataset.analysisAccount).toBe(' id-a ');
  expect(analysis.dataset.analysisConversation).toBe('conv-1');
  expect(analysis.getAttribute('data-analysis-title')).toBeNull();
  const published = shell.getSnapshot().analysisContext;
  if (published) published.accountId = 'changed-by-caller';
  expect(shell.getSnapshot().analysisContext).toEqual({ accountId: ' id-a ', conversationId: 'conv-1' });

  expect(navigateAppShell('media', 'overview', { accountId: ' ', conversationId: 'conv-1' })).toBe(false);
  expect(shell.getSnapshot()).toMatchObject({
    activeModule: 'analysis',
    activeAnalysisTab: 'ai',
    analysisContext: { accountId: ' id-a ', conversationId: 'conv-1' }
  });

  expect(navigateAppShell('settings')).toBe(true);
  expect(shell.getSnapshot().activeModule).toBe('settings');
  expect(shell.getSnapshot().analysisContext).toEqual({ accountId: ' id-a ', conversationId: 'conv-1' });
  expect(navigateAppShell('analysis', 'overview')).toBe(true);
  expect(shell.getSnapshot()).toMatchObject({
    activeModule: 'analysis',
    activeAnalysisTab: 'overview',
    analysisContext: { accountId: ' id-a ', conversationId: 'conv-1' }
  });
  expect(analysis.dataset.analysisAccount).toBe(' id-a ');
  dom.window.close();
});

it('disables analyze-this-conversation when the archive has no stable selection', async () => {
  const getMessages = vi.fn(async () => []);
  const { dom } = await loadShellRenderer(getMessages, false, {
    getContext: async () => ({
      account: null,
      conversations: [],
      archivedConversations: [],
      collector: { state: 'idle', pages: 0, messages: 0, reason: null },
      repair: { running: false, lastResult: null },
      exporting: false
    })
  });
  const document = dom.window.document;
  await vi.waitFor(() => expect(document.getElementById('archiveCount')?.textContent).toBe('0'));
  const action = document.getElementById('analyzeConversation') as HTMLButtonElement;
  expect(action.textContent).toBe('分析此会话');
  expect(action.disabled).toBe(true);
  action.click();
  expect(document.querySelector('[data-route="archive"]')?.getAttribute('aria-current')).toBe('page');
  expect(document.querySelector('[data-module="analysis"]')?.hasAttribute('hidden')).toBe(true);
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('false');
  expect(document.querySelector('[data-module="analysis"]')?.getAttribute('data-analysis-account')).toBeNull();
  expect(getMessages).not.toHaveBeenCalled();
  dom.window.close();
});

it('disables analyze-this-conversation when the selected account id is blank', async () => {
  const getMessages = vi.fn(async () => []);
  const { dom } = await loadShellRenderer(getMessages, false, {
    getContext: async () => ({
      account: null,
      conversations: [],
      archivedConversations: [{
        accountId: '',
        conversationId: 'synthetic-conversation',
        title: '缺少账号',
        messageCount: 1
      }],
      collector: { state: 'idle', pages: 0, messages: 0, reason: null },
      repair: { running: false, lastResult: null },
      exporting: false
    })
  });
  const document = dom.window.document;
  await vi.waitFor(() => expect(document.getElementById('archiveTitle')?.textContent).toBe('缺少账号'));
  const action = document.getElementById('analyzeConversation') as HTMLButtonElement;
  expect(action.disabled).toBe(true);
  action.click();
  expect(document.querySelector('[data-module="archive"]')?.hasAttribute('hidden')).toBe(false);
  expect(document.querySelector('[data-analysis-tab="overview"]')?.getAttribute('aria-selected')).toBe('true');
  expect(getMessages).not.toHaveBeenCalled();
  dom.window.close();
});

it('opens AI insights for the selected archive and keeps that pinned pair across rail navigation', async () => {
  const { dom } = await loadShellRenderer();
  const document = dom.window.document;
  const action = document.getElementById('analyzeConversation') as HTMLButtonElement;
  expect(action.disabled).toBe(false);
  expect(action.textContent).toBe('分析此会话');
  action.click();

  const analysis = document.querySelector<HTMLElement>('[data-module="analysis"]')!;
  expect(document.querySelector('[data-route="analysis"]')?.getAttribute('aria-current')).toBe('page');
  expect(analysis.hasAttribute('hidden')).toBe(false);
  expect(document.querySelector('[data-module="archive"]')?.hasAttribute('hidden')).toBe(true);
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(document.getElementById('analysis-tab-title')?.textContent).toBe('AI 洞察');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toContain('尚未');
  expect(analysis.dataset.analysisAccount).toBe('synthetic-account');
  expect(analysis.dataset.analysisConversation).toBe('synthetic-conversation');

  document.querySelector<HTMLButtonElement>('[data-route="media"]')!.click();
  expect(document.querySelector('[data-module="media"]')?.hasAttribute('hidden')).toBe(false);
  expect(analysis.dataset.analysisAccount).toBe('synthetic-account');
  expect(analysis.dataset.analysisConversation).toBe('synthetic-conversation');
  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('[data-route="archive"]')!.getAttribute('aria-current')).toBeNull();
  dom.window.close();
});

it('notifies analysis state changes for pin, tab, and navigation with snapshot copies', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <button data-route="archive" aria-current="page"></button>
    <button data-route="analysis"></button>
    <button data-route="media"></button>
    <button data-route="reminders"></button>
    <button data-route="settings"></button>
    <section data-module="archive"></section>
    <section data-module="analysis" hidden></section>
    <section data-module="media" hidden></section>
    <section data-module="reminders" hidden></section>
    <section data-module="settings" hidden></section>
    <button id="analysis-tab-overview" data-analysis-tab="overview" aria-selected="true"></button>
    <button id="analysis-tab-interaction" data-analysis-tab="interaction" aria-selected="false"></button>
    <button id="analysis-tab-journey" data-analysis-tab="journey" aria-selected="false"></button>
    <button id="analysis-tab-ai" data-analysis-tab="ai" aria-selected="false"></button>
    <section id="analysis-tab-panel" aria-labelledby="analysis-tab-overview"></section>
    <h2 id="analysis-tab-title"></h2>
    <p id="analysis-tab-empty"></p>
  </body>`);
  const snapshots: Array<ReturnType<ShellController['getSnapshot']>> = [];
  const shell = createAppShell({
    documentRef: dom.window.document,
    onAnalysisStateChange: snapshot => { snapshots.push(snapshot); }
  });
  const baseline = snapshots.length;
  expect(shell.pinAnalysisContext({ accountId: 'a1', conversationId: 'c1' })).toBe(true);
  expect(snapshots.at(-1)).toEqual({
    activeModule: 'archive',
    activeAnalysisTab: 'overview',
    analysisContext: { accountId: 'a1', conversationId: 'c1' }
  });
  const pinned = snapshots.at(-1)!;
  pinned.analysisContext!.accountId = 'mutated';
  expect(shell.getSnapshot().analysisContext).toEqual({ accountId: 'a1', conversationId: 'c1' });

  expect(shell.selectAnalysisTab('interaction')).toBe(true);
  expect(snapshots.at(-1)?.activeAnalysisTab).toBe('interaction');
  expect(shell.pinAnalysisContext({ accountId: '', conversationId: 'c2' })).toBe(false);
  expect(shell.getSnapshot().analysisContext).toEqual({ accountId: 'a1', conversationId: 'c1' });

  expect(shell.navigate('analysis')).toBe(true);
  expect(snapshots.at(-1)?.activeModule).toBe('analysis');
  expect(snapshots.length).toBeGreaterThan(baseline);
  dom.window.close();
});
