import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Frame, Page, Request, Response } from 'playwright-core';
import { decodeHistoryRequest } from '../src/im/protocol.js';
import { encodeWireFields, type WireField } from '../src/im/wire.js';
import { HistoryNetworkObserver, type CapturedHistoryRequest } from '../src/probe/history-transport.js';
import { TARGET_CHAT_URL } from '../src/probe/session.js';

const v = (number: number, value: bigint): WireField => ({ number, wireType: 0, value });
const b = (number: number, value: Uint8Array): WireField => ({ number, wireType: 2, value });
const t = (number: number, value: string) => b(number, new TextEncoder().encode(value));
const pack = (...fields: WireField[]) => encodeWireFields(fields);

const initialBody = pack(v(1, 301n), v(2, 9n), b(8, pack(b(301, pack(t(1, 'private-conversation'), v(3, 7n), v(4, 1n), v(5, 120n), v(6, 50n))))));
const nextBody = pack(v(1, 301n), v(2, 10n), b(8, pack(b(301, pack(t(1, 'private-conversation'), v(3, 7n), v(4, 1n), v(5, 100n), v(6, 50n))))));
const responseBody = pack(v(1, 301n), v(2, 10n), v(3, 0n), b(6, pack(b(301, pack(v(2, 80n), v(3, 1n))))));

function fixture(postImpl?: (url: string, options: Record<string, unknown>) => Promise<unknown>) {
  const pageListeners = new Map<string, Set<(value: unknown) => void>>();
  const contextListeners = new Map<string, (value: unknown) => void>();
  let currentUrl = TARGET_CHAT_URL;
  let context: BrowserContext;
  let page: Page;
  let frame: Frame;
  const evaluate = vi.fn(async () => { throw new Error('page-evaluate-must-not-run'); });
  const on = (event: string, listener: (value: unknown) => void) => {
    const listeners = pageListeners.get(event) ?? new Set();
    listeners.add(listener);
    pageListeners.set(event, listeners);
  };
  const off = (event: string, listener: (value: unknown) => void) => pageListeners.get(event)?.delete(listener);
  frame = {
    url: () => currentUrl,
    page: () => page,
    isDetached: () => false
  } as unknown as Frame;
  page = {
    url: () => currentUrl,
    mainFrame: () => frame,
    frames: () => [frame],
    context: () => context,
    isClosed: () => false,
    evaluate,
    on,
    off
  } as unknown as Page;
  const post = vi.fn((url: string, options: Record<string, unknown>) => postImpl
    ? postImpl(url, options)
    : Promise.resolve({
      body: async () => responseBody,
      status: () => 200,
      headers: () => ({ 'content-type': 'application/x-protobuf' }),
      dispose: vi.fn(async () => {})
    }));
  context = {
    pages: () => [page],
    on: (event: string, listener: (value: unknown) => void) => contextListeners.set(event, listener),
    request: { post }
  } as unknown as BrowserContext;
  const observer = new HistoryNetworkObserver(context);
  const template: CapturedHistoryRequest = {
    observedAt: new Date().toISOString(),
    url: 'https://imapi.douyin.com/v1/message/get_by_conversation?aid=6383',
    redactedUrl: { origin: 'https://imapi.douyin.com', pathname: '/v1/message/get_by_conversation', queryKeys: ['aid'] },
    method: 'POST', resourceType: 'xhr',
    headers: {
      authorization: 'Bearer private-auth-token',
      cookie: 'private-cookie=never-copy',
      origin: 'https://www.douyin.com',
      referer: 'https://www.douyin.com/chat?conversation_id=do-not-forward',
      'user-agent': 'Mozilla/5.0 Unit Browser',
      'sec-fetch-site': 'same-site',
      'content-type': 'application/x-protobuf'
    },
    body: initialBody,
    decoded: decodeHistoryRequest(initialBody),
    sourcePage: page,
    sourceFrame: frame,
    sourcePageUrl: TARGET_CHAT_URL,
    sourceFrameUrl: TARGET_CHAT_URL,
    sourcePageGeneration: 0,
    sourceFrameGeneration: 0
  };
  return {
    observer, template, page, frame, context, post, evaluate,
    navigate(url: string) {
      currentUrl = url;
      for (const listener of [...(pageListeners.get('framenavigated') ?? [])]) listener(frame);
    },
    emitRequest(request: Request) { contextListeners.get('request')?.(request); },
    emitResponse(response: Response) { contextListeners.get('response')?.(response); }
  };
}

describe('history replay trust boundary', () => {
  it('replays only through the trusted main-process request client and filters browser-managed headers', async () => {
    const state = fixture();
    const signal = new AbortController().signal;
    const result = await state.observer.sendPage(state.frame, state.template, nextBody, signal, 4_000);
    const [url, options] = state.post.mock.calls[0];
    const headers = options.headers as Record<string, string>;

    expect(url).toBe(state.template.url);
    expect(options).toMatchObject({ failOnStatusCode: false, maxRedirects: 0, timeout: 4_000 });
    expect(headers).toMatchObject({ authorization: 'Bearer private-auth-token', 'content-type': 'application/x-protobuf' });
    expect(headers).toMatchObject({ origin: 'https://www.douyin.com', referer: TARGET_CHAT_URL, 'user-agent': 'Mozilla/5.0 Unit Browser' });
    expect(headers).not.toHaveProperty('cookie');
    expect(headers.referer).not.toContain('do-not-forward');
    expect(headers).not.toHaveProperty('sec-fetch-site');
    expect(decodeHistoryRequest(new Uint8Array(options.data as Buffer)).cursor).toBe(100n);
    expect(result.exchange.decoded?.state).toBe('decoded');
    expect(result.browserFetchStatus).toBe(200);
    expect(state.evaluate).not.toHaveBeenCalled();
    await state.observer.close();
  });

  it('rejects another page and cancels an active replay when its trusted page navigates away', async () => {
    const rejected = fixture();
    const other = fixture();
    other.navigate('https://attacker.example/chat');
    await expect(rejected.observer.sendPage(other.frame, rejected.template, nextBody, new AbortController().signal)).rejects.toThrow('history-template-context-untrusted');
    expect(rejected.post).not.toHaveBeenCalled();
    await rejected.observer.close();
    await other.observer.close();

    const navigating = fixture((_url, options) => new Promise((_resolve, reject) => {
      (options.signal as AbortSignal).addEventListener('abort', () => reject(new Error('request-aborted')), { once: true });
    }));
    const send = navigating.observer.sendPage(navigating.frame, navigating.template, nextBody, new AbortController().signal);
    navigating.navigate('https://attacker.example/');
    await expect(send).rejects.toThrow('history-template-context-untrusted');
    expect(navigating.post).toHaveBeenCalledTimes(1);
    expect(navigating.evaluate).not.toHaveBeenCalled();
    await navigating.observer.close();
  });

  it('rejects an unexpected same-origin path and a detached source frame before replay', async () => {
    const wrongPath = fixture();
    wrongPath.navigate('https://www.douyin.com/account');
    await expect(wrongPath.observer.sendPage(wrongPath.frame, wrongPath.template, nextBody, new AbortController().signal))
      .rejects.toThrow('history-template-context-untrusted');
    expect(wrongPath.post).not.toHaveBeenCalled();
    await wrongPath.observer.close();

    const detached = fixture();
    Object.assign(detached.frame, { isDetached: () => true });
    await expect(detached.observer.sendPage(detached.frame, detached.template, nextBody, new AbortController().signal))
      .rejects.toThrow('history-template-context-untrusted');
    expect(detached.post).not.toHaveBeenCalled();
    await detached.observer.close();
  });

  it('captures history only from the trusted chat document and drops exchanges after navigation', async () => {
    const state = fixture();
    const hostileFrame = {
      url: () => 'https://attacker.example/chat',
      page: () => state.page,
      isDetached: () => false
    } as unknown as Frame;
    const hostileRequest = {
      url: () => state.template.url,
      method: () => 'POST',
      postDataBuffer: () => initialBody,
      headers: () => ({}),
      resourceType: () => 'xhr',
      frame: () => hostileFrame
    } as unknown as Request;
    state.emitRequest(hostileRequest);
    state.emitResponse({ request: () => hostileRequest, body: async () => responseBody, status: () => 200, headers: () => ({}) } as unknown as Response);
    await state.observer.drainPendingResponses();
    expect(state.observer.listHistoryExchanges()).toHaveLength(0);

    const goodRequest = {
      url: () => state.template.url,
      method: () => 'POST',
      postDataBuffer: () => initialBody,
      headers: () => ({}),
      resourceType: () => 'xhr',
      frame: () => state.frame
    } as unknown as Request;
    state.emitRequest(goodRequest);
    state.emitResponse({
      request: () => goodRequest,
      body: async () => responseBody,
      status: () => 200,
      headers: () => ({ 'content-type': 'application/x-protobuf' })
    } as unknown as Response);
    await state.observer.drainPendingResponses();
    expect(state.observer.listHistoryExchanges()).toHaveLength(1);

    state.navigate('https://attacker.example/');
    expect(state.observer.listHistoryExchanges()).toHaveLength(0);
    expect(state.observer.selfAccountIdsInMemory()).toEqual([]);
    await state.observer.close();
  });
});
