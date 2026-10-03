import { createHash } from 'node:crypto';
import type { BrowserContext, Frame, Page, Request, Response } from 'playwright-core';
import { decodeHistoryRequest, decodeHistoryResponse, HISTORY_ENDPOINT_PATH, ProtocolDecodeError, type DecodedHistoryResponse, type HistoryRequest } from '../im/protocol.js';
import { decodeInitMessageResponse, decodeInitRequestIdentity, INIT_ENDPOINT_PATH, type InitMessageResponse, type InitRequestIdentity } from '../im/init-protocol.js';
import { WireError } from '../im/wire.js';
import { redactUrl, type RedactedUrl } from './report.js';
import { CLIENT_TIME_MAPPING_SOURCE, CLIENT_MESSAGE_COPY_SOURCE, type ClientTimeSourceEvidence } from './time-mapping-source.js';

const SAFE_HOST_SUFFIXES = ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'iesdouyin.com'];
const MAX_HISTORY_BODY = 4 * 1024 * 1024;
const MAX_CLIENT_SOURCE_BODY = 8 * 1024 * 1024;

function isSafeHost(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
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

interface Waiter {
  afterSequence: number;
  url: string;
  bodyHash: string;
  resolve: (exchange: CapturedHistoryExchange) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private readonly initRequests = new Map<Request, { identity: InitRequestIdentity; sourcePage?: Page }>();
  private readonly initExchanges: CapturedInitExchange[] = [];
  private readonly timeSourceRequests = new Map<Request, Page | undefined>();
  private readonly timeSources: Array<ClientTimeSourceEvidence & { sourcePage?: Page }> = [];
  private readonly pendingTasks = new Set<Promise<void>>();
  private readonly waiters = new Set<Waiter>();
  private readonly selfAccountIds = new Set<string>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly context: BrowserContext) {
    context.on('request', request => this.onRequest(request));
    context.on('response', response => this.onResponse(response));
  }

  private onRequest(request: Request) {
    if (this.closed || !isSafeHost(request.url())) return;
    const url = new URL(request.url());
    if (request.method() === 'GET' && [CLIENT_TIME_MAPPING_SOURCE.url, CLIENT_MESSAGE_COPY_SOURCE.url].includes(`${url.origin}${url.pathname}`)) {
      this.timeSourceRequests.set(request, (() => { try { return request.frame()?.page(); } catch { return undefined; } })());
      return;
    }
    if (url.pathname === INIT_ENDPOINT_PATH) {
      const body = request.postDataBuffer();
      if (request.method() !== 'POST' || !body || body.length > MAX_HISTORY_BODY) return;
      const sourcePage = (() => { try { return request.frame()?.page(); } catch { return undefined; } })();
      try {
        this.initRequests.set(request, { identity: decodeInitRequestIdentity(body), sourcePage });
      } catch (error) {
        this.initExchanges.push({ observedAt: new Date().toISOString(), httpStatus: 0, decoded: null,
          decodeError: error instanceof ProtocolDecodeError || error instanceof WireError ? error.code : 'init-request-protocol-error', sourcePage });
      }
      return;
    }
    if (url.pathname === HISTORY_ENDPOINT_PATH) {
      if (request.method() !== 'POST') return;
      const body = request.postDataBuffer();
      if (!body || body.length > MAX_HISTORY_BODY) return;
      try {
        const decoded = decodeHistoryRequest(body);
        const sourceFrame = (() => { try { return request.frame() ?? undefined; } catch { return undefined; } })();
        const captured: CapturedHistoryRequest = {
          observedAt: new Date().toISOString(),
          url: request.url(),
          redactedUrl: redactUrl(request.url()),
          method: request.method(),
          resourceType: request.resourceType(),
          headers: request.headers(),
          body: new Uint8Array(body),
          decoded,
          sourcePage: sourceFrame?.page(),
          sourceFrame
        };
        this.requests.set(request, captured);
      } catch {
        // Invalid or unrelated binary traffic is left to the existing diagnostic observer.
      }
      return;
    }
    if (/\/aweme\/v1\/web\/user\/profile\/self\/?$/i.test(url.pathname)) {
      const task = this.readSelfProfile(request).catch(() => undefined);
      this.pendingTasks.add(task);
      void task.finally(() => this.pendingTasks.delete(task)).catch(() => undefined);
    }
  }

  private async readSelfProfile(request: Request) {
    const response = await request.response();
    if (!response || response.status() < 200 || response.status() >= 300) return;
    const contentType = response.headers()['content-type'] || '';
    if (!/json/i.test(contentType)) return;
    const raw = await response.text();
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
          if (/^(?:\d{4,}|[A-Za-z0-9_-]{8,})$/.test(value)) this.selfAccountIds.add(value);
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
      const sourcePage = this.timeSourceRequests.get(request);
      this.timeSourceRequests.delete(request);
      const task = this.completeTimeSource(response, sourcePage).catch(() => undefined);
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
    for (const waiter of [...this.waiters]) {
      if (exchange.sequence > waiter.afterSequence && request.url === waiter.url && bodyFingerprint(request.body) === waiter.bodyHash) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(exchange);
      }
    }
  }

  listHistoryExchanges(): CapturedHistoryExchange[] {
    return [...this.exchanges];
  }

  private async completeInitExchange(response: Response, request: { identity: InitRequestIdentity; sourcePage?: Page }) {
    const exchange: CapturedInitExchange = { observedAt: new Date().toISOString(), httpStatus: response.status(), decoded: null, decodeError: null, sourcePage: request.sourcePage };
    try {
      const body = await response.body();
      if (body.length > MAX_HISTORY_BODY) throw new ProtocolDecodeError('body-too-large');
      exchange.decoded = decodeInitMessageResponse(new Uint8Array(body), request.identity);
    } catch (error) {
      exchange.decodeError = error instanceof ProtocolDecodeError || error instanceof WireError ? error.code : 'init-response-protocol-error';
    }
    this.initExchanges.push(exchange);
  }

  listInitExchanges(): CapturedInitExchange[] {
    return [...this.initExchanges];
  }

  private async completeTimeSource(response: Response, sourcePage?: Page) {
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
    this.timeSources.push(evidence);
  }

  listClientTimeSources(): Array<ClientTimeSourceEvidence & { sourcePage?: Page }> {
    return [...this.timeSources];
  }

  async drainPendingResponses(): Promise<void> {
    await Promise.race([Promise.allSettled([...this.pendingTasks]), new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
  }

  selfAccountIdsInMemory(): string[] {
    return [...this.selfAccountIds];
  }

  latestSequence(): number {
    return this.sequence;
  }

  waitForExchange(input: { url: string; body: Uint8Array; afterSequence?: number; timeoutMs: number; signal: AbortSignal }): Promise<CapturedHistoryExchange> {
    if (input.signal.aborted) return Promise.reject(new Error('verification-cancelled'));
    const afterSequence = input.afterSequence ?? this.sequence;
    const bodyHash = bodyFingerprint(input.body);
    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        onAbort && input.signal.removeEventListener('abort', onAbort);
        reject(new Error('history-response-timeout'));
      }, input.timeoutMs);
      const waiter: Waiter = { afterSequence, url: input.url, bodyHash, resolve, reject, timer };
      this.waiters.add(waiter);
      onAbort = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        reject(new Error('verification-cancelled'));
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      const originalResolve = resolve;
      const originalReject = reject;
      waiter.resolve = exchange => {
        input.signal.removeEventListener('abort', onAbort);
        originalResolve(exchange);
      };
      waiter.reject = error => {
        input.signal.removeEventListener('abort', onAbort);
        originalReject(error);
      };
      for (const exchange of this.exchanges) {
        if (exchange.sequence > afterSequence && exchange.request.url === input.url && bodyFingerprint(exchange.request.body) === bodyHash) {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          waiter.resolve(exchange);
          break;
        }
      }
    });
  }

  async sendPage(page: Page | Frame, template: CapturedHistoryRequest, body: Uint8Array, signal: AbortSignal, timeoutMs = 30_000): Promise<ActiveHistoryResult> {
    if (this.closed) throw new Error('history-observer-closed');
    if (signal.aborted) throw new Error('verification-cancelled');
    const afterSequence = this.sequence;
    const responsePromise = this.waitForExchange({ url: template.url, body, afterSequence, timeoutMs, signal });
    const browserFetchPromise = page.evaluate(async ({ url, headers, body: bytes }) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: new Uint8Array(bytes),
          credentials: 'include'
        });
        await response.arrayBuffer();
        return { status: response.status, failed: false };
      } catch {
        return { status: null, failed: true };
      }
    }, { url: template.url, headers: replayHeaders(template.headers), body: [...body] }).catch(() => ({ status: null, failed: true }));
    const observed = await responsePromise;
    const browserFetchStatus = (await browserFetchPromise).status;
    return { exchange: observed, browserFetchStatus };
  }

  async close(): Promise<number> {
    this.closed = true;
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('history-observer-closed'));
    }
    this.waiters.clear();
    await Promise.race([
      Promise.allSettled([...this.pendingTasks]),
      new Promise<void>(resolve => setTimeout(resolve, 5_000))
    ]);
    return this.pendingTasks.size;
  }
}
