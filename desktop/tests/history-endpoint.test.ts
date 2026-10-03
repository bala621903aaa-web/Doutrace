import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { decodeHistoryRequest, decodeMessage } from '../src/im/protocol.js';
import { encodeWireFields, type WireField } from '../src/im/wire.js';
import { runHistoryVerification, type HistoryVerificationOptions } from '../src/probe/history-verifier.js';
import type { CapturedHistoryExchange } from '../src/probe/history-transport.js';

const v = (number: number, value: bigint): WireField => ({ number, wireType: 0, value });
const b = (number: number, value: Uint8Array): WireField => ({ number, wireType: 2, value });
const t = (number: number, value: string) => b(number, new TextEncoder().encode(value));
const pack = (...fields: WireField[]) => encodeWireFields(fields);
const conversation = 'unit-private-chat';

async function fixture(run: (options: HistoryVerificationOptions, initial: CapturedHistoryExchange) => Promise<void>, finalHasMore = false) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'p1-endpoint-unit-'));
  await mkdir(join(fixtureRoot, 'desktop'));
  vi.stubEnv('LOCALAPPDATA', fixtureRoot);
  const dom = new JSDOM('<div class="messageMessageListlist"></div>', { url: 'https://www.douyin.com/chat', runScripts: 'outside-only' });
  (dom.window as unknown as { conversationStore: unknown }).conversationStore = { curConversationId: conversation };
  const frame = { url: () => 'https://www.douyin.com/chat', isDetached: () => false, evaluate: async (expression: string) => dom.window.eval(expression) };
  const page = { frames: () => [frame], isClosed: () => false, url: frame.url, waitForTimeout: async () => {} };
  function exchange(cursor: bigint, nextCursor: bigint, hasMore: boolean, index: bigint): CapturedHistoryExchange {
    const body = pack(v(1, 301n), v(2, 1n), b(8, pack(b(301, pack(t(1, conversation), v(3, 7n), v(4, 1n), v(5, cursor), v(6, 50n))))));
    const message = decodeMessage(pack(t(1, conversation), v(3, index + 8_000_000_000_000_000_000n), v(4, index), v(5, 7n), v(6, 1n), v(7, 8n), t(8, '{"text":"unit-private-body"}'), v(10, 1_790_985_600_000n)));
    return {
      sequence: 1, observedAt: new Date().toISOString(), httpStatus: 200, contentType: 'application/x-protobuf', body: null, decodeError: null,
      request: { observedAt: '', url: 'https://imapi.douyin.com/v1/message/get_by_conversation', method: 'POST', resourceType: 'xhr', headers: {}, body, decoded: decodeHistoryRequest(body), redactedUrl: { origin: 'https://imapi.douyin.com', pathname: '/v1/message/get_by_conversation', queryKeys: [] }, sourcePage: page, sourceFrame: frame },
      decoded: { state: 'decoded', command: 301n, sequenceId: 1n, statusCode: 0n, hasMore, nextCursor, messages: [message], raw: new Uint8Array() }
    } as unknown as CapturedHistoryExchange;
  }
  const initial = exchange(200n, 100n, true, 150n);
  const end = exchange(100n, 90n, finalHasMore, 95n);
  const options = {
    session: { page, executable: { kind: 'unit-only', path: 'unit-only' } },
    observer: { listHistoryExchanges: () => [initial], selfAccountIdsInMemory: () => ['9'], sendPage: async () => ({ exchange: end, browserFetchStatus: 200 }) },
    task: 'endpoint', suiteId: 'unit-endpoint', pages: 3, maxPages: 2, resume: false, workspaceRoot: join(fixtureRoot, 'desktop'), signal: new AbortController().signal, onMessage: () => {}
  } as unknown as HistoryVerificationOptions;
  try { await run(options, initial); }
  finally {
    vi.unstubAllEnvs();
    dom.window.close();
    const target = resolve(fixtureRoot);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('p1-endpoint-unit-')) throw new Error('invalid-unit-cleanup-path');
    await rm(target, { recursive: true, force: true });
  }
}

describe('real endpoint workflow state propagation (synthetic exchanges only)', () => {
  it('retains verified selected-session identity when a later page reaches the end and is reread', async () => {
    await fixture(async options => {
      const result = await runHistoryVerification(options);
      expect(result.report.endpoint).toMatchObject({ reached: true, confirmed: true, reason: 'explicit-end', sessionMatches: true, recheckMatches: true, recheckOrderMatches: true });
      expect(result.report.requirements.find(item => item.key === 'history-end')?.status).toBe('pass');
    });
  });

  it('records page-limit and keeps the gate closed while the actual response still has more', async () => {
    await fixture(async options => {
      const result = await runHistoryVerification(options);
      expect(result.report.endpoint).toMatchObject({ reached: false, reason: 'page-limit', sessionMatches: true });
      expect(result.report.requirements.find(item => item.key === 'history-end')?.status).toBe('inconclusive');
    }, true);
  });

  it('refuses a batch baseline that was not observed in this process and page session', async () => {
    await fixture(async (options, initial) => {
      const result = await runHistoryVerification({ ...options, initialExchange: { ...initial } });
      expect(result.report.completedPages).toBe(0);
      expect(result.report.verdict).toBe('inconclusive');
      expect(result.report.errors.length).toBeGreaterThan(0);
    });
  });
});
