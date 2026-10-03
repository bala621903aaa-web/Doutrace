import { describe, expect, it } from 'vitest';
import type { DecodedHistoryMessage } from '../src/im/protocol.js';
import type { PageRowState } from '../src/probe/page-state.js';
import { associateCopiedMessageInfo } from '../src/probe/message-info-time.js';
import { compareMessagesToRows } from '../src/probe/time-evidence.js';
import { collectMessageInfoTimes } from '../src/probe/message-info-time.js';
import { PAGE_STATE_EVALUATOR, type PageState } from '../src/probe/page-state.js';
import { JSDOM } from 'jsdom';
import type { Page } from 'playwright-core';

const epoch = BigInt(Date.parse('2026-10-03T00:00:00.123Z'));
const message: DecodedHistoryMessage = {
  platformMessageId: '8111000000000001000', conversationId: 'private-chat', conversationShortId: 123n,
  indexInConversation: 456n, messageType: 1n, senderUid: 8n, contentJson: '{"text":"private-body"}',
  content: { text: 'private-body' } as DecodedHistoryMessage['content'], timeField10: epoch,
  extensions: [], conversationType: 1n, senderSecUid: null,
  reference: { present: false, targetMessageId: null, snapshotValidJson: false, malformed: false }
};
const row: PageRowState = { text: 'private-body', timeLabel: '前天', timeLabels: ['前天'], timeAssociation: 'row', fromMe: false, sideKnown: true, markers: [] };
const info = {
  userId: '9', serverId: message.platformMessageId, conversationId: 'private-chat', conversationShortId: '123',
  indexInConversation: '456', sender: '8', content: message.contentJson,
  createdAt: `${epoch} Sat Oct 03 2026 08:00:00 GMT+0800 (China Standard Time)`
};
function parse(changes: Record<string, unknown> = {}, candidate = message, selectedRow = row) {
  return associateCopiedMessageInfo(JSON.stringify({ ...info, ...changes }), selectedRow, [candidate], '9', 'private-chat');
}

describe('official message-info UI time evidence', () => {
  it('retains the full 64-bit ID and a real complete instant, including subsecond precision', () => {
    const result = parse();
    expect(result).toMatchObject({ unit: 'millisecond', row: { messageKey: '8111000000000001000', timeLabel: '2026-10-03T00:00:00.123Z' } });
    if ('row' in result) {
      const evidence = compareMessagesToRows([message], [result.row], '2026-10-04T00:00:00Z', '9', 'field10');
      expect(evidence.matched).toBe(1);
      expect(evidence.keyMatches).toBe(1);
      expect(evidence.selectedUnit).toBe('millisecond');
    }
  });

  it('proves seconds through equality to the copied Date rather than number length', () => {
    const wholeEpoch = epoch - 123n;
    expect(parse({ createdAt: `${wholeEpoch} Sat Oct 03 2026 08:00:00 GMT+0800 (China Standard Time)` }, { ...message, timeField10: wholeEpoch / 1_000n })).toMatchObject({ unit: 'second' });
    expect(parse({}, { ...message, timeField10: epoch + 1n })).toEqual({ failure: 'copy-wire-time-mismatch' });
  });

  it('rejects clipboard output from another account, conversation or message', () => {
    expect(parse({ userId: '10' })).toEqual({ failure: 'copy-identity-mismatch' });
    expect(parse({ conversationId: 'other' })).toEqual({ failure: 'copy-identity-mismatch' });
    expect(parse({ serverId: '8111000000000001001' })).toEqual({ failure: 'copy-message-not-covered' });
    expect(parse({ serverId: Number(message.platformMessageId) })).toEqual({ failure: 'copy-identity-mismatch' });
  });

  it('requires matching server content, sender, short ID and index in addition to message ID', () => {
    for (const change of [{ content: '{"text":"other"}' }, { sender: '7' }, { conversationShortId: '124' }, { indexInConversation: '457' }]) {
      expect(parse(change)).toEqual({ failure: 'copy-message-mismatch' });
    }
  });

  it('requires the rendered body and sender side to agree with the copied row', () => {
    expect(parse({}, message, { ...row, text: 'private' })).toEqual({ failure: 'copy-row-mismatch' });
    expect(parse({}, message, { ...row, fromMe: true })).toEqual({ failure: 'copy-row-mismatch' });
    expect(parse({}, message, { ...row, sideKnown: false })).toEqual({ failure: 'copy-row-mismatch' });
  });

  it('rejects missing calendar, unsupported timezone and an inconsistent Date string', () => {
    expect(parse({ createdAt: String(epoch) })).toEqual({ failure: 'copy-full-time-missing' });
    expect(parse({ createdAt: `${epoch} Sat Oct 03 2026 08:00:00 GMT+0000 (UTC)` })).toEqual({ failure: 'copy-full-time-missing' });
    expect(parse({ createdAt: `${epoch} Sun Oct 04 2026 08:00:00 GMT+0800 (China Standard Time)` })).toEqual({ failure: 'copy-calendar-mismatch' });
  });

  it('does not conceal a date contradiction with an existing complete row label', () => {
    const result = parse({}, message, { ...row, timeLabel: '2026-10-02 08:00', timeLabels: ['2026-10-02 08:00'] });
    expect('row' in result).toBe(true);
    if ('row' in result) expect(compareMessagesToRows([message], [result.row], '2026-10-04T00:00:00Z', '9', 'field10').unresolvedConflicts).toBe(1);
  });

  it('reports fixed failure codes and never repeats malformed clipboard data', () => {
    expect(associateCopiedMessageInfo('private-secret', row, [message], '9', 'private-chat')).toEqual({ failure: 'copy-not-json' });
    expect(associateCopiedMessageInfo('x'.repeat(1_000_001), row, [message], '9', 'private-chat')).toEqual({ failure: 'copy-too-large' });
    expect(associateCopiedMessageInfo('[]', row, [message], '9', 'private-chat')).toEqual({ failure: 'copy-not-object' });
  });

  it('observes the copy helper DOM selection even if clipboard output becomes empty, then removes the listener and restores text', async () => {
    const dom = new JSDOM('<div class="messageMessageListlist"><div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox"><span class="TextMessageTextpureText">private-body</span></div></div></div>', { url: 'https://www.douyin.com/chat', runScripts: 'outside-only' });
    (dom.window as unknown as { conversationStore: unknown }).conversationStore = { curConversationId: 'private-chat' };
    let clipboard = 'original-private-clipboard';
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { readText: async () => clipboard, writeText: async (value: string) => { clipboard = value; } } });
    const evaluate = async (expression: string | ((argument: unknown) => unknown), argument?: unknown) =>
      typeof expression === 'string' ? dom.window.eval(expression) : (dom.window.eval(`(${expression.toString()})`) as (argument: unknown) => unknown)(argument);
    let gestures = 0;
    const frame = {
      url: () => 'https://www.douyin.com/chat', evaluate,
      locator: () => ({ nth: () => ({ dispatchEvent: async () => {
        if (++gestures !== 5) return;
        const span = dom.window.document.createElement('span');
        span.textContent = JSON.stringify(info);
        span.setAttribute('aria-hidden', 'true');
        span.style.position = 'fixed';
        dom.window.document.body.appendChild(span);
        const range = dom.window.document.createRange();
        range.selectNodeContents(span);
        dom.window.getSelection()!.addRange(range);
        dom.window.document.dispatchEvent(new dom.window.Event('copy'));
        clipboard = '';
        dom.window.getSelection()!.removeAllRanges();
        span.remove();
      } }) })
    };
    const page = { frames: () => [frame], evaluate, context: () => ({ grantPermissions: async () => {}, clearPermissions: async () => {} }) } as unknown as Page;
    const state = { ...dom.window.eval(PAGE_STATE_EVALUATOR) as Omit<PageState, 'selfUidCandidates'>, selfUidCandidates: [] };
    const result = await collectMessageInfoTimes({ page, state, messages: [message], account: '9', conversation: 'private-chat', signal: new AbortController().signal });
    expect(result.diagnostics).toMatchObject({ attempted: 1, accepted: 1, copyEvents: 1, clipboardOutputFormats: { empty: 1 }, clipboardRestored: true, rejected: {} });
    expect(clipboard).toBe('original-private-clipboard');
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/private-body|original-private-clipboard|8111000000000001000/);
    expect(Object.keys(dom.window).filter(key => key.startsWith('__p1Copy_'))).toEqual([]);
    dom.window.close();
  });
});
