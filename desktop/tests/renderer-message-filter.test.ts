import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const html = await readFile(fileURLToPath(new URL('../src/renderer/index.html', import.meta.url)), 'utf8');
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

beforeEach(async () => {
  getMessages = vi.fn(async (_input: { query?: string; limit?: number; offset?: number }) => messages);
  recordMediaEvidence = vi.fn(async () => ({ evidence: {} }));
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.assign(window, { CSS: { escape: (value: string) => value }, desktopArchive: {
        getState: async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '离线' }),
        getContext: async () => ({
          account: { accountId: 'account', source: 'test' }, conversations: [],
          archivedConversations: [{ accountId: 'account', conversationId: 'conversation', title: 'Mock 档案', messageCount: 5000 }],
          collector: { state: 'idle' }, repair: { running: false, lastResult: null }, exporting: false
        }),
        getMessages,
        getAttachments: async () => [{ id: 'voice-attachment', messagePk: 'voice-unknown', assetState: 'current', status: 'saved' }],
        getMediaUrl: async () => ({ url: 'file:///mock.wav', fileVersion: 'mock-version', mime: 'audio/wav', family: 'audio', evidence: {} }),
        recordMediaEvidence,
        onEvent: () => () => {}
      } });
    }
  });
  scrollIntoView = vi.fn();
  dom.window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(messages.length));
});

afterEach(() => dom.window.close());

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
