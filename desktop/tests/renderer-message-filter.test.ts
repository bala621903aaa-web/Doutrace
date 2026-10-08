import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const html = await readFile(fileURLToPath(new URL('../src/renderer/index.html', import.meta.url)), 'utf8');
const messages = [
  { messagePk: 'text-parsed', platformMessageId: '1', senderId: 'sender', sentAtMs: 1_700_000_000_000, kind: 'text', contentStatus: 'parsed', text: '普通文字' },
  { messagePk: 'image-partial', platformMessageId: '2', senderId: 'sender', sentAtMs: 1_700_000_000_001, kind: 'image', contentStatus: 'partial', text: '图片说明' },
  { messagePk: 'voice-unknown', platformMessageId: '3', senderId: 'sender', sentAtMs: 1_700_000_000_002, kind: 'voice', contentStatus: 'unknown', text: '语音待解析' },
  { messagePk: 'image-parsed', platformMessageId: '4', senderId: 'sender', sentAtMs: 1_700_000_000_003, kind: 'image', contentStatus: 'parsed', text: '<img src=x onerror="alert(1)">' },
  { messagePk: 'video-legacy', platformMessageId: '5', senderId: 'sender', sentAtMs: 1_700_000_000_004, kind: 'video-file', contentStatus: 'legacy-missing', text: '旧视频' }
];

let dom: JSDOM;
let getMessages: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  getMessages = vi.fn(async () => messages);
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.assign(window, { desktopArchive: {
        getState: async () => ({ acquisitionEnabled: false, connected: false, browserStatus: '离线' }),
        getContext: async () => ({
          account: { accountId: 'account', source: 'test' }, conversations: [],
          archivedConversations: [{ accountId: 'account', conversationId: 'conversation', title: 'Mock 档案', messageCount: 5000 }],
          collector: { state: 'idle' }, repair: { running: false, lastResult: null }, exporting: false
        }),
        getMessages,
        getAttachments: async () => [],
        onEvent: () => () => {}
      } });
    }
  });
  await vi.waitFor(() => expect(visibleIds()).toHaveLength(messages.length));
});

afterEach(() => dom.window.close());

function visibleIds() {
  return [...dom.window.document.querySelectorAll<HTMLElement>('#messages .message')].map(row => row.dataset.platformId);
}

function changeFilter(id: string, value: string) {
  const select = dom.window.document.getElementById(id) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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
