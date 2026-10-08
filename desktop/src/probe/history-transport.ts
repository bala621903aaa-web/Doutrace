import { createHash } from 'node:crypto';
import type { BrowserContext, Frame, Page, Request, Response } from 'playwright-core';
import { decodeHistoryRequest, decodeHistoryResponse, HISTORY_ENDPOINT_PATH, ProtocolDecodeError, type DecodedHistoryResponse, type HistoryRequest } from '../im/protocol.js';
import { decodeInitMessageResponse, decodeInitRequestIdentity, INIT_ENDPOINT_PATH, type InitMessageResponse, type InitRequestIdentity } from '../im/init-protocol.js';
import { WireError } from '../im/wire.js';
import { redactUrl, type RedactedUrl } from './report.js';
import { CLIENT_TIME_MAPPING_SOURCE, CLIENT_MESSAGE_COPY_SOURCE, type ClientTimeSourceEvidence } from './time-mapping-source.js';
import { isTrustedChatUrl, TARGET_CHAT_ORIGIN, TARGET_CHAT_URL } from './session.js';

const SAFE_HOST_SUFFIXES = ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'iesdouyin.com'];
const HISTORY_ENDPOINT_ORIGIN = 'https://imapi.douyin.com';
const MAX_HISTORY_BODY = 4 * 1024 * 1024;
const MAX_CLIENT_SOURCE_BODY = 8 * 1024 * 1024;

function isSafeHost(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return SAFE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function bodyFingerprint(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function isReplayableHeader(name: string) {
  const lower = name.toLowerCase();
  return !['cookie', 'content-length', 'host', 'connection', 'origin', 'referer', 'user-agent', 'accept-encoding', 'transfer-encoding'].includes(lower) &&
    !lower.startsWith('sec-') && !lower.startsWith('proxy-');
}

function replayHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => isReplayableHeader(name)));
}

function trustedReplayHeaders(headers: Record<string, string>) {
  const result = replayHeaders(headers);
  const userAgent = Object.entries(headers).find(([name]) => name.toLowerCase() === 'user-agent')?.[1];
  if (userAgent && userAgent.length <= 512 && !/[\r\n]/.test(userAgent)) result['user-agent'] = userAgent;
  result.origin = TARGET_CHAT_ORIGIN;
  result.referer = TARGET_CHAT_URL;
  return result;
}

export interface CapturedHistoryRequest {
  observedAt: string;
  url: string;
  redactedUrl: RedactedUrl;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  body: Uint8Array;
  decoded: HistoryRequest;
  sourcePage?: Page;
  sourceFrame?: Frame;
  sourcePageUrl?: string;
  sourceFrameUrl?: string;
  sourcePageGeneration?: number;
  sourceFrameGeneration?: number;
}

export interface CapturedHistoryExchange {
  sequence: number;
  observedAt: string;
  request: CapturedHistoryRequest;
  httpStatus: number;
  contentType: string;
  body: Uint8Array | null;
  decoded: DecodedHistoryResponse | null;
  decodeError: string | null;
}

export interface ActiveHistoryResult {
  exchange: CapturedHistoryExchange;
  browserFetchStatus: number | null;
}

export interface CapturedInitExchange {
  observedAt: string;
  httpStatus: number;
  decoded: InitMessageResponse | null;
  decodeError: string | null;
  sourcePage?: Page;
}

export class HistoryNetworkObserver {
  private readonly requests = new Map<Request, CapturedHistoryRequest>();
  private readonly exchanges: CapturedHistoryExchange[] = [];
  private readonly initRequests = new Map<Request, { identity: InitRequestIdentity; sourcePage?: Page; sourcePageGeneration?: number }>();
  private readonly initExchanges: CapturedInitExchange[] = [];
  private readonly timeSourceRequests = new Map<Request, { sourcePage?: Page; sourcePageGeneration?: number }>();
  private readonly timeSources: Array<ClientTimeSourceEvidence & { sourcePage?: Page }> = [];
  private readonly pendingTasks = new Set<Promise<void>>();
  private readonly selfAccountIds = new Map<string, Page | undefined>();
  private readonly trackedPages = new WeakSet<Page>();
  private readonly pageGenerations = new WeakMap<Page, number>();
  private readonly frameGenerations = new WeakMap<Frame, number>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly context: BrowserContext) {
    for (const page of context.pages()) this.trackPage(page);
    context.on('page', page => this.trackPage(page));
    context.on('request', request => this.onRequest(request));
    context.on('response', response => this.onResponse(response));
  }

  private trackPage(page: Page) {
    if (this.trackedPages.has(page)) return;
    this.trackedPages.add(page);
    this.pageGenerations.set(page, 0);
    for (const frame of page.frames()) this.frameGenerations.set(frame, 0);
    page.on('framenavigated', frame => {
      this.frameGenerations.set(frame, (this.frameGenerations.get(frame) ?? 0) + 1);
      if (frame === page.mainFrame()) {
        this.pageGenerations.set(page, (this.pageGenerations.get(page) ?? 0) + 1);
        this.invalidatePage(page);
      } else {
        this.invalidateFrame(frame);
      }
    });
  }

  private invalidatePage(page: Page) {
    for (const [request, captured] of this.requests) if (captured.sourcePage === page) this.requests.delete(request);
    for (const [request, captured] of this.initRequests) if (captured.sourcePage === page) this.initRequests.delete(request);
    for (const [request, captured] of this.timeSourceRequests) if (captured.sourcePage === page) this.timeSourceRequests.delete(request);
    for (let index = this.exchanges.length - 1; index >= 0; index--) if (this.exchanges[index].request.sourcePage === page) this.exchanges.splice(index, 1);
    for (let index = this.initExchanges.length - 1; index >= 0; index--) if (this.initExchanges[index].sourcePage === page) this.initExchanges.splice(index, 1);
    for (let index = this.timeSources.length - 1; index >= 0; index--) if (this.timeSources[index].sourcePage === page) this.timeSources.splice(index, 1);
    for (const [accountId, sourcePage] of this.selfAccountIds) if (sourcePage === page) this.selfAccountIds.delete(accountId);
  }

  private invalidateFrame(frame: Frame) {
    for (const [request, captured] of this.requests) if (captured.sourceFrame === frame) this.requests.delete(request);
    for (let index = this.exchanges.length - 1; index >= 0; index--) if (this.exchanges[index].request.sourceFrame === frame) this.exchanges.splice(index, 1);
  }

  private trustedSource(frame: Frame | null | undefined) {
    if (!frame) return null;
    try {
      const page = frame.page();
      this.trackPage(page);
      if (!isTrustedChatUrl(page.url()) || !isTrustedChatUrl(frame.url()) || frame.isDetached()) return null;
      return {
        page,
        frame,
        pageUrl: page.url(),
        frameUrl: frame.url(),
        pageGeneration: this.pageGenerations.get(page) ?? 0,
        frameGeneration: this.frameGenerations.get(frame) ?? 0
      };
    } catch {
      return null;
    }
  }

  private captureIsCurrent(request: CapturedHistoryRequest) {
    const page = request.sourcePage;
    const frame = request.sourceFrame;
    if (!page || !frame || request.sourcePageGeneration === undefined || request.sourceFrameGeneration === undefined) return false;
    try {
      return !page.isClosed() && !frame.isDetached() && frame.page() === page &&
        this.pageGenerations.get(page) === request.sourcePageGeneration && this.frameGenerations.get(frame) === request.sourceFrameGeneration &&
        isTrustedChatUrl(page.url()) && isTrustedChatUrl(frame.url());
    } catch {
      return false;
    }
  }

  private onRequest(request: Request) {
    if (this.closed || !isSafeHost(request.url())) return;
    const url = new URL(request.url());
    if (request.method() === 'GET' && [CLIENT_TIME_MAPPING_SOURCE.url, CLIENT_MESSAGE_COPY_SOURCE.url].includes(`${url.origin}${url.pathname}`)) {
      const source = this.trustedSource((() => { try { return request.frame(); } catch { return undefined; } })());
      if (source) this.timeSourceRequests.set(request, { sourcePage: source.page, sourcePageGeneration: source.pageGeneration });
      return;
    }
    if (url.origin === HISTORY_ENDPOINT_ORIGIN && url.pathname === INIT_ENDPOINT_PATH) {
      const body = request.postDataBuffer();
      if (request.method() !== 'POST' || !body || body.length > MAX_HISTORY_BODY) return;
      const source = this.trustedSource((() => { try { return request.frame(); } catch { return undefined; } })());
      if (!source) return;
      try {
        this.initRequests.set(request, { identity: decodeInitRequestIdentity(body), sourcePage: source.page, sourcePageGeneration: source.pageGeneration });
      } catch (error) {
        this.initExchanges.push({ observedAt: new Date().toISOString(), httpStatus: 0, decoded: null,
          decodeError: error instanceof ProtocolDecodeError || error instanceof WireError ? error.code : 'init-request-protocol-error', sourcePage: source.page });
      }
      return;
    }
    if (url.origin === HISTORY_ENDPOINT_ORIGIN && url.pathname === HISTORY_ENDPOINT_PATH && !url.username && !url.password) {
      if (request.method() !== 'POST') return;
      const body = request.postDataBuffer();
      if (!body || body.length > MAX_HISTORY_BODY) return;
      const source = this.trustedSource((() => { try { return request.frame(); } catch { return undefined; } })());
      if (!source) return;
      try {
        const decoded = decodeHistoryRequest(body);
        const captured: CapturedHistoryRequest = {
          observedAt: new Date().toISOString(),
          url: request.url(),
          redactedUrl: redactUrl(request.url()),
          method: request.method(),
          resourceType: request.resourceType(),
          headers: request.headers(),
          body: new Uint8Array(body),
          decoded,
          sourcePage: source.page,
          sourceFrame: source.frame,
          sourcePageUrl: source.pageUrl,
          sourceFrameUrl: source.frameUrl,
          sourcePageGeneration: source.pageGeneration,
          sourceFrameGeneration: source.frameGeneration
        };
        this.requests.set(request, captured);
      } catch {
        // Invalid or unrelated binary traffic is left to the existing diagnostic observer.
      }
      return;
    }
    if (/\/aweme\/v1\/web\/user\/profile\/self\/?$/i.test(url.pathname)) {
      const source = this.trustedSource((() => { try { return request.frame(); } catch { return undefined; } })());
      if (!source) return;
      const task = this.readSelfProfile(request, source.page, source.pageGeneration).catch(() => undefined);
      this.pendingTasks.add(task);
      void task.finally(() => this.pendingTasks.delete(task)).catch(() => undefined);
    }
  }

  private async readSelfProfile(request: Request, sourcePage: Page, sourcePageGeneration: number) {
    const response = await request.response();
    if (!response || response.status() < 200 || response.status() >= 300) return;
    if (this.pageGenerations.get(sourcePage) !== sourcePageGeneration || !isTrustedChatUrl(sourcePage.url())) return;
    const contentType = response.headers()['content-type'] || '';
    if (!/json/i.test(contentType)) return;
    const raw = await response.text();
    if (this.pageGenerations.get(sourcePage) !== sourcePageGeneration || !isTrustedChatUrl(sourcePage.url())) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    const visit = (node: unknown, path: string, depth: number) => {
      if (depth > 7 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.slice(0, 20).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (/^(uid|user_id|userId)$/i.test(key) && (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint')) {
          const value = String(child);
          if (/^(?:\d{4,}|[A-Za-z0-9_-]{8,})$/.test(value)) this.selfAccountIds.set(value, sourcePage);
        }
        if (/user|profile|data/i.test(nextPath)) visit(child, nextPath, depth + 1);
      }
    };
    visit(value, '', 0);
  }

  private onResponse(response: Response) {
    if (this.closed) return;
    const request = response.request();
    if (this.timeSourceRequests.has(request)) {
      const source = this.timeSourceRequests.get(request)!;
      this.timeSourceRequests.delete(request);
      const task = this.completeTimeSource(response, source.sourcePage, source.sourcePageGeneration).catch(() => undefined);
      this.pendingTasks.add(task);
      void task.finally(() => this.pendingTasks.delete(task)).catch(() => undefined);
      return;
    }
    const init = this.initRequests.get(request);
    if (init) {
      const task = this.completeInitExchange(response, init).catch(() => undefined);
      this.initRequests.delete(request);
      this.pendingTasks.add(task);
      void task.finally(() => this.pendingTasks.delete(task)).catch(() => undefined);
      return;
    }
    const captured = this.requests.get(request);
    if (!captured) return;
    this.requests.delete(request);
    const task = this.completeExchange(response, captured).catch(() => undefined);
    this.pendingTasks.add(task);
    void task.finally(() => this.pendingTasks.delete(task)).catch(() => undefined);
  }

  private async completeExchange(response: Response, request: CapturedHistoryRequest) {
    let body: Uint8Array | null = null;
    let decoded: DecodedHistoryResponse | null = null;
    let decodeError: string | null = null;
    try {
      const raw = await response.body();
      if (raw.length <= MAX_HISTORY_BODY) {
        body = new Uint8Array(raw);
        try { decoded = decodeHistoryResponse(body); }
        catch (error) { decodeError = error instanceof Error ? error.message : 'unreadable-protocol'; }
      } else {
        decodeError = 'body-too-large';
      }
    } catch (error) {
      decodeError = error instanceof Error ? error.message : 'response-body-unreadable';
    }
    if (!this.captureIsCurrent(request)) return;
    const exchange: CapturedHistoryExchange = {
      sequence: ++this.sequence,
      observedAt: new Date().toISOString(),
      request,
      httpStatus: response.status(),
      contentType: response.headers()['content-type'] || '',
      body,
      decoded,
      decodeError
    };
    this.exchanges.push(exchange);
  }

  listHistoryExchanges(): CapturedHistoryExchange[] {
    return [...this.exchanges];
  }

  private async completeInitExchange(response: Response, request: { identity: InitRequestIdentity; sourcePage?: Page; sourcePageGeneration?: number }) {
    const exchange: CapturedInitExchange = { observedAt: new Date().toISOString(), httpStatus: response.status(), decoded: null, decodeError: null, sourcePage: request.sourcePage };
    try {
      const body = await response.body();
      if (body.length > MAX_HISTORY_BODY) throw new ProtocolDecodeError('body-too-large');
      exchange.decoded = decodeInitMessageResponse(new Uint8Array(body), request.identity);
    } catch (error) {
      exchange.decodeError = error instanceof ProtocolDecodeError || error instanceof WireError ? error.code : 'init-response-protocol-error';
    }
    if (request.sourcePage && request.sourcePageGeneration !== this.pageGenerations.get(request.sourcePage)) return;
    this.initExchanges.push(exchange);
  }

  listInitExchanges(): CapturedInitExchange[] {
    return [...this.initExchanges];
  }

  private async completeTimeSource(response: Response, sourcePage?: Page, sourcePageGeneration?: number) {
    const requestUrl = new URL(response.request().url());
    const sourceUrl = `${requestUrl.origin}${requestUrl.pathname}`;
    const expected = sourceUrl === CLIENT_MESSAGE_COPY_SOURCE.url ? CLIENT_MESSAGE_COPY_SOURCE : CLIENT_TIME_MAPPING_SOURCE;
    const evidence: ClientTimeSourceEvidence & { sourcePage?: Page } = {
      observedAt: new Date().toISOString(), url: sourceUrl,
      httpStatus: response.status(), sha256: null, verified: false, failure: null, sourcePage
    };
    if (evidence.httpStatus < 200 || evidence.httpStatus >= 300) evidence.failure = 'http-error';
    else {
      try {
        const body = await response.body();
        if (body.length > MAX_CLIENT_SOURCE_BODY) evidence.failure = 'body-too-large';
        else {
          evidence.sha256 = bodyFingerprint(body);
          evidence.verified = evidence.sha256 === expected.sha256;
          if (!evidence.verified) evidence.failure = 'hash-mismatch';
        }
      } catch { evidence.failure = 'body-unreadable'; }
    }
    if (sourcePage && sourcePageGeneration !== this.pageGenerations.get(sourcePage)) return;
    this.timeSources.push(evidence);
  }

  listClientTimeSources(): Array<ClientTimeSourceEvidence & { sourcePage?: Page }> {
    return [...this.timeSources];
  }

  async drainPendingResponses(): Promise<void> {
    await Promise.race([Promise.allSettled([...this.pendingTasks]), new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
  }

  selfAccountIdsInMemory(): string[] {
    return [...this.selfAccountIds.keys()];
  }

  latestSequence(): number {
    return this.sequence;
  }

  async sendPage(page: Page | Frame, template: CapturedHistoryRequest, body: Uint8Array, signal: AbortSignal, timeoutMs = 30_000): Promise<ActiveHistoryResult> {
    if (this.closed) throw new Error('history-observer-closed');
    if (signal.aborted) throw new Error('verification-cancelled');
    const isPage = typeof (page as Page).mainFrame === 'function';
    const targetPage = isPage ? page as Page : (page as Frame).page();
    const targetFrame = isPage ? targetPage.mainFrame() : page as Frame;
    this.trackPage(targetPage);
    if (targetPage.context() !== this.context || targetPage !== template.sourcePage || targetFrame !== template.sourceFrame ||
        !this.captureIsCurrent(template) || body.length > MAX_HISTORY_BODY) throw new Error('history-template-context-untrusted');
    let targetUrl: URL;
    try { targetUrl = new URL(template.url); }
    catch { throw new Error('history-template-endpoint-untrusted'); }
    if (template.method.toUpperCase() !== 'POST' || targetUrl.origin !== HISTORY_ENDPOINT_ORIGIN ||
        targetUrl.pathname !== HISTORY_ENDPOINT_PATH || targetUrl.username || targetUrl.password) throw new Error('history-template-endpoint-untrusted');
    let replayIdentity: HistoryRequest;
    try { replayIdentity = decodeHistoryRequest(body); }
    catch { throw new Error('history-template-request-invalid'); }
    if (replayIdentity.conversationId !== template.decoded.conversationId ||
        replayIdentity.conversationShortId !== template.decoded.conversationShortId ||
        replayIdentity.command !== template.decoded.command) throw new Error('history-template-identity-mismatch');

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason ?? new Error('verification-cancelled'));
    const abortForNavigation = (frame: Frame) => {
      if (frame === targetFrame || frame === targetPage.mainFrame()) controller.abort(new Error('history-template-context-untrusted'));
    };
    signal.addEventListener('abort', abortFromCaller, { once: true });
    targetPage.on('framenavigated', abortForNavigation);
    try {
      const response = await this.context.request.post(template.url, {
        headers: trustedReplayHeaders(template.headers),
        data: Buffer.from(body),
        failOnStatusCode: false,
        maxRedirects: 0,
        signal: controller.signal,
        timeout: timeoutMs
      });
      try {
        if (!this.captureIsCurrent(template)) throw new Error('history-template-context-untrusted');
        let responseBody: Uint8Array | null = null;
        let decoded: DecodedHistoryResponse | null = null;
        let decodeError: string | null = null;
        try {
          const raw = await response.body();
          if (raw.length > MAX_HISTORY_BODY) decodeError = 'body-too-large';
          else {
            responseBody = new Uint8Array(raw);
            try { decoded = decodeHistoryResponse(responseBody); }
            catch (error) { decodeError = error instanceof Error ? error.message : 'unreadable-protocol'; }
          }
        } catch (error) {
          decodeError = error instanceof Error ? error.message : 'response-body-unreadable';
        }
        if (!this.captureIsCurrent(template)) throw new Error('history-template-context-untrusted');
        const request: CapturedHistoryRequest = {
          ...template,
          observedAt: new Date().toISOString(),
          body: new Uint8Array(body),
          decoded: replayIdentity
        };
        const exchange: CapturedHistoryExchange = {
          sequence: ++this.sequence,
          observedAt: new Date().toISOString(),
          request,
          httpStatus: response.status(),
          contentType: response.headers()['content-type'] || '',
          body: responseBody,
          decoded,
          decodeError
        };
        this.exchanges.push(exchange);
        return { exchange, browserFetchStatus: response.status() };
      } finally {
        await response.dispose();
      }
    } catch (error) {
      if (signal.aborted) throw new Error('verification-cancelled');
      if (controller.signal.aborted) throw new Error('history-template-context-untrusted');
      throw error;
    } finally {
      signal.removeEventListener('abort', abortFromCaller);
      targetPage.off('framenavigated', abortForNavigation);
    }
  }

  async close(): Promise<number> {
    this.closed = true;
    this.requests.clear();
    this.exchanges.splice(0);
    this.initRequests.clear();
    this.initExchanges.splice(0);
    this.timeSourceRequests.clear();
    this.timeSources.splice(0);
    this.selfAccountIds.clear();
    await Promise.race([
      Promise.allSettled([...this.pendingTasks]),
      new Promise<void>(resolve => setTimeout(resolve, 5_000))
    ]);
    return this.pendingTasks.size;
  }
}
