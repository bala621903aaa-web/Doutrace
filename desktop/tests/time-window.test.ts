import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { decodeInitMessageResponse, decodeInitRequestIdentity } from '../src/im/init-protocol.js';
import { decodeMessage, type DecodedHistoryMessage } from '../src/im/protocol.js';
import { encodeWireFields, type WireField } from '../src/im/wire.js';
import { PAGE_STATE_EVALUATOR, type PageRowState, type PageState } from '../src/probe/page-state.js';
import { compareMessagesToRows, parsePageTimeLabel } from '../src/probe/time-evidence.js';
import { collectVisibleMessageWindow } from '../src/probe/time-window.js';
import { runVisibleTimeVerification } from '../src/probe/time-verifier.js';
import { buildLiveVerificationReport } from '../src/probe/live-report.js';
import { HistoryNetworkObserver, type CapturedInitExchange, type CapturedHistoryExchange } from '../src/probe/history-transport.js';
import type { BrowserContext, Request, Response } from 'playwright-core';
import type { HistoryVerificationOptions } from '../src/probe/history-verifier.js';
import { CLIENT_TIME_MAPPING_SOURCE } from '../src/probe/time-mapping-source.js';

const v = (number: number, value: bigint): WireField => ({ number, wireType: 0, value });
const b = (number: number, value: Uint8Array): WireField => ({ number, wireType: 2, value });
const t = (number: number, value: string): WireField => b(number, new TextEncoder().encode(value));
const pack = (...fields: WireField[]) => encodeWireFields(fields);
const epoch = BigInt(Date.parse('2026-10-03T00:00:00.000Z'));
const conversationId = 'private-conversation';

function messageBytes(id: number, text = `private-body-${id}`, conversation = conversationId) {
  return pack(t(1, conversation), v(2, 1n), v(3, 8_111_000_000_000_001_000n + BigInt(id)), v(4, BigInt(10_000 - id)),
    v(5, 7n), v(6, 1n), v(7, 8n), t(8, JSON.stringify({ text })), v(10, epoch + BigInt(id) * 60_000n));
}
const message = (id: number, text?: string, conversation?: string) => decodeMessage(messageBytes(id, text, conversation));
const requestBytes = pack(v(1, 2043n), v(2, 11n), b(8, pack(b(2043, pack(v(2, 0n))))));
const request = decodeInitRequestIdentity(requestBytes);
function initBody(messages: Uint8Array[], conversation = conversationId, short = 7n) {
  return pack(b(1, pack(b(1, pack(t(1, conversation), v(2, short))), ...messages.map(bytes => b(2, bytes)))));
}
function response(body: Uint8Array, sequence = 11n, status = 0n) {
  return pack(v(1, 2043n), v(2, sequence), v(3, status), b(6, pack(b(2043, body))));
}
function initExchange(messages: DecodedHistoryMessage[]): CapturedInitExchange {
  return { observedAt: '2026-10-03T00:30:00.000Z', httpStatus: 200, decoded: { command: 2043n, sequenceId: 11n, statusCode: 0n, conversationCount: 1, messages }, decodeError: null };
}
function historyExchange(messages: DecodedHistoryMessage[]): CapturedHistoryExchange {
  return {
    sequence: 1, observedAt: '2026-10-03T00:30:00.000Z', httpStatus: 200, contentType: 'application/x-protobuf', body: null, decodeError: null,
    request: { observedAt: '', url: 'https://imapi.douyin.com/v1/message/get_by_conversation', redactedUrl: { origin: 'https://imapi.douyin.com', pathname: '/v1/message/get_by_conversation', queryKeys: [] }, method: 'POST', resourceType: 'xhr', headers: {}, body: new Uint8Array(), decoded: { command: 301n, sequenceId: 1n, conversationId, conversationShortId: 7n, direction: 1n, cursor: 1n, limit: 50, raw: new Uint8Array() } },
    decoded: { state: 'decoded', command: 301n, sequenceId: 1n, statusCode: 0n, hasMore: true, nextCursor: 2n, messages, raw: new Uint8Array() }
  };
}
function row(id: number, overrides: Partial<PageRowState> = {}): PageRowState {
  return { text: `private-body-${id}`, timeLabel: `2026-10-03 08:${String(id).padStart(2, '0')}`, timeAssociation: 'row', markers: [], fromMe: false, sideKnown: true, ...overrides };
}
function domState(markup: string): PageState {
  const dom = new JSDOM(markup, { url: 'https://www.douyin.com/chat', runScripts: 'outside-only' });
  (dom.window as unknown as { conversationStore: unknown }).conversationStore = { curConversationId: conversationId };
  const state = dom.window.eval(PAGE_STATE_EVALUATOR) as PageState;
  dom.window.close();
  return { ...state, capturedAt: '2026-10-03T00:30:00.000Z', selfUidCandidates: [] };
}

describe('passive initialization and rendered-window calibration', () => {
  it('decodes the observed init wrapper without losing 64-bit message IDs', () => {
    const decoded = decodeInitMessageResponse(response(initBody([messageBytes(1), messageBytes(2)])), request);
    expect(decoded.messages.map(item => item.platformMessageId)).toEqual(['8111000000000001001', '8111000000000001002']);
    expect(decoded.messages[0].timeField10).toBe(epoch + 60_000n);
    expect(decoded.conversationCount).toBe(1);
  });

  it('rejects wrong response sequence and message/conversation membership', () => {
    expect(() => decodeInitMessageResponse(response(initBody([messageBytes(1)]), 12n), request)).toThrow('init-response-request-mismatch');
    expect(() => decodeInitMessageResponse(response(initBody([messageBytes(1, undefined, 'other-conversation')])), request)).toThrow('init-message-identity-mismatch');
    expect(() => decodeInitMessageResponse(response(initBody([messageBytes(1)], conversationId, 9n)), request)).toThrow('init-message-identity-mismatch');
  });

  it('does not turn an empty or failed init response into a history endpoint', () => {
    const empty = decodeInitMessageResponse(response(new Uint8Array()), request);
    expect(empty.messages).toEqual([]);
    expect(empty).not.toHaveProperty('hasMore');
    expect(decodeInitMessageResponse(response(new Uint8Array(), 11n, 5n), request).statusCode).toBe(5n);
  });

  it('observes normal init exchanges and reports bounded decode errors without keeping the request', async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const context = { on: (event: string, listener: (value: unknown) => void) => listeners.set(event, listener) } as unknown as BrowserContext;
    const observer = new HistoryNetworkObserver(context);
    const normalRequest = { url: () => 'https://imapi.douyin.com/v1/message/get_message_by_init', method: () => 'POST', postDataBuffer: () => requestBytes, frame: () => undefined } as unknown as Request;
    listeners.get('request')!(normalRequest);
    const normalResponse = { request: () => normalRequest, body: async () => response(initBody([messageBytes(1)])), status: () => 200 } as unknown as Response;
    listeners.get('response')!(normalResponse);
    await observer.drainPendingResponses();
    expect(observer.listInitExchanges()[0].decoded?.messages).toHaveLength(1);
    expect(observer.listInitExchanges()[0]).not.toHaveProperty('body');
    listeners.get('request')!({ ...normalRequest, postDataBuffer: () => new Uint8Array([0x80]) });
    expect(observer.listInitExchanges()[1].decodeError).toBe('truncated-varint');
    expect(observer.listInitExchanges()[1].httpStatus).toBe(0);
    const scriptRequest = { url: () => CLIENT_TIME_MAPPING_SOURCE.url, method: () => 'GET', frame: () => undefined } as unknown as Request;
    listeners.get('request')!(scriptRequest);
    listeners.get('response')!({ request: () => scriptRequest, body: async () => new TextEncoder().encode('unverified source'), status: () => 200 });
    await observer.drainPendingResponses();
    expect(observer.listClientTimeSources()[0].verified).toBe(false);
    expect(observer.listClientTimeSources()[0].failure).toBe('hash-mismatch');
    await observer.close();
  });

  it('uses init messages that cover the DOM even when the last history page has no overlap', () => {
    const current = Array.from({ length: 10 }, (_, index) => message(index));
    const older = Array.from({ length: 20 }, (_, index) => message(index + 20));
    const window = collectVisibleMessageWindow({ conversationId, initialization: [initExchange([...current, message(50, 'foreign', 'another-conversation')])], history: [historyExchange(older)] });
    expect(window.messages).toHaveLength(30);
    expect(window.messages.every(item => item.conversationId === conversationId)).toBe(true);
    const evidence = compareMessagesToRows(window.messages, current.map((_, index) => row(index)), '2026-10-03T00:30:00.000Z', '9');
    expect(evidence.matched).toBe(10);
    expect(evidence.uniqueMatchedMessageIds).toBe(10);
    expect(evidence.orderChecks).toBe(10);
  });

  it('deduplicates identical cross-source messages but excludes conflicting time versions', () => {
    const base = message(0);
    const window = collectVisibleMessageWindow({ conversationId, initialization: [initExchange([base])], history: [historyExchange([{ ...base, extensions: [{ key: 'read-receipt', value: 'changed' }] }])] });
    expect(window.messages).toHaveLength(1);
    expect(window.duplicateSourceMessages).toBe(1);
    const conflict = collectVisibleMessageWindow({ conversationId, initialization: [initExchange([base])], history: [historyExchange([{ ...base, timeField10: epoch + 60_000n }])] });
    expect(conflict.conflictingMessageIds).toBe(1);
    expect(conflict.messages).toEqual([]);
  });

  it('keeps distinct message rows and reads sender side from the content box', () => {
    const state = domState(`<div class="messageMessageListlist messageMessageBoxgroup"><div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox messageMessageBoxisFromMe"><span class="TextMessageTextpureText">one</span></div><div class="MessageBoxTimetimeLayout">今天 08:00</div></div><div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox"><span class="TextMessageTextpureText">two</span></div></div></div>`);
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0].fromMe).toBe(true);
    expect(state.rows[1].fromMe).toBe(false);
    expect(state.rows[0].timeLabel).toBe('今天 08:00');
  });

  it('does not treat a message/card title as a time or generic data-id as a platform ID', () => {
    const state = domState(`<div class="messageMessageListlist"><div class="messageMessageBoxmessageBox" data-id="8111000000000001000"><div class="messageMessageBoxcontentBox"><span class="TextMessageTextpureText" title="2026-10-03 08:00">2026-10-03 08:00</span></div></div></div>`);
    expect(state.rows[0].timeAssociation).toBe('none');
    expect(state.rows[0].messageKey).toBe(null);
  });

  it('rejects repeated API bodies, opposite sender sides, and case/space changes', () => {
    const base = message(0);
    const repeated = compareMessagesToRows([base, { ...message(1), content: base.content }], [row(0)], '2026-10-03T00:30:00.000Z', '9');
    expect(repeated.matched).toBe(0);
    expect(repeated.ambiguous).toBeGreaterThan(0);
    expect(compareMessagesToRows([base], [row(0, { fromMe: true })], '2026-10-03T00:30:00.000Z', '9').matched).toBe(0);
    expect(compareMessagesToRows([base], [row(0, { text: 'PRIVATE-BODY-0' })]).matched).toBe(0);
    expect(compareMessagesToRows([message(0, 'a b')], [row(0, { text: 'ab' })]).matched).toBe(0);
  });

  it('resolves equivalent tooltip/display dates but rejects contradictory dates', () => {
    const base = message(0);
    const equivalent = compareMessagesToRows([base], [row(0, { timeAssociation: 'ambiguous', timeLabels: ['今天 08:00', '2026-10-03 08:00'] })], '2026-10-03T00:30:00.000Z');
    expect(equivalent.matched).toBe(1);
    const conflicting = compareMessagesToRows([base], [row(0, { timeAssociation: 'ambiguous', timeLabels: ['2026-10-04 08:00'] })], '2026-10-03T00:30:00.000Z');
    expect(conflicting.matched).toBe(0);
    expect(conflicting.unresolvedConflicts).toBe(1);
  });

  it('requires an actual year, validates calendar dates, and anchors yesterday across new year', () => {
    expect(parsePageTimeLabel('1月1日 08:00', '2026-10-03T00:30:00.000Z')).toBeNull();
    expect(parsePageTimeLabel('2026-02-31 08:00', '2026-10-03T00:30:00.000Z')).toBeNull();
    expect(parsePageTimeLabel('2026-10-03T00:00:00.000Z', '2026-10-03T00:30:00.000Z')?.value).toEqual({ year: 2026, month: 10, day: 3, hour: 8, minute: 0 });
    expect(parsePageTimeLabel('2026-02-31T00:00:00Z', '2026-10-03T00:30:00.000Z')).toBeNull();
    expect(parsePageTimeLabel('2026-10-03T00:00:00', '2026-10-03T00:30:00.000Z')).toBeNull();
    expect(parsePageTimeLabel('昨天 23:00', '2025-12-31T17:00:00.000Z')?.value).toEqual({ year: 2025, month: 12, day: 31, hour: 23, minute: 0 });
  });

  it('requires verified rendering provenance to resolve equal-minute field candidates', () => {
    const base = { ...message(0), extensions: [{ key: 's:server_message_create_time', value: epoch.toString() }] };
    const withoutSource = compareMessagesToRows([base], [row(0)], '2026-10-03T00:30:00.000Z', '9');
    expect(withoutSource.matched).toBe(0);
    expect(withoutSource.unresolvedConflicts).toBe(1);
    const sourced = compareMessagesToRows([base], [row(0)], '2026-10-03T00:30:00.000Z', '9', 'field10');
    expect(sourced.matched).toBe(1);
    expect(sourced.selectedField).toBe('field10');
    expect(sourced.selectedUnit).toBe('millisecond');
    expect(sourced.sameMinuteCandidateMatches).toBe(1);
    expect(sourced.unresolvedConflicts).toBe(0);
    const wrongPrimary = compareMessagesToRows([{ ...base, timeField10: epoch - 86_400_000n }], [row(0)], '2026-10-03T00:30:00.000Z', '9', 'field10');
    expect(wrongPrimary.matched).toBe(0);
    expect(wrongPrimary.outOfWindow).toBe(1);
  });

  it('stops an uncovered static window without sending an active history request', async () => {
    const state = domState(`<div class="messageMessageListlist"><div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox"><span class="TextMessageTextpureText">not in captured responses</span></div><div class="MessageBoxTimetimeLayout">今天 08:00</div></div></div>`);
    const page = { isClosed: () => false, frames: () => [{ evaluate: async () => state }] };
    const sendPage = vi.fn(() => { throw new Error('time must not replay history'); });
    const options = { session: { page, executable: { kind: 'test', path: 'test' } }, observer: { drainPendingResponses: async () => {}, listInitExchanges: () => [{ ...initExchange([message(0)]), sourcePage: page }], listHistoryExchanges: () => [], listClientTimeSources: () => [], selfAccountIdsInMemory: () => ['9'], sendPage }, signal: new AbortController().signal, timeSnapshots: 5, onMessage: () => {} } as unknown as HistoryVerificationOptions;
    const facts = await runVisibleTimeVerification(options, { runId: 'unit-only', startedAt: '2026-10-03T00:00:00.000Z', suite: null });
    expect(facts.timeSnapshots).toHaveLength(1);
    expect(facts.timeStopReason).toBe('window-not-covered');
    expect(sendPage).not.toHaveBeenCalled();
    expect(buildLiveVerificationReport(facts).verdict).toBe('inconclusive');
  });

  it('counts unique messages across snapshots and omits private raw values from the report', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index));
    const state = domState(`<div class="messageMessageListlist">${messages.map((_, index) => `<div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox"><span class="TextMessageTextpureText">private-body-${index}</span></div><div class="MessageBoxTimetimeLayout">2026-10-03 08:${String(index).padStart(2, '0')}</div></div>`).join('')}</div>`);
    const page = { isClosed: () => false, frames: () => [{ evaluate: async () => state }] };
    const options = { session: { page, executable: { kind: 'test', path: 'test' } }, observer: { drainPendingResponses: async () => {}, listInitExchanges: () => [{ ...initExchange(messages), sourcePage: page }], listHistoryExchanges: () => [], listClientTimeSources: () => [{ observedAt: '', url: CLIENT_TIME_MAPPING_SOURCE.url, httpStatus: 200, sha256: CLIENT_TIME_MAPPING_SOURCE.sha256, verified: true, failure: null, sourcePage: page }], selfAccountIdsInMemory: () => ['9'] }, signal: new AbortController().signal, timeSnapshots: 1, onMessage: () => {} } as unknown as HistoryVerificationOptions;
    const facts = await runVisibleTimeVerification(options, { runId: 'unit-only', startedAt: '2026-10-03T00:00:00.000Z', suite: null });
    const report = buildLiveVerificationReport(facts);
    expect(report.requirements.find(item => item.key === 'sent-time')?.status).toBe('pass');
    expect(report.evidenceComplete).toBe(false); // synthetic tests never register in a live suite
    expect(report.p2GateOpen).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/private-body|private-conversation|8111000000000001000/);
    const duplicate = buildLiveVerificationReport({ ...facts, timeSnapshots: [facts.timeSnapshots![0], facts.timeSnapshots![0]].map(snapshot => ({ ...snapshot, evidence: { ...snapshot.evidence, matched: 6, matchedMessageIds: snapshot.evidence.matchedMessageIds!.slice(0, 6) } })) });
    expect(duplicate.requirements.find(item => item.key === 'sent-time')?.status).toBe('inconclusive');
    const missingSource = buildLiveVerificationReport({ ...facts, timeSnapshots: facts.timeSnapshots!.map(snapshot => ({ ...snapshot, mappingSourceVerified: false, mappingSources: [] })) });
    expect(missingSource.requirements.find(item => item.key === 'sent-time')?.status).toBe('inconclusive');
  });
});
