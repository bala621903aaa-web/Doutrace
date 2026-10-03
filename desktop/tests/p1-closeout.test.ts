import { describe, expect, it } from 'vitest';
import { compareMessagesToRows } from '../src/probe/history-verifier.js';
import { buildLiveVerificationReport, type LivePageFact, type LiveRunFacts } from '../src/probe/live-report.js';
import type { DecodedHistoryMessage } from '../src/im/protocol.js';
import type { PageRowState, PageState } from '../src/probe/page-state.js';

const baseUi = {
  frameOrigin: 'https://www.douyin.com',
  framePathname: '/chat',
  bodyElementCount: 10,
  bodyTextLength: 100,
  selectedCandidateCount: 1,
  messageRowCandidateCount: 10,
  textRowCount: 10,
  timeLabelCount: 10,
  timeLabelShapeCounts: {},
  listCandidateCount: 1,
  scrollCandidateCount: 1,
  conversationStorePresent: true,
  headerPresent: true
};

function state(rows: PageRowState[], scrollTop = 0): PageState {
  return {
    capturedAt: '2026-10-03T00:00:00.000Z',
    origin: 'https://www.douyin.com',
    pathname: '/chat',
    selectedConversationIds: ['conversation-private'],
    selectedTitle: 'private title',
    selfUidCandidates: ['self-private'],
    messageList: { found: true, scrollTop, scrollHeight: 1000, clientHeight: 500, rowCount: rows.length },
    rows,
    ui: baseUi
  };
}

function message(id: number, text: string, timeField10: bigint, extra: Partial<DecodedHistoryMessage> = {}): DecodedHistoryMessage {
  return {
    conversationId: 'conversation-private',
    conversationType: 1n,
    platformMessageId: String(id),
    indexInConversation: BigInt(id),
    conversationShortId: 7n,
    messageType: 1n,
    senderUid: 8n,
    contentJson: JSON.stringify({ text }),
    content: { validJsonObject: true, keys: ['text'], signals: ['text'], text, attachmentUrls: [] },
    extensions: [],
    timeField10,
    senderSecUid: null,
    reference: { present: false, targetMessageId: null, snapshotValidJson: false, malformed: false },
    ...extra
  };
}

function page(messages: DecodedHistoryMessage[], rows: PageRowState[], pageNumber = 1, inputCursor: bigint | null = null, nextCursor: bigint | null = 100n): LivePageFact {
  const beforeState = state(rows);
  const afterState = state(rows);
  return {
    pageNumber,
    source: pageNumber === 1 ? 'initial' : 'active',
    inputCursor,
    nextCursor,
    conversationId: 'conversation-private',
    shortId: 7n,
    sequenceId: 1n,
    httpStatus: 200,
    browserFetchStatus: 200,
    businessStatus: 0n,
    hasMore: true,
    messages,
    beforeState,
    afterState,
    cursorLinkedFromPrevious: pageNumber === 1 ? true : true,
    cursorProgressed: true,
    newPlatformIds: new Set(messages.map(item => item.platformMessageId)).size,
    crossPagePlatformIdIntersection: 0,
    indexRelationToPrevious: pageNumber === 1 ? 'not-applicable' : 'older',
    timeCrossChecks: 0,
    field10PageLabelCrossChecks: 0,
    extensionPageLabelCrossChecks: 0,
    bodyOrderChecks: 0,
    timeUnitEvidence: 'unknown'
  };
}

function facts(task: LiveRunFacts['task'], pages: LivePageFact[], overrides: Partial<LiveRunFacts> = {}): LiveRunFacts {
  return {
    runId: 'run-private',
    task,
    mode: 'normal',
    requestedPages: task === 'chain' ? 3 : task === 'recovery' ? 2 : 1,
    endpointPageLimit: 5,
    startedAt: '2026-10-03T00:00:00.000Z',
    finishedAt: '2026-10-03T00:00:01.000Z',
    browserKind: 'test',
    browserExecutable: 'test',
    targetOrigin: 'https://www.douyin.com',
    targetPathname: '/chat',
    selfAccountIds: ['self-private'],
    selectedConversationIds: ['conversation-private'],
    selectedTitle: 'private title',
    selectedConversationStable: true,
    pages,
    endpoint: { pageNumber: null, reached: false, confirmed: false, confirmationHasMore: null, reason: 'not-attempted' },
    resume: { requested: false, checkpointFound: false, accountMatches: null, conversationMatches: null, shortIdMatches: null, cursorMatches: null, boundaryCompared: false, boundaryRelation: 'unknown', previousRunDifferent: false, checkpointSaved: false, failure: null },
    freshTemplateCaptured: true,
    freshTemplateDecoded: true,
    freshTemplateResponseStatus: 200,
    noScrollViolation: false,
    errors: [],
    ...overrides
  };
}

describe('P1 closeout strict evidence rules', () => {
  it('uses exact, date-aware row matching and rejects bare minutes, duplicates, and wrong dates', () => {
    const timestamps = Array.from({ length: 10 }, (_, index) => BigInt(Date.parse('2026-10-03T00:00:00.000Z') + index * 60_000));
    const messages = timestamps.map((value, index) => message(index + 1, `body-${index}`, value));
    const fullDateRows = timestamps.map((_, index) => ({ text: `body-${index}`, timeLabel: `2026-10-03 08:${String(index).padStart(2, '0')}`, timeAssociation: 'row' as const, markers: [], fromMe: false }));
    const full = compareMessagesToRows(messages, fullDateRows, '2026-10-03T00:00:00.000Z');
    expect(full.matched).toBe(10);
    expect(full.uniqueMatchedMessageIds).toBe(10);
    expect(full.selectedField).toBe('field10');
    expect(full.selectedUnit).toBe('millisecond');
    expect(full.unresolvedConflicts).toBe(0);

    const bareMinute = compareMessagesToRows(messages, fullDateRows.map(row => ({ ...row, timeLabel: row.timeLabel.slice(-5) })), '2026-10-03T00:00:00.000Z');
    expect(bareMinute.matched).toBe(0);
    expect(bareMinute.minuteOnly).toBe(10);

    const duplicateRows = compareMessagesToRows([messages[0]], [fullDateRows[0], fullDateRows[0]], '2026-10-03T00:00:00.000Z');
    expect(duplicateRows.ambiguous).toBe(1);
    expect(duplicateRows.matched).toBe(0);

    const wrongDate = compareMessagesToRows([messages[0]], [{ ...fullDateRows[0], timeLabel: '2026-10-04 08:00' }], '2026-10-03T00:00:00.000Z');
    expect(wrongDate.outOfWindow).toBe(1);
    expect(wrongDate.matched).toBe(0);
  });

  it('uses an exact platform message key when rendered text differs', () => {
    const value = BigInt(Date.parse('2026-10-03T00:00:00.000Z'));
    const result = compareMessagesToRows(
      [message(42, 'wire-body', value)],
      [{ text: 'rendered-body', messageKey: '42', timeLabel: '2026-10-03 08:00', timeAssociation: 'row', markers: [], fromMe: false }],
      '2026-10-03T00:00:00.000Z'
    );
    expect(result.matched).toBe(1);
    expect(result.uniqueMatchedMessageIds).toBe(1);
    expect(result.selectedField).toBe('field10');
  });

  it('keeps task reports independent and never opens the formal gate', () => {
    const one = [message(1, 'one', 1_759_440_000_000n)];
    const chainPages = [page(one, [{ text: 'one', timeLabel: '', markers: [], fromMe: false }], 1, null, 100n), page([message(2, 'two', 1_759_440_060_000n)], [{ text: 'two', timeLabel: '', markers: [], fromMe: false }], 2, 100n, 200n), page([message(3, 'three', 1_759_440_120_000n)], [{ text: 'three', timeLabel: '', markers: [], fromMe: false }], 3, 200n, 300n)];
    const report = buildLiveVerificationReport(facts('chain', chainPages));
    expect(report.requirements.find(item => item.key === 'three-pages-no-scroll')?.status).toBe('pass');
    expect(report.requirements.find(item => item.key === 'history-end')?.status).toBe('not-run');
    expect(report.formalCollection).toBe('closed');
    expect(report.p2GateOpen).toBe(false);
    expect(JSON.stringify(report)).not.toContain('conversation-private');
  });

  it('requires endpoint re-read evidence instead of treating page-limit as an end', () => {
    const endpointPage = page([message(1, 'last', 1_759_440_000_000n)], [{ text: 'last', timeLabel: '', markers: [], fromMe: false }]);
    const incomplete = buildLiveVerificationReport(facts('endpoint', [endpointPage], { endpoint: { pageNumber: 1, reached: false, confirmed: false, confirmationHasMore: null, reason: 'page-limit' } }));
    expect(incomplete.requirements.find(item => item.key === 'history-end')?.status).toBe('inconclusive');

    const complete = buildLiveVerificationReport(facts('endpoint', [endpointPage], { endpoint: { pageNumber: 1, reached: true, confirmed: true, confirmationHasMore: false, reason: 'explicit-end', recheckMatches: true, recheckMessageCount: 1, recheckOrderMatches: true, sessionMatches: true } }));
    expect(complete.requirements.find(item => item.key === 'history-end')?.status).toBe('pass');
    expect(complete.formalCollection).toBe('closed');
  });

  it('does not pass recovery from a parseable cursor alone', () => {
    const recovery = buildLiveVerificationReport(facts('recovery', [page([message(1, 'one', 1_759_440_000_000n)], [{ text: 'one', timeLabel: '', markers: [], fromMe: false }])], {
      mode: 'resume',
      resume: { requested: true, checkpointFound: true, accountMatches: true, conversationMatches: true, shortIdMatches: true, cursorMatches: true, boundaryCompared: true, boundaryRelation: 'disjoint', previousRunDifferent: true, checkpointSaved: true, failure: null }
    }));
    expect(recovery.requirements.find(item => item.key === 'cursor-recovery')?.status).toBe('inconclusive');
  });
});
