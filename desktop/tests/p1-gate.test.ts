import { describe, expect, it } from 'vitest';
import { buildLiveVerificationReport, type LiveRunFacts } from '../src/probe/live-report.js';

describe('independent P1 gate', () => {
  it('keeps formal collection closed when no live exchange exists', () => {
    const facts: LiveRunFacts = {
      runId: 'unit-run',
      mode: 'normal',
      requestedPages: 3,
      endpointPageLimit: 20,
      startedAt: '2026-10-03T00:00:00.000Z',
      finishedAt: '2026-10-03T00:00:01.000Z',
      browserKind: 'test',
      browserExecutable: 'test',
      targetOrigin: 'https://www.douyin.com',
      targetPathname: '/chat',
      selfAccountIds: [],
      selectedConversationIds: [],
      selectedTitle: '',
      selectedConversationStable: null,
      pages: [],
      endpoint: { pageNumber: null, reached: false, confirmed: false, confirmationHasMore: null, reason: 'not-attempted' },
      resume: { requested: false, checkpointFound: false, accountMatches: null, conversationMatches: null, shortIdMatches: null, cursorMatches: null, boundaryCompared: false, boundaryRelation: 'unknown', previousRunDifferent: false, checkpointSaved: false, failure: null },
      freshTemplateCaptured: false,
      freshTemplateDecoded: false,
      freshTemplateResponseStatus: null,
      noScrollViolation: false,
      errors: []
    };
    const report = buildLiveVerificationReport(facts);
    expect(report.verdict).toBe('inconclusive');
    expect(report.formalCollection).toBe('closed');
    expect(report.p2GateOpen).toBe(false);
    expect(report.requirements.every(item => item.status !== 'pass')).toBe(true);
  });
});

