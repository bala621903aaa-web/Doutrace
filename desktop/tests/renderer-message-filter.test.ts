import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeRendererFixture, loadRenderer, rendererFiles, rendererPathFromResourceUrl } from './renderer-test-dom.js';

const messages = [
  { messagePk: 'text-parsed', platformMessageId: '1', senderId: 'sender', sentAtMs: 1_700_000_000_000, kind: 'text', contentStatus: 'parsed', text: '普通文字' },
  { messagePk: 'image-partial', platformMessageId: '2', senderId: 'sender', sentAtMs: 1_700_000_000_001, kind: 'image', contentStatus: 'partial', text: '图片说明', replyToPlatformMessageId: '1', replySnapshot: { status: 'available', text: '普通文字' } },
  { messagePk: 'voice-unknown', platformMessageId: '3', senderId: 'sender', sentAtMs: 1_700_000_000_002, kind: 'voice', contentStatus: 'unknown', text: '语音待解析', replyToPlatformMessageId: '2', replySnapshot: { status: 'available', text: '图片说明' } },
  { messagePk: 'image-parsed', platformMessageId: '4', senderId: 'sender', sentAtMs: 1_700_000_000_003, kind: 'image', contentStatus: 'parsed', text: '<img src=x onerror="alert(1)">' },
  { messagePk: 'video-legacy', platformMessageId: '5', senderId: 'sender', sentAtMs: 1_700_000_000_004, kind: 'video-file', contentStatus: 'legacy-missing', text: '旧视频', replyToPlatformMessageId: '404', replySnapshot: { status: 'available', text: '远端目标' } }
];

let dom: JSDOM;
let getMessages: ReturnType<typeof vi.fn>;
let recordMediaEvidence: ReturnType<typeof vi.fn>;
let scrollIntoView: ReturnType<typeof vi.fn>;
let resourceErrors: string[];

beforeEach(async () => {
  getMessages = vi.fn(async (_input: { conversationId?: string; query?: string; limit?: number; offset?: number }) => messages);
  recordMediaEvidence = vi.fn(async () => ({ evidence: {} }));
  const loaded = await loadRenderer(window => {
    Object.assign(window, { CSS: { escape: (value: string) => value }, desktopArchive: {
        getState: async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '离线' }),
        getContext: async () => ({
          account: { accountId: 'account', source: 'test' }, conversations: [],
          archivedConversations: [
            { accountId: 'account', conversationId: 'conversation', title: 'Mock 档案', messageCount: 5000 },
            { accountId: 'account', conversationId: 'other', title: '另一个 Mock 档案', messageCount: 1 }
          ],
          collector: { state: 'idle' }, repair: { running: false, lastResult: null }, exporting: false
        }),
        getMessages,
        getAttachments: async () => [{ id: 'voice-attachment', messagePk: 'voice-unknown', assetState: 'current', status: 'saved' }],
        getMediaUrl: async () => ({ url: 'file:///mock.wav', fileVersion: 'mock-version', mime: 'audio/wav', family: 'audio', evidence: {} }),
        recordMediaEvidence,
        onEvent: () => () => {}
    } });
  });
  dom = loaded.dom;
  resourceErrors = loaded.resourceErrors;
  scrollIntoView = vi.fn();
  dom.window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(messages.length));
});

afterEach(() => { vi.useRealTimers(); dom.window.close(); });
afterAll(closeRendererFixture);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function visibleIds() {
  return [...dom.window.document.querySelectorAll<HTMLElement>('#messages .message')].filter(row => !row.hidden).map(row => row.dataset.platformId);
}

function changeFilter(id: string, value: string) {
  const select = dom.window.document.getElementById(id) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function clickReference(sourceId: string, targetId: string) {
  const button = dom.window.document.querySelector<HTMLButtonElement>(`[data-platform-id="${sourceId}"] [data-reference="${targetId}"]`);
  expect(button).not.toBeNull();
  button!.click();
}

it('uses reliable sender IDs for bubble sides and keeps missing identity neutral', async () => {
  getMessages.mockResolvedValueOnce([
    messages[0],
    { ...messages[0], messagePk: 'own', platformMessageId: 'own', senderId: 'account', senderName: '本机账号' },
    { ...messages[0], messagePk: 'unknown-sender', platformMessageId: 'unknown-sender', senderId: null, senderName: null, sentAtMs: Number.MAX_SAFE_INTEGER }
  ]);
  const search = dom.window.document.getElementById('search') as HTMLInputElement;
  search.value = '身份';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(3));
  const relation = (id: string) => dom.window.document.querySelector<HTMLElement>(`[data-platform-id="${id}"]`)?.dataset.senderRelation;
  expect(relation('1')).toBe('incoming');
  expect(relation('own')).toBe('outgoing');
  expect(relation('unknown-sender')).toBe('neutral');
  expect(dom.window.document.querySelector('[data-platform-id="unknown-sender"] .message-head')?.textContent).toContain('发送者未确认');
  expect(dom.window.document.querySelector('[data-platform-id="unknown-sender"] .message-head')?.textContent).toContain('时间未知');
});

it('searches real archive titles locally and updates the selected reader heading', async () => {
  const search = dom.window.document.getElementById('conversationSearch') as HTMLInputElement;
  search.value = '另一个';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const archive = dom.window.document.querySelector<HTMLButtonElement>('#archives [data-archive]');
  expect(archive?.textContent).toContain('另一个 Mock 档案');
  expect(dom.window.document.querySelectorAll('#archives [data-archive]')).toHaveLength(1);
  archive!.click();
  await vi.waitFor(() => expect(dom.window.document.getElementById('archiveTitle')?.textContent).toBe('另一个 Mock 档案'));
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(messages.length));
  expect(dom.window.document.getElementById('archiveMeta')?.textContent).toContain('已保存 1 条消息');
});

it('loads the built HTML, JavaScript, and stylesheet from local disk resources', async () => {
  const html = await readFile(rendererFiles.htmlPath, 'utf8');
  const javascript = await readFile(rendererFiles.javascriptPath, 'utf8');
  const stylesheet = await readFile(rendererFiles.stylesheetPath, 'utf8');
  const document = dom.window.document;
  const script = document.querySelector<HTMLScriptElement>('script[src]');
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href]');

  expect(script?.getAttribute('src')).toBe('./renderer.js');
  expect(link?.getAttribute('href')).toBe('./renderer.css');
  expect(new URL(script!.getAttribute('src')!, pathToFileURL(rendererFiles.htmlPath)).href).toBe(pathToFileURL(rendererFiles.javascriptPath).href);
  expect(new URL(link!.getAttribute('href')!, pathToFileURL(rendererFiles.htmlPath)).href).toBe(pathToFileURL(rendererFiles.stylesheetPath).href);
  expect(await readFile(rendererPathFromResourceUrl(script!.src))).toBeTruthy();
  expect(await readFile(rendererPathFromResourceUrl(link!.href))).toBeTruthy();
  expect(resourceErrors).toEqual([]);
  expect(document.styleSheets).toHaveLength(1);
  expect((link!.sheet as CSSStyleSheet).cssRules.length).toBeGreaterThan(0);
  expect(dom.window.getComputedStyle(document.body).marginTop).toBe('0px');
  expect(getMessages).toHaveBeenCalledTimes(1);

  for (const reference of [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[href]')]) {
    const localPath = reference instanceof dom.window.HTMLScriptElement
      ? reference.getAttribute('src')!
      : reference.getAttribute('href')!;
    expect(new URL(localPath, pathToFileURL(rendererFiles.htmlPath)).protocol).toBe('file:');
  }
  expect(html + stylesheet).not.toMatch(/https?:\/\//i);
  expect(stylesheet).not.toMatch(/@import\s|url\([^)]*https?:\/\//i);
  expect(javascript).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|https?:\/\//i);
});

it('filters only loaded messages by supported type without another API request', () => {
  expect([...dom.window.document.querySelectorAll('#kindFilter option')].map(option => option.getAttribute('value')))
    .toEqual(['', 'text', 'image', 'voice', 'video-file', 'video-share', 'emoji', 'system', 'unknown']);
  changeFilter('kindFilter', 'image');
  expect(visibleIds()).toEqual(['2', '4']);
  expect(dom.window.document.getElementById('filterCount')?.textContent).toContain('2 / 5');
  changeFilter('kindFilter', 'voice');
  expect(visibleIds()).toEqual(['3']);
  expect(getMessages).toHaveBeenCalledTimes(1);
  expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 500, offset: 0 }));
  expect(dom.window.document.querySelector('.message-filters')?.textContent).toContain('不是整个聊天档案');
});

it('combines type and content status filters and gives an empty state', () => {
  changeFilter('contentStatusFilter', 'parsed');
  expect(visibleIds()).toEqual(['1', '4']);
  changeFilter('contentStatusFilter', 'partial');
  expect(visibleIds()).toEqual(['2']);
  changeFilter('kindFilter', 'image');
  expect(visibleIds()).toEqual(['2']);
  changeFilter('contentStatusFilter', 'unknown');
  expect(visibleIds()).toEqual([]);
  expect(dom.window.document.querySelector('#messages .empty')?.textContent).toContain('当前已加载消息中没有符合筛选条件');
  expect(dom.window.document.getElementById('filterCount')?.textContent).toContain('0 / 5');
  changeFilter('kindFilter', 'voice');
  expect(visibleIds()).toEqual(['3']);
  changeFilter('contentStatusFilter', 'legacy-missing');
  changeFilter('kindFilter', 'video-file');
  expect(visibleIds()).toEqual(['5']);
});

it('clears all filters, preserves source rows, and safely escapes message content', () => {
  const original = structuredClone(messages);
  changeFilter('kindFilter', 'image');
  changeFilter('contentStatusFilter', 'partial');
  dom.window.document.getElementById('clearFilters')!.click();
  expect((dom.window.document.getElementById('kindFilter') as HTMLSelectElement).value).toBe('');
  expect((dom.window.document.getElementById('contentStatusFilter') as HTMLSelectElement).value).toBe('');
  expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']);
  expect(dom.window.document.getElementById('filterCount')?.textContent).toContain('5 / 5');
  const unsafeRow = dom.window.document.querySelector<HTMLElement>('[data-platform-id="4"]')!;
  expect(unsafeRow.querySelector('.message-body')?.textContent).toBe('<img src=x onerror="alert(1)">');
  expect(unsafeRow.querySelector('.message-body img')).toBeNull();
  expect(unsafeRow.querySelector('.message-body')?.innerHTML).toContain('&lt;img');
  expect(messages).toEqual(original);
  expect(getMessages).toHaveBeenCalledTimes(1);
});

it('reveals a quoted text message hidden by image and partial-status filters', async () => {
  changeFilter('kindFilter', 'image');
  changeFilter('contentStatusFilter', 'partial');
  expect(visibleIds()).toEqual(['2']);
  clickReference('2', '1');
  await vi.waitFor(() => expect(dom.window.document.querySelector('[data-platform-id="1"]')?.classList.contains('target-message')).toBe(true));
  expect(visibleIds()).toContain('1');
  expect((dom.window.document.getElementById('kindFilter') as HTMLSelectElement).value).toBe('');
  expect((dom.window.document.getElementById('contentStatusFilter') as HTMLSelectElement).value).toBe('');
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  expect(getMessages).toHaveBeenCalledTimes(1);
});

it('clears only the conflicting status when a voice message quotes a partial image', async () => {
  changeFilter('contentStatusFilter', 'unknown');
  expect(visibleIds()).toEqual(['3']);
  clickReference('3', '2');
  await vi.waitFor(() => expect(dom.window.document.querySelector('[data-platform-id="2"]')?.classList.contains('target-message')).toBe(true));
  expect(visibleIds()).toContain('2');
  expect((dom.window.document.getElementById('contentStatusFilter') as HTMLSelectElement).value).toBe('');
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(getMessages).toHaveBeenCalledTimes(1);
});

it('keeps quoted-message navigation working without filters', async () => {
  clickReference('2', '1');
  await vi.waitFor(() => expect(dom.window.document.querySelector('[data-platform-id="1"]')?.classList.contains('target-message')).toBe(true));
  expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(getMessages).toHaveBeenCalledTimes(1);
});

it('searches by ID when a quoted target is outside the loaded page', async () => {
  const remoteTarget = { messagePk: 'remote', platformMessageId: '404', senderId: 'sender', sentAtMs: 1_700_000_000_005, kind: 'text', contentStatus: 'parsed', text: '远端目标' };
  getMessages.mockImplementation(async input => input.query === '404' ? [remoteTarget] : messages);
  changeFilter('kindFilter', 'video-file');
  clickReference('5', '404');
  await vi.waitFor(() => expect(dom.window.document.querySelector('[data-platform-id="404"]')?.classList.contains('target-message')).toBe(true));
  expect(visibleIds()).toEqual(['404']);
  expect((dom.window.document.getElementById('kindFilter') as HTMLSelectElement).value).toBe('');
  expect((dom.window.document.getElementById('search') as HTMLInputElement).value).toBe('404');
  expect(getMessages).toHaveBeenCalledTimes(2);
  expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ query: '404', limit: 500, offset: 0 }));
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it('reports a quoted target that cannot be found or loaded', async () => {
  getMessages.mockImplementationOnce(async () => []);
  clickReference('5', '404');
  await vi.waitFor(() => expect(dom.window.document.getElementById('status')?.textContent).toContain('未找到引用消息'));
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(getMessages).toHaveBeenCalledTimes(2);

  // Reload the mock source row through the existing search event, then simulate a failed lookup.
  getMessages.mockImplementationOnce(async () => messages);
  const search = dom.window.document.getElementById('search') as HTMLInputElement;
  search.value = '';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(messages.length));
  getMessages.mockRejectedValueOnce(new Error('mock read failure'));
  clickReference('5', '404');
  await vi.waitFor(() => expect(dom.window.document.getElementById('status')?.textContent).toContain('引用消息读取失败'));
  expect(dom.window.document.querySelector('#messages .empty')?.textContent).toContain('mock read failure');
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it('preserves a visible audio node and its evidence listeners while changing filters', async () => {
  const audio = dom.window.document.querySelector<HTMLAudioElement>('[data-media-audio="voice-attachment"]');
  expect(audio).not.toBeNull();
  changeFilter('contentStatusFilter', 'unknown');
  expect(visibleIds()).toEqual(['3']);
  expect(dom.window.document.querySelector('[data-media-audio="voice-attachment"]')).toBe(audio);
  changeFilter('kindFilter', 'voice');
  expect(visibleIds()).toEqual(['3']);
  expect(dom.window.document.querySelector('[data-media-audio="voice-attachment"]')).toBe(audio);
  expect(getMessages).toHaveBeenCalledTimes(1);
  audio!.currentTime = 0;
  audio!.dispatchEvent(new dom.window.Event('play'));
  audio!.currentTime = 1;
  audio!.dispatchEvent(new dom.window.Event('timeupdate'));
  await vi.waitFor(() => expect(recordMediaEvidence).toHaveBeenCalledWith(expect.objectContaining({
    attachmentId: 'voice-attachment', fileVersion: 'mock-version', event: { type: 'audio-playback', advancedSeconds: 1 }
  })));
});

it('pauses audio and video only when their row becomes hidden and never resumes them on reset', () => {
  const audio = dom.window.document.querySelector<HTMLAudioElement>('[data-media-audio="voice-attachment"]')!;
  const video = dom.window.document.createElement('video');
  dom.window.document.querySelector('[data-platform-id="3"] .media')!.append(video);
  let paused = false;
  let videoPaused = false;
  Object.defineProperty(audio, 'paused', { configurable: true, get: () => paused });
  Object.defineProperty(video, 'paused', { configurable: true, get: () => videoPaused });
  const pause = vi.fn(() => { paused = true; });
  const pauseVideo = vi.fn(() => { videoPaused = true; });
  const play = vi.fn();
  audio.pause = pause;
  audio.play = play;
  video.pause = pauseVideo;

  changeFilter('contentStatusFilter', 'unknown');
  changeFilter('kindFilter', 'voice');
  expect(dom.window.document.querySelector('[data-media-audio="voice-attachment"]')).toBe(audio);
  expect(pause).not.toHaveBeenCalled();
  expect(pauseVideo).not.toHaveBeenCalled();
  expect(paused).toBe(false);

  changeFilter('kindFilter', 'image');
  expect(dom.window.document.querySelector<HTMLElement>('[data-platform-id="3"]')?.hidden).toBe(true);
  expect(pause).toHaveBeenCalledTimes(1);
  expect(pauseVideo).toHaveBeenCalledTimes(1);
  expect(paused).toBe(true);
  changeFilter('contentStatusFilter', 'parsed');
  expect(pause).toHaveBeenCalledTimes(1);
  expect(pauseVideo).toHaveBeenCalledTimes(1);

  dom.window.document.getElementById('clearFilters')!.click();
  expect(dom.window.document.querySelector('[data-media-audio="voice-attachment"]')).toBe(audio);
  expect(paused).toBe(true);
  expect(videoPaused).toBe(true);
  expect(play).not.toHaveBeenCalled();
});

it('ignores a pending page response after navigating to a quoted message on the displayed page', async () => {
  const pendingPage = deferred<typeof messages>();
  getMessages.mockImplementationOnce(() => pendingPage.promise);
  const next = dom.window.document.getElementById('next') as HTMLButtonElement;
  next.disabled = false; // Simulate a full first page while keeping the fixture small.
  next.click();
  expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500 }));

  clickReference('2', '1');
  expect(dom.window.document.querySelector('[data-platform-id="1"]')?.classList.contains('target-message')).toBe(true);
  pendingPage.resolve(messages);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']);
  expect(dom.window.document.querySelector('[data-platform-id="1"]')?.classList.contains('target-message')).toBe(true);
  expect(dom.window.document.getElementById('pageInfo')?.textContent).toContain('第 1～5 条');
  expect(getMessages).toHaveBeenCalledTimes(2);
});

it('cancels an untriggered search debounce when navigating to a loaded reference', async () => {
  vi.useFakeTimers();
  try {
    const search = dom.window.document.getElementById('search') as HTMLInputElement;
    search.value = '延迟搜索';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    clickReference('2', '1');
    await vi.advanceTimersByTimeAsync(300);
    expect(search.value).toBe('');
    expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']);
    expect(dom.window.document.querySelector('[data-platform-id="1"]')?.classList.contains('target-message')).toBe(true);
    expect(getMessages).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('does not highlight a new conversation with a stale quoted-target response', async () => {
  const oldTarget = deferred<typeof messages>();
  const newRow = { ...messages[0], messagePk: 'new-conversation', platformMessageId: '404' };
  getMessages.mockImplementationOnce(() => oldTarget.promise).mockImplementationOnce(async () => [newRow]);
  clickReference('5', '404');
  expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'conversation', query: '404' }));
  dom.window.document.querySelector<HTMLButtonElement>('[data-archive="other"]')!.click();
  await vi.waitFor(() => expect(visibleIds()).toEqual(['404']));
  oldTarget.resolve([{ ...messages[0], messagePk: 'old-conversation', platformMessageId: '404' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(dom.window.document.querySelector('[data-platform-id="404"]')?.classList.contains('target-message')).toBe(false);
  expect((dom.window.document.getElementById('search') as HTMLInputElement).value).toBe('');
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it('keeps ordinary search, pagination, and quoted navigation working', async () => {
  const nextRow = { ...messages[0], messagePk: 'next-page', platformMessageId: '501' };
  getMessages.mockImplementation(async input => input.query === '普通' ? [messages[0]] : input.offset === 500 ? [nextRow] : messages);
  const search = dom.window.document.getElementById('search') as HTMLInputElement;
  search.value = '普通';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(visibleIds()).toEqual(['1']));
  search.value = '';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']));

  const next = dom.window.document.getElementById('next') as HTMLButtonElement;
  next.disabled = false;
  next.click();
  await vi.waitFor(() => expect(visibleIds()).toEqual(['501']));
  expect(dom.window.document.getElementById('pageInfo')?.textContent).toContain('第 501～501 条');
  (dom.window.document.getElementById('previous') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']));
  clickReference('2', '1');
  expect(dom.window.document.querySelector('[data-platform-id="1"]')?.classList.contains('target-message')).toBe(true);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it('pins accountId and conversationId for AI insights without following a later archive selection', async () => {
  const document = dom.window.document;
  changeFilter('kindFilter', 'image');
  const action = document.getElementById('analyzeConversation') as HTMLButtonElement;
  expect(action.disabled).toBe(false);
  expect(action.textContent).toBe('分析此会话');
  action.click();

  const analysis = document.querySelector<HTMLElement>('[data-module="analysis"]');
  expect(document.querySelector('[data-route="analysis"]')?.getAttribute('aria-current')).toBe('page');
  expect(analysis?.hasAttribute('hidden')).toBe(false);
  expect(document.querySelector('[data-module="archive"]')?.hasAttribute('hidden')).toBe(true);
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(document.getElementById('analysis-tab-title')?.textContent).toBe('AI 洞察');
  expect(document.getElementById('analysis-tab-empty')?.textContent).toBe('AI 洞察尚未提供真实分析服务，不会显示示例回答。');
  expect(analysis?.dataset.analysisAccount).toBe('account');
  expect(analysis?.dataset.analysisConversation).toBe('conversation');
  expect(analysis?.getAttribute('data-analysis-title')).toBeNull();
  expect((document.getElementById('kindFilter') as HTMLSelectElement).value).toBe('image');

  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-module="archive"]')?.hasAttribute('hidden')).toBe(false));
  document.querySelector<HTMLButtonElement>('[data-archive="other"]')!.click();
  await vi.waitFor(() => expect(document.getElementById('archiveTitle')?.textContent).toBe('另一个 Mock 档案'));
  expect(analysis?.dataset.analysisAccount).toBe('account');
  expect(analysis?.dataset.analysisConversation).toBe('conversation');
  expect(action.disabled).toBe(false);

  action.click();
  expect(document.querySelector('[data-module="analysis"]')?.hasAttribute('hidden')).toBe(false);
  expect(document.querySelector('[data-analysis-tab="ai"]')?.getAttribute('aria-selected')).toBe('true');
  expect(analysis?.dataset.analysisAccount).toBe('account');
  expect(analysis?.dataset.analysisConversation).toBe('other');
});

// Use the built Renderer event bridge without changing the existing fixture or cases.
async function loadContextEventFixture() {
  dom.window.close();
  const context = {
    account: { accountId: 'account', source: 'test' }, conversations: [],
    archivedConversations: [
      { accountId: 'account', conversationId: 'other', title: '当前选择', messageCount: 5 }
    ],
    collector: { state: 'idle' }, repair: { running: false, lastResult: null }, exporting: false
  };
  const app = { acquisitionEnabled: false, connected: false, browserStatus: '初始离线' };
  const getState = vi.fn(async () => app);
  let emit!: (value: typeof context) => void;
  getMessages.mockClear();
  const loaded = await loadRenderer(window => {
    Object.assign(window, { CSS: { escape: (value: string) => value }, desktopArchive: {
      getState, getContext: async () => context, getMessages,
      getAttachments: async () => [],
      onEvent: (callback: typeof emit) => { emit = callback; return () => {}; }
    } });
  });
  dom = loaded.dom;
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(messages.length));
  expect(loaded.resourceErrors).toEqual([]);
  expect(getMessages).toHaveBeenCalledTimes(1);
  const updated = {
    ...context,
    archivedConversations: [
      { ...context.archivedConversations[0], title: '事件更新后的选择', messageCount: 17 },
      { accountId: 'account', conversationId: 'new', title: '事件新增档案', messageCount: 1 }
    ]
  };
  return { emit, updated, getState, app };
}

it('reloads the selected messages after a context event while archive is visible', async () => {
  const { emit, updated, getState, app } = await loadContextEventFixture();
  expect((dom.window.document.getElementById('chat-archive-page') as HTMLElement).hidden).toBe(false);
  getState.mockResolvedValueOnce({ ...app, browserStatus: '事件状态' });
  emit(updated);
  await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
  expect(getMessages).toHaveBeenLastCalledWith({ accountId: 'account', conversationId: 'other', query: '', limit: 500, offset: 0 });
  expect(dom.window.document.getElementById('archiveTitle')?.textContent).toBe('事件更新后的选择');
  expect(dom.window.document.getElementById('status')?.textContent).toContain('事件状态');
});

it('updates hidden archive state and lists without loading, then reloads current selection exactly once on return', async () => {
  const { emit, updated, getState, app } = await loadContextEventFixture();
  const document = dom.window.document;
  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  expect((document.getElementById('chat-archive-page') as HTMLElement).hidden).toBe(true);
  getState.mockResolvedValueOnce({ ...app, browserStatus: '隐藏期间更新' });
  emit(updated);
  await vi.waitFor(() => expect(document.getElementById('archiveTitle')?.textContent).toBe('事件更新后的选择'));
  expect(document.getElementById('archiveCount')?.textContent).toBe('2');
  expect(document.querySelector('[data-archive="new"]')?.textContent).toContain('事件新增档案');
  expect(document.getElementById('archiveMeta')?.textContent).toContain('17');
  expect(document.getElementById('status')?.textContent).toContain('隐藏期间更新');
  expect(getMessages).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLButtonElement>('[data-route="archive"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((document.getElementById('chat-archive-page') as HTMLElement).hidden).toBe(false);
  expect(getMessages).toHaveBeenCalledTimes(2);
  expect(getMessages).toHaveBeenLastCalledWith({ accountId: 'account', conversationId: 'other', query: '', limit: 500, offset: 0 });
  expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']);
});

it('keeps hidden context events cancelling debounce and invalidating an in-flight page response', async () => {
  try {
    const { emit, updated } = await loadContextEventFixture();
    const document = dom.window.document;
    document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
    const pendingPage = deferred<typeof messages>();
    getMessages.mockImplementationOnce(() => pendingPage.promise);
    const next = document.getElementById('next') as HTMLButtonElement;
    next.disabled = false;
    next.click();
    expect(getMessages).toHaveBeenCalledTimes(2);
    emit(updated);
    await vi.waitFor(() => expect(document.getElementById('archiveTitle')?.textContent).toBe('事件更新后的选择'));
    pendingPage.resolve([{ ...messages[0], messagePk: 'stale-page', platformMessageId: 'stale' }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(visibleIds()).toEqual(['1', '2', '3', '4', '5']);
    expect(document.getElementById('pageInfo')?.textContent).toContain('第 1～5 条');
    expect(getMessages).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    const search = document.getElementById('search') as HTMLInputElement;
    search.value = '待取消搜索';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    emit(updated);
    await vi.advanceTimersByTimeAsync(300);
    expect(getMessages).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a stale context event when its getState response arrives after a newer event', async () => {
  const { emit, updated, getState, app } = await loadContextEventFixture();
  const document = dom.window.document;
  document.querySelector<HTMLButtonElement>('[data-route="analysis"]')!.click();
  const staleState = deferred<typeof app>();
  getState.mockImplementationOnce(() => staleState.promise);
  emit({ ...updated, archivedConversations: [{ ...updated.archivedConversations[0], title: '过期上下文' }] });
  getState.mockResolvedValueOnce({ ...app, browserStatus: '最新状态' });
  emit(updated);
  await vi.waitFor(() => expect(document.getElementById('archiveTitle')?.textContent).toBe('事件更新后的选择'));
  staleState.resolve({ ...app, browserStatus: '过期状态' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('archiveTitle')?.textContent).toBe('事件更新后的选择');
  expect(document.getElementById('status')?.textContent).toContain('最新状态');
  expect(document.getElementById('archiveCount')?.textContent).toBe('2');
  expect(getMessages).toHaveBeenCalledTimes(1);
});
