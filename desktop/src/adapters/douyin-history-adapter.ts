import { HistoryNetworkObserver, type CapturedHistoryExchange, type CapturedHistoryRequest } from '../probe/history-transport.js';
import { readPageState } from '../probe/page-state.js';
import { isTrustedChatUrl, startBrowserProbeSession, TARGET_CHAT_ORIGIN, TARGET_CHAT_PATH, TARGET_CHAT_URL, type BrowserProbeSession } from '../probe/session.js';
import { readWireFields, requiredWireBytes, wireVarint } from '../im/wire.js';
import type { AccountInfo, CapturedMessage, ConversationInfo, HistoryAdapter, HistoryPage, NormalizedMessage } from '../core/contracts.js';
import { normalizeDecodedHistoryMessage } from '../core/message-normalizer.js';
import { isAllowedDouyinMediaUrl } from '../core/media-url.js';

const ACCOUNT_WAIT_MS = 8_000;
const EXCHANGE_WAIT_MS = 15_000;

export interface BrowserHistoryAdapterOptions {
  onStatus?: (message: string) => void;
  onContextInvalidated?: () => Promise<void> | void;
}

interface ConversationDirectoryItem {
  conversationId: string;
  title: string;
  participantIds: string[];
}

const CONVERSATION_DIRECTORY_SCRIPT = String.raw`(() => {
  const asString = value => (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') ? String(value).trim() : '';
  const idsFrom = value => {
    const found = new Set();
    const visit = (node, depth = 0) => {
      if (!node || depth > 4) return;
      if (Array.isArray(node)) { node.slice(0, 80).forEach(item => visit(item, depth + 1)); return; }
      if (typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        if (/^(uid|userId|user_id|participantId|participant_id|memberId|member_id)$/i.test(key)) {
          const id = asString(child); if (id) found.add(id);
        } else if (/participant|member|user|owner|friend/i.test(key)) visit(child, depth + 1);
      }
    };
    visit(value);
    return [...found].slice(0, 32);
  };
  const result = new Map();
  const add = (id, title, participants) => {
    id = asString(id); if (!id || id.length > 256) return;
    const current = result.get(id) || { conversationId: id, title: '', participantIds: [] };
    if (title && title.length < 256 && (!current.title || current.title === id)) current.title = title;
    current.participantIds = [...new Set([...current.participantIds, ...participants])].slice(0, 32);
    result.set(id, current);
  };
  try {
    const store = window.conversationStore;
    const map = store?.conversationMap;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [key, value] of Object.entries(map)) {
        if (!value || typeof value !== 'object') { add(key, '', []); continue; }
        const id = value.id ?? value.conversationId ?? value.conversation_id ?? key;
        const title = value.title ?? value.name ?? value.nickname ?? value.displayName ?? value.display_name ?? '';
        add(id, asString(title), idsFrom(value));
      }
    }
  } catch {}
  const nodes = [...document.querySelectorAll('[data-e2e*="conversation" i], [class*="conversation" i], [data-conversation-id]')];
  for (const node of nodes.slice(0, 300)) {
    const id = node.getAttribute('data-conversation-id') || node.getAttribute('data-conv-id') || node.getAttribute('data-id') || '';
    const titleNode = node.querySelector('[class*="name" i], [class*="title" i], [class*="nickname" i], [data-e2e*="name" i]');
    const title = titleNode?.textContent?.trim() || node.textContent?.trim().split(/\n+/).find(Boolean) || '';
    add(id, title, []);
  }
  return [...result.values()].filter(item => item.conversationId).slice(0, 300);
})()`;

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

function messageSort(left: NormalizedMessage, right: NormalizedMessage) {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    try { return BigInt(String(left.sequence)) < BigInt(String(right.sequence)) ? -1 : BigInt(String(left.sequence)) > BigInt(String(right.sequence)) ? 1 : 0; } catch { /* fall through */ }
  }
  if (left.sentAtMs !== null && right.sentAtMs !== null) return left.sentAtMs - right.sentAtMs;
  return (left.platformMessageId ?? '').localeCompare(right.platformMessageId ?? '');
}

export function mergeInitialAndHistoryMessages<T extends NormalizedMessage>(initial: T[], history: T[]): T[] {
  const merged = new Map<string, T>();
  for (const message of [...history, ...initial]) {
    if (!message.platformMessageId) throw new Error('message-id-missing');
    const key = `id:${message.platformMessageId}`;
    merged.set(key, message);
  }
  return [...merged.values()].sort(messageSort);
}

function decodedExchange(exchange: CapturedHistoryExchange) {
  if (!exchange.decoded || exchange.decoded.state !== 'decoded') throw new Error(exchange.decodeError ?? 'history-response-unavailable');
  if (exchange.httpStatus < 200 || exchange.httpStatus >= 300 || exchange.decoded.statusCode !== 0n) throw new Error('history-response-error');
  return exchange.decoded;
}

export class DouyinHistoryAdapter implements HistoryAdapter {
  private readonly session: BrowserProbeSession;
  private readonly observer: HistoryNetworkObserver;
  private readonly templates = new Map<string, CapturedHistoryRequest>();
  private closed = false;

  private constructor(session: BrowserProbeSession, observer: HistoryNetworkObserver, private readonly options: BrowserHistoryAdapterOptions = {}) {
    this.session = session;
    this.observer = observer;
    session.page.on('framenavigated', frame => {
      if (frame !== session.page.mainFrame()) return;
      this.templates.clear();
      void Promise.resolve(options.onContextInvalidated?.()).catch(() => {
        options.onStatus?.('浏览器页面已变化，请重新刷新会话列表。');
      });
    });
  }

  static async open(options: BrowserHistoryAdapterOptions = {}) {
    const session = await startBrowserProbeSession(() => options.onStatus?.('浏览器窗口已关闭。'));
    const observer = new HistoryNetworkObserver(session.context);
    try {
      await session.page.goto(TARGET_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      await session.close();
      throw new Error(`打开抖音聊天页失败：${error instanceof Error ? error.message : String(error)}`);
    }
    options.onStatus?.('独立浏览器已打开，请正常登录并选择一个既有单人私聊。');
    return new DouyinHistoryAdapter(session, observer, options);
  }

  get page() { return this.session.page; }
  get browserSession() { return this.session; }

  private assertTrustedPage() {
    if (this.closed || !isTrustedChatUrl(this.session.page.url())) {
      this.templates.clear();
      throw new Error('history-page-context-untrusted');
    }
  }

  private async readTrustedPageState() {
    this.assertTrustedPage();
    const state = await readPageState(this.session.page.mainFrame());
    this.assertTrustedPage();
    if (state.origin !== TARGET_CHAT_ORIGIN || state.pathname !== TARGET_CHAT_PATH) throw new Error('history-page-context-untrusted');
    return state;
  }

  private async selectedConversationId() {
    const state = await this.readTrustedPageState();
    return state.selectedConversationIds[0] ?? null;
  }

  private async waitForSelfAccount() {
    const deadline = Date.now() + ACCOUNT_WAIT_MS;
    while (Date.now() < deadline) {
      this.assertTrustedPage();
      const ids = this.observer.selfAccountIdsInMemory();
      if (ids.length > 1) throw new Error('account-identity-changed');
      if (ids.length === 1) return ids[0];
      await sleep(250);
    }
    throw new Error('account-identity-unavailable:请确认已正常登录并等待页面完成加载');
  }

  async getAccount(): Promise<AccountInfo> {
    this.assertTrustedPage();
    const accountId = await this.waitForSelfAccount();
    return { accountId, source: 'douyin.self-profile' };
  }

  async listPrivateConversations(): Promise<ConversationInfo[]> {
    this.assertTrustedPage();
    const directory = await this.session.page.evaluate(CONVERSATION_DIRECTORY_SCRIPT) as ConversationDirectoryItem[];
    const selected = await this.readTrustedPageState().catch(() => null);
    this.assertTrustedPage();
    const result = new Map<string, ConversationInfo>();
    for (const item of directory) {
      if (!item.conversationId) continue;
      result.set(item.conversationId, { conversationId: item.conversationId, title: item.title || item.conversationId, participantIds: item.participantIds ?? [], source: 'douyin.conversationStore-or-dom' });
    }
    for (const id of selected?.selectedConversationIds ?? []) {
      if (!result.has(id)) result.set(id, { conversationId: id, title: selected?.selectedTitle || id, participantIds: [], source: 'douyin.selected-conversation' });
    }
    if (!selected || selected.selectedConversationIds.length !== 1) throw new Error('请先在独立浏览器选择一条单人私聊。');
    const id = selected.selectedConversationIds[0];
    const exchange = await this.waitForExchange(id, null);
    const decoded = decodedExchange(exchange);
    const envelope = readWireFields(exchange.request.body);
    const query = readWireFields(requiredWireBytes(readWireFields(requiredWireBytes(envelope, 8)), 301));
    if (wireVarint(query, 2) !== 1n || decoded.messages.some(message => message.conversationType !== 1n)) throw new Error('仅支持单人私聊，请在浏览器选择另一条会话。');
    const item = result.get(id);
    return [{ conversationId: id, title: selected.selectedTitle || item?.title || '当前私聊', participantIds: item?.participantIds ?? [], source: 'douyin.selected-private-conversation' }];
  }

  private async waitForExchange(conversationId: string, cursor: string | null, signal?: AbortSignal) {
    const deadline = Date.now() + EXCHANGE_WAIT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('capture-cancelled');
      const matches = this.observer.listHistoryExchanges().filter(exchange => exchange.request.decoded.conversationId === conversationId && exchange.decoded?.state === 'decoded');
      const exact = cursor === null
        ? matches.find(exchange => exchange.request.decoded.cursor === null) ?? matches[0]
        : matches.find(exchange => exchange.request.decoded.cursor?.toString() === cursor);
      if (exact) return exact;
      await sleep(250);
    }
    throw new Error(cursor === null ? 'history-initial-exchange-not-captured' : 'history-response-timeout');
  }

  private async selectedConversationMatches(conversationId: string) {
    const selected = await this.selectedConversationId();
    if (!selected || selected !== conversationId) throw new Error('conversation-changed');
  }

  private async normalizePage(accountId: string, conversationId: string, exchange: CapturedHistoryExchange, includeInitial: boolean): Promise<HistoryPage> {
    const decoded = decodedExchange(exchange);
    if (exchange.request.decoded.conversationId !== conversationId) throw new Error('conversation-response-mismatch');
    if (decoded.messages.some(message => message.conversationId !== conversationId || message.conversationShortId !== exchange.request.decoded.conversationShortId)) throw new Error('message-identity-mismatch');
    const history = decoded.messages.map(message => normalizeDecodedHistoryMessage(message, accountId));
    const initial: CapturedMessage[] = [];
    const shortId = exchange.request.decoded.conversationShortId;
    if (includeInitial) {
      for (const exchange of this.observer.listInitExchanges()) {
        if (!exchange.decoded || exchange.decoded.statusCode !== 0n) continue;
        for (const message of exchange.decoded.messages) {
          if (message.conversationId === conversationId && message.conversationShortId === shortId) initial.push(normalizeDecodedHistoryMessage(message, accountId));
        }
      }
    }
    return {
      accountId, conversationId, messages: includeInitial ? mergeInitialAndHistoryMessages(initial, history) : history,
      nextCursor: decoded.nextCursor?.toString() ?? null, hasMore: decoded.hasMore, source: 'douyin.im.get_by_conversation'
    };
  }

  async fetchHistory(input: { conversationId: string; cursor: string | null; signal: AbortSignal }): Promise<HistoryPage> {
    if (this.closed) throw new Error('adapter-closed');
    if (input.signal.aborted) throw new Error('capture-cancelled');
    this.assertTrustedPage();
    await this.selectedConversationMatches(input.conversationId);
    const account = await this.getAccount();
    if (input.cursor === null) {
      const exchange = await this.waitForExchange(input.conversationId, null, input.signal);
      this.templates.set(input.conversationId, exchange.request);
      return this.normalizePage(account.accountId, input.conversationId, exchange, true);
    }
    const template = this.templates.get(input.conversationId) ?? (await this.waitForExchange(input.conversationId, null, input.signal)).request;
    const cursor = BigInt(input.cursor);
    const sequenceId = template.decoded.sequenceId === null ? undefined : template.decoded.sequenceId + 1n;
    const body = (await import('../im/protocol.js')).updateHistoryRequest(template.body, { cursor, sequenceId });
    const frame = template.sourceFrame;
    if (!frame || frame.isDetached()) {
      this.templates.delete(input.conversationId);
      throw new Error('history-template-context-untrusted');
    }
    let result;
    try { result = await this.observer.sendPage(frame, template, body, input.signal); }
    catch (error) {
      if (error instanceof Error && /history-template-context-untrusted|history-template-endpoint-untrusted/.test(error.message)) this.templates.delete(input.conversationId);
      throw error;
    }
    await this.selectedConversationMatches(input.conversationId);
    this.templates.set(input.conversationId, result.exchange.request);
    return this.normalizePage(account.accountId, input.conversationId, result.exchange, false);
  }

  async downloadAttachment(url: string, signal?: AbortSignal) {
    if (this.closed) throw new Error('adapter-closed');
    if (signal?.aborted) throw new Error('attachment-cancelled');
    if (!isAllowedDouyinMediaUrl(url)) throw new Error('attachment-url-not-allowed');
    const response = await this.session.context.request.get(url, { timeout: 30_000, failOnStatusCode: false, maxRedirects: 0, signal });
    try {
      if (signal?.aborted) throw new Error('attachment-cancelled');
      if (!response.ok()) throw new Error(`attachment-http-${response.status()}`);
      return { bytes: new Uint8Array(await response.body()), mime: response.headers()['content-type'] || '' };
    } finally { await response.dispose(); }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.observer.close();
    await this.session.close();
  }
}
